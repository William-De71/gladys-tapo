// -----------------------------------------------------------------------------
// ONVIF PTZ: pointing a motorized camera from Gladys (port 2020).
//
// Implements the `camera.move` / `camera.preset` contract of
// `docs/specs/camera-ptz-control.md`: one scalar command feature whose canonical
// values (CAMERA_MOVE) this module maps onto ONVIF operations, and a preset
// feature whose `supported_options` are read from the camera itself.
//
// Two movement modes, and the choice between them matters:
//
//   RelativeMove   — one bounded step, the DEFAULT. A movement value arriving
//                    alone (a scene action, a dashboard tap whose release was
//                    lost) is the common case, and the spec is explicit that it
//                    must not mean five seconds of rotation.
//   ContinuousMove — used only while a press is actually held, and always armed
//                    with a local watchdog (spec A.2, a MUST): a stop that never
//                    arrives must never leave the camera against its stop.
//
// Measured on Tapo firmwares (C200/C210/C225): both modes work, presets created
// in the Tapo app are returned by GetPresets, but the SPEED of a RelativeMove is
// largely ignored — the firmware derives the pace from the distance instead.
// That is why the step size, not the speed, is what this module tunes.
//
// SOAP is written out by hand here for the same reason as in `onvif.js`: the
// integration needs a handful of operations out of a standard covering hundreds.
// -----------------------------------------------------------------------------

import { logger } from '@gladysassistant/integration-sdk';
import { buildEnvelope, buildSecurityHeader, postSoap, readTag, escapeXml } from './onvif.js';
import {
  ONVIF_PORT,
  CAMERA_MOVE,
  PTZ_WATCHDOG_MS,
  PTZ_STEP,
  PTZ_SPEED,
  PTZ_REQUEST_TIMEOUT_MS,
} from './constants.js';

/**
 * The axis and direction each canonical movement travels on.
 *
 * `x` is pan, `y` is tilt, `z` is zoom — the ONVIF normalized space, where the
 * sign carries the direction. Keeping this as data means the move/step/stop
 * paths all read the same table instead of each re-deriving the signs.
 *
 * The TILT axis is inverted against the ONVIF convention, on purpose. The
 * standard points `y` positive upwards; Tapo firmwares move the camera DOWN for
 * a positive tilt, so following the spec sent the camera the wrong way on both
 * arrows (measured: "tilt down" raised the camera). The signs below are what the
 * hardware does, not what the standard says.
 */
const MOVE_VECTORS = {
  [CAMERA_MOVE.PAN_LEFT]: { x: -1, y: 0, z: 0 },
  [CAMERA_MOVE.PAN_RIGHT]: { x: 1, y: 0, z: 0 },
  [CAMERA_MOVE.TILT_UP]: { x: 0, y: -1, z: 0 },
  [CAMERA_MOVE.TILT_DOWN]: { x: 0, y: 1, z: 0 },
  [CAMERA_MOVE.ZOOM_IN]: { x: 0, y: 0, z: 1 },
  [CAMERA_MOVE.ZOOM_OUT]: { x: 0, y: 0, z: -1 },
};

/**
 * Format a number for a SOAP attribute.
 *
 * ONVIF wants a plain decimal: JavaScript renders small numbers in exponential
 * notation (`1e-7`), which firmwares reject as unparseable rather than reading
 * as zero.
 * @param {number} value - The value.
 * @returns {string} The decimal text.
 * @example
 * formatNumber(-0.05); // '-0.05'
 */
export function formatNumber(value) {
  return Number(value).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Read the PTZ-related spaces a profile's configuration declares.
 *
 * This is how the camera says what it can actually do: a pan/tilt camera with no
 * motorized zoom declares no zoom space, and asking it to zoom would be answered
 * with a fault. Absence of a space is a real answer, not a parse failure — so a
 * missing zoom space yields `false`, never a guess.
 * @param {string} xml - A `GetConfigurationOptions` or `GetProfiles` response.
 * @returns {{ panTilt: boolean, zoom: boolean, relative: boolean }} The support.
 * @example
 * parsePtzSpaces(xml); // { panTilt: true, zoom: false, relative: true }
 */
export function parsePtzSpaces(xml) {
  const text = String(xml || '');
  // Matched on the space NAME rather than on a parsed tree: firmwares nest these
  // differently, but they all spell the standard space URIs the same way.
  const has = (needle) => text.includes(needle);

  return {
    panTilt: has('ContinuousPanTiltVelocitySpace') || has('PanTiltPositionSpace'),
    zoom: has('ContinuousZoomVelocitySpace') || has('ZoomPositionSpace'),
    relative: has('TranslationSpace'),
  };
}

/**
 * Extract the presets from a `GetPresets` response.
 *
 * A preset carries a `token` (what the protocol wants back) and a `Name` (what
 * the user typed in the Tapo app). Both are kept: Gladys stores the readable
 * name as the option label and an integer as the option value, and the mapping
 * between that integer and the token is what this integration owns.
 *
 * A preset with no name is kept too — a nameless preset still points somewhere,
 * and dropping it would silently renumber the ones after it.
 * @param {string} xml - The response body.
 * @returns {Array<{ token: string, name: string }>} The presets, in camera order.
 * @example
 * parsePresets(xml); // [{ token: '1', name: 'Entrée' }]
 */
export function parsePresets(xml) {
  const presets = [];
  // One `Preset` element each, split on the opening tag so the token attribute
  // and the name element stay together whatever prefix the firmware chose.
  const chunks = String(xml || '').split(/<(?:[\w.-]+:)?Preset\b/i);

  chunks.slice(1).forEach((chunk) => {
    const tokenMatch = /\btoken="([^"]*)"/i.exec(chunk);
    if (!tokenMatch || !tokenMatch[1]) {
      return;
    }
    presets.push({ token: tokenMatch[1], name: (readTag(chunk, 'Name') || '').trim() });
  });

  return presets;
}

/**
 * PTZ client for ONE camera.
 *
 * Holds the profile token and the capabilities discovered once, plus the
 * watchdog guarding an in-flight continuous move. Nothing is shared between
 * cameras: a profile token is meaningless on another camera, and a camera that
 * stopped answering must not hold up the others.
 * @example
 * const ptz = new TapoPtz('192.168.1.20', 'gladys', 'secret');
 * await ptz.move(CAMERA_MOVE.PAN_LEFT);
 */
export class TapoPtz {
  /**
   * @param {string} ip - The camera address.
   * @param {string} username - The camera account username.
   * @param {string} password - The camera account password.
   */
  constructor(ip, username, password) {
    this.ip = ip;
    this.username = username;
    this.password = password;

    this.deviceUrl = `http://${ip}:${ONVIF_PORT}/onvif/device_service`;
    /**
     * URL of the PTZ service. Like the Events service, it is READ from the
     * capabilities rather than assumed: a C210 serves device management on
     * `/onvif/device_service` and everything else on `/onvif/service`.
     * @type {string|null}
     */
    this.serviceUrl = null;
    /** Media profile the commands apply to. @type {string|null} */
    this.profileToken = null;
    /** What the camera declares it can move. @type {object|null} */
    this.capabilities = null;
    /** Timer stopping an in-flight continuous move. @type {NodeJS.Timeout|null} */
    this.watchdog = null;
  }

  /**
   * Send one authenticated call to a service.
   * @param {string} url - The service URL.
   * @param {string} body - The SOAP body.
   * @param {number} [timeoutMs] - How long to wait.
   * @returns {Promise<string>} The response body.
   * @example
   * await ptz.call(url, '<tptz:Stop/>');
   */
  call(url, body, timeoutMs = PTZ_REQUEST_TIMEOUT_MS) {
    // A fresh security header per call: the digest carries a timestamp the
    // camera checks against its own clock, so a reused one reads as a replay.
    const envelope = buildEnvelope(body, buildSecurityHeader(this.username, this.password));
    return postSoap(url, envelope, timeoutMs);
  }

  /**
   * Discover what this camera can move, once.
   *
   * Three things have to be known before any command: WHERE the PTZ service
   * lives, WHICH media profile the commands apply to, and WHAT the camera can
   * actually do. A camera with no PTZ service answers with no address, which is
   * how a fixed camera is told apart from a motorized one.
   * @returns {Promise<object|null>} The capabilities, or null on a fixed camera.
   * @example
   * const caps = await ptz.discover();
   */
  async discover() {
    if (this.capabilities) {
      return this.capabilities;
    }

    const capabilitiesXml = await this.call(
      this.deviceUrl,
      '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>',
    );

    // The PTZ section carries its own XAddr; reading the first one of the
    // document would pick up Analytics instead.
    const section = /<(?:[\w.-]+:)?PTZ\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?PTZ>/i.exec(
      capabilitiesXml,
    );
    const address = section ? readTag(section[1], 'XAddr') : null;
    if (!address) {
      // Not an error: a fixed camera has no PTZ service, and the caller turns
      // that into "publish no movement feature".
      logger.debug(`${this.ip} declares no ONVIF PTZ service`);
      return null;
    }

    // Same reasoning as the events path: keep the path the camera chose, but
    // reach it on the address known to work — firmwares hand back hostnames the
    // LAN cannot resolve, or their own idea of their IP behind a NAT.
    const target = new URL(address);
    this.serviceUrl = `http://${this.ip}:${ONVIF_PORT}${target.pathname}${target.search}`;

    // The media profiles come from the Media service, whose address is read the
    // same way — deriving it from the device URL by string surgery would break
    // on any firmware that names its paths differently.
    const mediaSection = /<(?:[\w.-]+:)?Media\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Media>/i.exec(
      capabilitiesXml,
    );
    const mediaAddress = mediaSection ? readTag(mediaSection[1], 'XAddr') : null;
    // A camera declaring PTZ but no Media service would be nonsense; falling
    // back to the PTZ address is what the Tapo firmwares serve anyway (both
    // live on `/onvif/service`).
    const mediaUrl = mediaAddress
      ? `http://${this.ip}:${ONVIF_PORT}${new URL(mediaAddress).pathname}`
      : this.serviceUrl;

    const profilesXml = await this.call(mediaUrl, '<trt:GetProfiles/>');
    const profileMatch = /<(?:[\w.-]+:)?Profiles\b[^>]*\btoken="([^"]*)"/i.exec(profilesXml);
    if (!profileMatch) {
      throw new Error('ONVIF_NO_PROFILE');
    }
    // The first profile is the main stream, which is the one a PTZ
    // configuration is attached to on these cameras.
    this.profileToken = profileMatch[1];

    // The profile response already carries the configuration spaces, so the
    // capabilities are read from it rather than spending a second round trip.
    const spaces = parsePtzSpaces(profilesXml);
    this.capabilities = {
      panTilt: spaces.panTilt,
      zoom: spaces.zoom,
      // Continuous is what a press-and-hold needs; relative is what a lone value
      // needs. A firmware declaring neither still gets relative attempted, since
      // Tapo cameras support it whether or not they advertise the space.
      relative: spaces.relative,
    };
    logger.debug(
      `${this.ip} PTZ: pan/tilt=${this.capabilities.panTilt} zoom=${this.capabilities.zoom}`,
    );
    return this.capabilities;
  }

  /**
   * List the movements this camera supports, as canonical CAMERA_MOVE values.
   *
   * This is what becomes the `supported_options` of the `move` feature: a camera
   * without motorized zoom publishes the four pan/tilt values only, and the
   * dashboard renders exactly the buttons that work. STOP is deliberately absent
   * — the spec keeps it always supported and never listed.
   * @returns {number[]} The supported movement values.
   * @example
   * ptz.supportedMovements(); // [1, 2, 3, 4]
   */
  supportedMovements() {
    if (!this.capabilities) {
      return [];
    }
    const movements = [];
    if (this.capabilities.panTilt) {
      movements.push(
        CAMERA_MOVE.PAN_LEFT,
        CAMERA_MOVE.PAN_RIGHT,
        CAMERA_MOVE.TILT_UP,
        CAMERA_MOVE.TILT_DOWN,
      );
    }
    if (this.capabilities.zoom) {
      movements.push(CAMERA_MOVE.ZOOM_IN, CAMERA_MOVE.ZOOM_OUT);
    }
    return movements;
  }

  /**
   * Read the presets saved on the camera.
   *
   * These are the positions the user created in the Tapo app — Gladys never
   * creates them (a v1 non-goal of the spec). Returned in camera order, which is
   * what the option `sort_order` follows.
   * @returns {Promise<Array<{ token: string, name: string }>>} The presets.
   * @example
   * await ptz.getPresets();
   */
  async getPresets() {
    if (!this.serviceUrl) {
      await this.discover();
    }
    if (!this.serviceUrl) {
      return [];
    }

    const xml = await this.call(
      this.serviceUrl,
      `<tptz:GetPresets><tptz:ProfileToken>${escapeXml(this.profileToken)}</tptz:ProfileToken></tptz:GetPresets>`,
    );
    return parsePresets(xml);
  }

  /**
   * Recall a preset by its protocol token.
   * @param {string} token - The preset token, as returned by `getPresets`.
   * @returns {Promise<void>} Resolves once the camera accepted the command.
   * @example
   * await ptz.gotoPreset('1');
   */
  async gotoPreset(token) {
    if (!this.serviceUrl) {
      await this.discover();
    }
    if (!this.serviceUrl) {
      throw new Error('ONVIF_NO_PTZ');
    }

    // A preset move is absolute and bounded by construction: the camera travels
    // to a known position and stops there, so no watchdog is involved.
    await this.call(
      this.serviceUrl,
      `<tptz:GotoPreset>` +
        `<tptz:ProfileToken>${escapeXml(this.profileToken)}</tptz:ProfileToken>` +
        `<tptz:PresetToken>${escapeXml(token)}</tptz:PresetToken>` +
        `</tptz:GotoPreset>`,
    );
  }

  /**
   * Move one bounded step in a direction.
   *
   * The default path, and the one that makes a lone command safe: the camera
   * travels a fixed distance and stops on its own, so nothing has to arrive
   * afterwards for the movement to end.
   * @param {number} movement - A CAMERA_MOVE value (1..6).
   * @returns {Promise<void>} Resolves once the camera accepted the command.
   * @example
   * await ptz.step(CAMERA_MOVE.PAN_LEFT);
   */
  async step(movement) {
    const vector = MOVE_VECTORS[movement];
    if (!vector) {
      throw new Error(`PTZ_UNKNOWN_MOVEMENT_${movement}`);
    }
    if (!this.serviceUrl) {
      await this.discover();
    }
    if (!this.serviceUrl) {
      throw new Error('ONVIF_NO_PTZ');
    }

    // Pan/tilt and zoom are separate elements in the translation, and sending an
    // axis the camera does not have is answered with a fault — so only the axis
    // actually being moved is written out.
    const translation =
      vector.z === 0
        ? `<tt:PanTilt x="${formatNumber(vector.x * PTZ_STEP)}" y="${formatNumber(vector.y * PTZ_STEP)}"/>`
        : `<tt:Zoom x="${formatNumber(vector.z * PTZ_STEP)}"/>`;
    const speed =
      vector.z === 0
        ? `<tt:PanTilt x="${formatNumber(PTZ_SPEED)}" y="${formatNumber(PTZ_SPEED)}"/>`
        : `<tt:Zoom x="${formatNumber(PTZ_SPEED)}"/>`;

    await this.call(
      this.serviceUrl,
      `<tptz:RelativeMove>` +
        `<tptz:ProfileToken>${escapeXml(this.profileToken)}</tptz:ProfileToken>` +
        `<tptz:Translation>${translation}</tptz:Translation>` +
        `<tptz:Speed>${speed}</tptz:Speed>` +
        `</tptz:RelativeMove>`,
    );
  }

  /**
   * Start moving continuously in a direction, bounded by the watchdog.
   *
   * Used while a press is held. The watchdog is armed BEFORE the call returns so
   * that a response lost on the way back still leaves the camera guarded — the
   * failure mode this exists for is precisely the one where nothing comes back.
   * @param {number} movement - A CAMERA_MOVE value (1..6).
   * @returns {Promise<void>} Resolves once the camera accepted the command.
   * @example
   * await ptz.startContinuous(CAMERA_MOVE.PAN_LEFT);
   */
  async startContinuous(movement) {
    const vector = MOVE_VECTORS[movement];
    if (!vector) {
      throw new Error(`PTZ_UNKNOWN_MOVEMENT_${movement}`);
    }
    if (!this.serviceUrl) {
      await this.discover();
    }
    if (!this.serviceUrl) {
      throw new Error('ONVIF_NO_PTZ');
    }

    const velocity =
      vector.z === 0
        ? `<tt:PanTilt x="${formatNumber(vector.x * PTZ_SPEED)}" y="${formatNumber(vector.y * PTZ_SPEED)}"/>`
        : `<tt:Zoom x="${formatNumber(vector.z * PTZ_SPEED)}"/>`;

    // Armed first, on purpose: if the request below throws after the camera
    // actually started moving, the timer is what stops it.
    this.armWatchdog();

    try {
      await this.call(
        this.serviceUrl,
        `<tptz:ContinuousMove>` +
          `<tptz:ProfileToken>${escapeXml(this.profileToken)}</tptz:ProfileToken>` +
          `<tptz:Velocity>${velocity}</tptz:Velocity>` +
          `</tptz:ContinuousMove>`,
      );
    } catch (e) {
      // The camera refused the move, so there is nothing to guard — but a stop
      // is still sent, because "refused" and "started then failed to answer"
      // are indistinguishable from here.
      this.clearWatchdog();
      await this.stop().catch(() => {});
      throw e;
    }
  }

  /**
   * Stop every ongoing movement.
   *
   * Stops pan, tilt AND zoom in one call: the spec defines STOP as halting
   * everything, and a camera that was zooming while panning must not keep one
   * axis running.
   * @returns {Promise<void>} Resolves once the camera accepted the command.
   * @example
   * await ptz.stop();
   */
  async stop() {
    this.clearWatchdog();

    if (!this.serviceUrl) {
      // Nothing was ever started through this client, so there is nothing to
      // stop — and discovering a service just to stop an idle camera would turn
      // a harmless stop into a network round trip.
      return;
    }

    await this.call(
      this.serviceUrl,
      `<tptz:Stop>` +
        `<tptz:ProfileToken>${escapeXml(this.profileToken)}</tptz:ProfileToken>` +
        `<tptz:PanTilt>true</tptz:PanTilt>` +
        `<tptz:Zoom>true</tptz:Zoom>` +
        `</tptz:Stop>`,
    );
  }

  /**
   * Arm the watchdog that bounds a continuous move.
   *
   * The spec's safety rule (A.2, a MUST): a lost stop must never leave the
   * camera rotating. Re-arming replaces any previous timer, so holding a press
   * through several commands does not stack timers.
   * @example
   * ptz.armWatchdog();
   */
  armWatchdog() {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      logger.debug(`PTZ watchdog stopping ${this.ip} after ${PTZ_WATCHDOG_MS / 1000}s`);
      // Best effort by construction: this fires precisely when the normal stop
      // path did not, so there is nobody left to report a failure to.
      this.stop().catch((e) =>
        logger.debug(`PTZ watchdog stop of ${this.ip} failed: ${e.message}`),
      );
    }, PTZ_WATCHDOG_MS);
    // The timer must not hold the process open: a camera left mid-move at
    // shutdown is stopped by the camera's own firmware timeout anyway.
    if (typeof this.watchdog.unref === 'function') {
      this.watchdog.unref();
    }
  }

  /**
   * Disarm the watchdog.
   * @example
   * ptz.clearWatchdog();
   */
  clearWatchdog() {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }
}
