// -----------------------------------------------------------------------------
// Device orchestration: turning cloud cameras into Gladys devices.
//
// One camera becomes one device carrying up to four features:
//   camera/image        the snapshot shown by the dashboard widget;
//   button/push         the doorbell press, to trigger scenes;
//   motion-sensor/binary  motion detection;
//   battery/integer     the battery level, on battery models only.
//
// A device keeps everything needed to capture it in its params (IP, model,
// capture mode), so a poll or a `onGetImage` never needs the cloud again.
// -----------------------------------------------------------------------------

import {
  logger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import {
  detectCaptureMode,
  isBatteryModel,
  hasNoLocalAccess,
  buildRtspUrl,
  hasOnvif,
} from './tapo/rtsp.js';
import { hasRtspAccount, resolveRtspAccount } from './config.js';
import { discoverLocalAddresses } from './tapo/discovery.js';
import { TapoLocalApi } from './tapo/localApi.js';
import {
  EXTERNAL_ID_TYPE,
  DEVICE_PARAMS,
  CAPTURE_MODES,
  FEATURE_SUFFIXES,
  POLL_FREQUENCY_MS,
  CAMERA_MOVE,
} from './tapo/constants.js';
import { TapoPtz } from './tapo/ptz.js';
import { TapoOnvif } from './tapo/onvif.js';

/**
 * Default labels of the canonical movements.
 *
 * The dashboard renders arrows, not text, so these only surface where a label is
 * all there is: the scene editor and the device settings page. English on
 * purpose — Gladys translates its own canonical labels, and an integration
 * publishing French ones would pin them for every user.
 */
const MOVEMENT_LABELS = {
  [CAMERA_MOVE.PAN_LEFT]: 'Pan left',
  [CAMERA_MOVE.PAN_RIGHT]: 'Pan right',
  [CAMERA_MOVE.TILT_UP]: 'Tilt up',
  [CAMERA_MOVE.TILT_DOWN]: 'Tilt down',
  [CAMERA_MOVE.ZOOM_IN]: 'Zoom in',
  [CAMERA_MOVE.ZOOM_OUT]: 'Zoom out',
};

/**
 * Build the external ids of one camera through the SDK. Gladys namespaces every
 * external id as `ext:<selector>:<type>:<platformId>` and rejects anything else,
 * so these ids must never be assembled by hand.
 *
 * The cloud device id plays the `platformId` part: it is the only identifier that
 * survives a rename or an IP change.
 * @param {object} gladys - The SDK instance.
 * @param {string} cloudDeviceId - The cloud device id.
 * @returns {object} The device id and the feature id factory.
 * @example
 * const ids = cameraIds(gladys, '80224A...');
 * ids.device; // 'ext:ext-dev-tapo:camera:80224A...'
 */
export function cameraIds(gladys, cloudDeviceId) {
  return gladys.externalIds(EXTERNAL_ID_TYPE, cloudDeviceId);
}

/**
 * Extract the cloud device id from a device or feature external id.
 * @param {string} externalId - The external id.
 * @returns {string|null} The cloud device id, or null when unparseable.
 * @example
 * parseCloudDeviceId('ext:ext-dev-tapo:camera:80224A...:image'); // '80224A...'
 */
export function parseCloudDeviceId(externalId) {
  // `ext:<selector>:<type>:<platformId>[:<feature>]` — the platform id is the
  // fourth segment, whether the id points at the device or at one of its features.
  const parts = String(externalId || '').split(':');
  if (parts[0] !== 'ext' || parts[2] !== EXTERNAL_ID_TYPE || !parts[3]) {
    return null;
  }
  return parts[3];
}

/**
 * Read a device param by name.
 * @param {object} device - The Gladys device.
 * @param {string} name - The param name.
 * @returns {string|null} The value, or null when absent.
 * @example
 * getParam(device, 'TAPO_IP');
 */
export function getParam(device, name) {
  const param = (device.params || []).find((entry) => entry.name === name);
  return param ? String(param.value) : null;
}

/**
 * Cameras known to support the privacy mode, by cloud device id.
 *
 * A capability does not come and go: once a camera has answered that it has a
 * lens mask, a later scan that cannot reach it says nothing to the contrary. The
 * memory is what keeps a transient failure — a lockout, a sleeping camera — from
 * REMOVING a switch the user has already built scenes on.
 *
 * Kept for the life of the process on purpose: it only ever adds a feature back,
 * and the poll re-reads the real state anyway, so a camera that genuinely lost
 * the capability (a firmware downgrade) publishes a switch that reports nothing
 * rather than silently disappearing.
 * @type {Set<string>}
 */
const knownPrivacyCameras = new Set();

/**
 * Build the features of a camera. The doorbell and motion features only exist on
 * battery models, whose events the cloud reports; a wired camera would carry a
 * feature that never updates.
 * @param {object} gladys - The SDK instance, which namespaces the ids.
 * @param {object} camera - The resolved camera.
 * @returns {object[]} The features.
 * @example
 * buildFeatures(gladys, camera);
 */
export function buildFeatures(gladys, camera) {
  const ids = cameraIds(gladys, camera.cloudDeviceId);
  const features = [
    {
      name: camera.name,
      external_id: ids.feature(FEATURE_SUFFIXES.IMAGE),
      category: DEVICE_FEATURE_CATEGORIES.CAMERA,
      type: DEVICE_FEATURE_TYPES.CAMERA.IMAGE,
      read_only: false,
      keep_history: false,
      has_feedback: false,
      min: 0,
      max: 0,
    },
  ];

  // The doorbell is skipped only when the camera EXPLICITLY said it has no
  // visitor topic. `hasDoorbell` is null when it could not be asked — an older
  // firmware, a refused call, a battery model reporting through the cloud — and
  // the feature is then created as before: an unused row is cosmetic, whereas a
  // missing one silently breaks the scenes a real doorbell was wired into.
  if (camera.hasEvents && camera.hasDoorbell !== false) {
    features.push({
      name: `${camera.name} - Doorbell`,
      external_id: ids.feature(FEATURE_SUFFIXES.BUTTON),
      category: DEVICE_FEATURE_CATEGORIES.BUTTON,
      type: DEVICE_FEATURE_TYPES.BUTTON.PUSH,
      read_only: true,
      keep_history: true,
      has_feedback: false,
      min: 0,
      max: 1,
    });
  }

  if (camera.hasEvents) {
    features.push({
      external_id: ids.feature(FEATURE_SUFFIXES.MOTION),
      category: DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR,
      type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
      read_only: true,
      keep_history: true,
      has_feedback: false,
      min: 0,
      max: 1,
    });
  }

  // Created unless the camera EXPLICITLY answered that it has no lens mask.
  // `hasPrivacyMode` is null when the question could not be asked — no local
  // address, camera asleep, locked out, firmware without the method — and a
  // switch that is missing is worse than one that is briefly unresponsive: the
  // scenes built on it would break silently.
  //
  // Which is why an unanswered probe falls back to what the camera answered
  // BEFORE (`knownPrivacyCameras`). The comment above always claimed this, but
  // the condition alone did the opposite: a camera serving a lockout answered
  // null and lost a switch it had been publishing for weeks, and it only came
  // back once the container was restarted into a scan that happened to succeed.
  const answeredPrivacy = camera.hasPrivacyMode !== null && camera.hasPrivacyMode !== undefined;
  if (answeredPrivacy) {
    knownPrivacyCameras.add(camera.cloudDeviceId);
  }
  if (answeredPrivacy || knownPrivacyCameras.has(camera.cloudDeviceId)) {
    features.push({
      name: `${camera.name} - Privacy mode`,
      external_id: ids.feature(FEATURE_SUFFIXES.PRIVACY),
      category: DEVICE_FEATURE_CATEGORIES.SWITCH,
      type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
      read_only: false,
      keep_history: true,
      // The only feature here whose state is genuinely readable back from the
      // camera: the poll re-reads it, so a toggle made in the Tapo app shows up
      // in Gladys instead of leaving the switch lying.
      has_feedback: true,
      min: 0,
      max: 1,
    });
  }

  // PTZ: only what the camera actually declared when probed. A pan/tilt camera
  // without motorized zoom publishes four movements, so the dashboard renders
  // exactly the buttons that work — the capability lives in the options, not in
  // the existence of the feature (spec A.2).
  if (camera.ptzMovements && camera.ptzMovements.length > 0) {
    features.push({
      name: `${camera.name} - Move`,
      external_id: ids.feature(FEATURE_SUFFIXES.MOVE),
      category: DEVICE_FEATURE_CATEGORIES.CAMERA,
      type: DEVICE_FEATURE_TYPES.CAMERA.MOVE,
      read_only: false,
      // A movement is a command, not a measurement: keeping it would fill the
      // history with values that describe nothing about the camera's state.
      keep_history: false,
      has_feedback: false,
      min: CAMERA_MOVE.STOP,
      max: CAMERA_MOVE.ZOOM_OUT,
      // STOP is never listed: the spec keeps it always supported.
      supported_options: camera.ptzMovements.map((value, index) => ({
        value,
        label: MOVEMENT_LABELS[value],
        sort_order: index,
      })),
    });
  }

  // Presets are the user's own positions, created in the Tapo app. A camera with
  // none publishes no feature rather than an empty select.
  if (camera.ptzPresets && camera.ptzPresets.length > 0) {
    features.push({
      name: `${camera.name} - Preset`,
      external_id: ids.feature(FEATURE_SUFFIXES.PRESET),
      category: DEVICE_FEATURE_CATEGORIES.CAMERA,
      type: DEVICE_FEATURE_TYPES.CAMERA.PRESET,
      read_only: false,
      keep_history: false,
      has_feedback: false,
      min: 0,
      // The spec ties max to the highest option value, which the mapping below
      // keeps equal to the last index.
      max: Math.max(0, camera.ptzPresets.length - 1),
      // The option VALUE is the index, not the protocol token: tokens are free
      // text on the camera side ("1", "Preset001"…) and Gladys options carry
      // integers. The token itself is stored in the device params, which is what
      // maps a recalled option back to the camera's own identifier.
      supported_options: camera.ptzPresets.map((preset, index) => ({
        value: index,
        label: preset.name || `Preset ${index + 1}`,
        sort_order: index,
      })),
    });
  }

  if (camera.hasBattery) {
    features.push({
      name: `${camera.name} - Battery`,
      external_id: ids.feature(FEATURE_SUFFIXES.BATTERY),
      category: DEVICE_FEATURE_CATEGORIES.BATTERY,
      type: DEVICE_FEATURE_TYPES.BATTERY.INTEGER,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      read_only: true,
      keep_history: true,
      has_feedback: false,
      min: 0,
      max: 100,
    });
  }

  return features;
}

/**
 * Ask a camera what it can move, and which positions it has saved.
 *
 * Both answers come from the camera itself rather than from a model table: TP-Link
 * ships pan/tilt and fixed cameras under neighbouring references, and the user
 * may have created presets in the Tapo app at any time. A camera that cannot be
 * asked — no camera account configured, no ONVIF — yields empty capabilities,
 * which is how a fixed camera and an unreachable one both end up publishing no
 * PTZ feature.
 * @param {object} camera - The resolved camera.
 * @param {object} config - The normalized configuration.
 * @returns {Promise<{ movements: number[], presets: Array<object> }>} What it supports.
 * @example
 * const { movements, presets } = await probePtz(camera, config);
 */
export async function probePtz(camera, config) {
  const empty = { movements: [], presets: [] };
  const account = resolveRtspAccount(config, camera.name);
  if (!camera.ip || !camera.hasOnvif || !account.username || !account.password) {
    return empty;
  }

  const ptz = new TapoPtz(camera.ip, account.username, account.password);
  try {
    const capabilities = await ptz.discover();
    if (!capabilities) {
      // A fixed camera: it answers ONVIF, it just has no motors.
      return empty;
    }

    const movements = ptz.supportedMovements();
    // Presets are worth asking for even on a camera whose motors are unclear —
    // but a failure here must not cost the movements, which are the main
    // capability. A camera with no preset simply returns an empty list.
    const presets = await ptz.getPresets().catch((e) => {
      logger.debug(`Reading the presets of "${camera.name}" failed: ${e.message}`);
      return [];
    });

    if (movements.length > 0) {
      logger.info(
        `"${camera.name}" supports PTZ (${movements.length} movements, ${presets.length} presets)`,
      );
    }
    return { movements, presets };
  } catch (e) {
    // Almost always a wrong camera account: ONVIF answered the port probe but
    // rejects the credentials. Not fatal — the camera keeps its image feature.
    logger.debug(`PTZ probe of "${camera.name}" failed: ${e.message}`);
    return empty;
  }
}

/**
 * Ask a camera whether it can ever report a doorbell press.
 *
 * Same principle as the PTZ probe: the camera is asked rather than deduced from
 * its model. TP-Link ships doorbells and plain cameras under neighbouring
 * references, and a model table would drop the button of the first doorbell it
 * does not know about — breaking the scenes built on it.
 * @param {object} camera - The resolved camera.
 * @param {object} config - The normalized configuration.
 * @returns {Promise<boolean|null>} True/false when known, null when unasked.
 * @example
 * const hasButton = await probeDoorbell(camera, config);
 */
export async function probeDoorbell(camera, config) {
  const account = resolveRtspAccount(config, camera.name);
  if (!camera.ip || !camera.hasOnvif || !account.username || !account.password) {
    // Nothing was asked, so nothing is known — notably the battery models, whose
    // events travel through the cloud and never through ONVIF.
    return null;
  }

  const client = new TapoOnvif(camera.ip, account.username, account.password);
  const hasDoorbell = await client.hasDoorbell();
  if (hasDoorbell === false) {
    logger.info(`"${camera.name}" declares no doorbell topic: no button feature created`);
  }
  return hasDoorbell;
}

/**
 * Build the Gladys device of one camera.
 * @param {object} gladys - The SDK instance, which namespaces the ids.
 * @param {object} camera - The resolved camera.
 * @returns {object} The device, ready to be published.
 * @example
 * buildDevice(gladys, camera);
 */
export function buildDevice(gladys, camera) {
  return {
    name: camera.name,
    external_id: cameraIds(gladys, camera.cloudDeviceId).device,
    model: camera.model || null,
    // The dashboard widget shows the last PUBLISHED image, never a fresh one, so
    // the poll is what keeps it up to date (see `onPoll`). Without this, the
    // widget would stay empty until a doorbell press.
    should_poll: true,
    poll_frequency: POLL_FREQUENCY_MS,
    features: buildFeatures(gladys, camera),
    params: [
      { name: DEVICE_PARAMS.CLOUD_DEVICE_ID, value: camera.cloudDeviceId },
      { name: DEVICE_PARAMS.IP, value: camera.ip || '' },
      { name: DEVICE_PARAMS.MODEL, value: camera.model || '' },
      { name: DEVICE_PARAMS.CAPTURE_MODE, value: camera.captureMode || '' },
      // The live view of the dashboard widget calls the rtsp-camera service,
      // which streams ANY device carrying a CAMERA_URL param — whatever service
      // owns it. Publishing the RTSP URL here is therefore what unlocks the live
      // video for an external integration.
      { name: DEVICE_PARAMS.CAMERA_URL, value: camera.streamUrl || '' },
      { name: DEVICE_PARAMS.CAMERA_ROTATION, value: '0' },
      // The bridge between the two identifier spaces: Gladys options carry the
      // integer index, ONVIF wants the camera's own token. Stored on the device
      // so that recalling a preset needs no round trip to rediscover the list.
      {
        name: DEVICE_PARAMS.PRESET_TOKENS,
        value: (camera.ptzPresets || []).map((preset) => preset.token).join(','),
      },
    ],
  };
}

/**
 * Cameras that refused a local session, by IP, with the time the probe may run
 * again.
 *
 * Tapo firmwares lock an address out after a few failed logins, and the penalty
 * grows with each attempt (measured on a C210: minutes, then half an hour).
 * Retrying is therefore not merely useless — it is what keeps the camera locked,
 * and the lockout blocks the local paths that do work.
 *
 * The pause EXPIRES rather than lasting for the life of the process. A refusal
 * used to be remembered for good, so a camera that was merely serving a
 * five-minute lockout lost its privacy switch until the container was restarted
 * — the guard written to avoid escalating a lockout was making its effects
 * permanent instead. Backing off and coming back later protects the camera just
 * as well, and the switch reappears on its own.
 * @type {Map<string, number>}
 */
const authRefused = new Map();

/**
 * How long the probe stays away after a refusal, by kind.
 *
 * A camera that is LOCKED OUT has said nothing about the credentials — only
 * that it wants quiet — so it is retried after the longest penalty measured
 * here (half an hour) has had time to lapse. A password the camera actually
 * rejected is a user-side problem the retry cannot fix, so that one waits much
 * longer: it only ever costs a missing switch, never a lockout.
 */
const AUTH_RETRY_DELAY_MS = {
  LOCKED: 35 * 60 * 1000,
  REFUSED: 6 * 60 * 60 * 1000,
};

/**
 * Forget the rejected credentials, so a corrected account is tried again.
 *
 * Called when the configuration changes: the user's fix must take effect at the
 * next scan rather than requiring a restart.
 * @example
 * forgetRefusedCredentials();
 */
export function forgetRefusedCredentials() {
  authRefused.clear();
}

/**
 * Ask a camera whether it supports the privacy mode, and what its current state
 * is.
 *
 * Asked rather than deduced from the model, for the reason this project already
 * recorded in `NO_LOCAL_ACCESS_MODELS`: a capability guessed from a model string
 * is a capability guessed wrong.
 *
 * Authenticated with the TP-Link account password (username "admin"), one
 * attempt per scan. Measured: a C500 opens its local API with it; some cameras
 * refuse it and simply get no switch. A refusal is remembered and never retried
 * (see `authRefused`) — the single most important guard here, because retrying
 * is what walks a camera into an escalating lockout.
 * @param {object} camera - The resolved camera.
 * @param {object} config - The normalized configuration.
 * @returns {Promise<boolean|null>} The current state, or null when the camera
 * does not support it or could not be asked.
 * @example
 * const isPrivate = await probePrivacyMode(camera, config);
 */
export async function probePrivacyMode(camera, config) {
  if (!camera.ip) {
    return null;
  }

  const retryAt = authRefused.get(camera.ip);
  if (retryAt !== undefined && Date.now() < retryAt) {
    // Deliberately silent about the credentials themselves: the user already got
    // one explicit message, and repeating it every scan would be noise.
    logger.debug(`Skipping the privacy probe of "${camera.name}": backing off until ${retryAt}`);
    return null;
  }

  // The TP-Link account password, with "admin" as the username. Measured: a C500
  // opens its local API with it. Some cameras (a C210 here) refuse it and expose
  // no privacy switch — see the catch below; preferring their camera account was
  // tried and takes the switch away from the cameras the password suits, so it
  // is deliberately not attempted.
  if (!config.password) {
    return null;
  }
  const credentials = { username: 'admin', password: config.password };

  // A short-lived session of its own: the watcher's cache is keyed by IP and
  // owned by the event loop, and borrowing from it here — during a scan, before
  // any device exists — would race with it. Closed below so the camera frees the
  // slot right away rather than in a few minutes; the firmware only keeps a few.
  const api = new TapoLocalApi(camera.ip, credentials.password, credentials.username);
  try {
    const state = await api.getPrivacyMode();
    api.close();
    if (state === null) {
      // The call went through and the camera answered with a shape carrying no
      // lens mask — an older firmware without the feature.
      logger.info(`"${camera.name}" reports no privacy mode: no switch created`);
    }
    return state;
  } catch (e) {
    api.close();

    // The refusal is remembered so the probe backs off. This is the point that
    // matters most: Tapo cameras lock an address out after a few failed logins,
    // and retrying every scan is what turns a one-off refusal into a camera
    // locked out for good.
    //
    // WHICH refusal it is decides how long to wait, and the three cases used to
    // be conflated into one permanent ban:
    //   - unreachable: the camera said nothing at all about its credentials, and
    //     one that was merely asleep must be probed again — no pause;
    //   - locked out (-40214): the camera is asking for quiet, not reporting a
    //     wrong password. Waiting out the penalty is exactly what it wants;
    //   - anything else: treated as a credentials problem, and paused for long
    //     enough that retrying can never feed a lockout.
    const unreachable = e.message.includes('TIMEOUT') || e.message.includes('ECONN');
    // Raised by the camera AFTER a session was opened, so it says nothing about
    // the credentials that opened it — a dropped session, not a refusal.
    const sessionDropped = e.message.includes('NO_RESPONSE');
    const lockedOut = e.message.includes('-40214');
    if (!unreachable) {
      const delay =
        lockedOut || sessionDropped ? AUTH_RETRY_DELAY_MS.LOCKED : AUTH_RETRY_DELAY_MS.REFUSED;
      authRefused.set(camera.ip, Date.now() + delay);
    }

    // Logged at INFO/WARN, not debug: this decides whether a camera gets a
    // switch, and hiding it left a control that simply never appeared, with no
    // reason anywhere.
    if (lockedOut) {
      logger.info(
        `"${camera.name}" is temporarily locked out (too many logins): no privacy switch for now, ` +
          `retrying in ${Math.round(AUTH_RETRY_DELAY_MS.LOCKED / 60000)} min.`,
      );
    } else if (e.message.includes('BAD_PASSWORD')) {
      logger.warn(
        `"${camera.name}" rejected the Tapo password on its local API: no privacy switch. ` +
          `This camera does not open its local API to Gladys; its other features are unaffected.`,
      );
    } else {
      logger.info(
        `"${camera.name}" refused the local session (${e.message}): no privacy switch created`,
      );
    }
    // Never `false`: "the camera refused the call" and "the camera has no lens
    // mask" must not lead to the same conclusion, since one of them would
    // silently drop the switch of a camera that has one.
    return null;
  }
}

/**
 * Resolve a cloud camera into everything needed to talk to it: its capabilities,
 * and the capture mode its open ports reveal.
 * @param {object} cloudCamera - The camera as returned by the cloud.
 * @param {object} config - The normalized configuration.
 * @returns {Promise<object>} The resolved camera.
 * @example
 * const camera = await resolveCamera(cloudCamera, config);
 */
export async function resolveCamera(cloudCamera, config) {
  const battery = isBatteryModel(cloudCamera.model);
  const camera = {
    ...cloudCamera,
    hasBattery: battery,
    // Battery models report their doorbell/motion through the local detection
    // list. Wired cameras have no such list — their events come from ONVIF,
    // which the probe below decides on.
    hasEvents: battery,
    hasOnvif: false,
    noLocalAccess: hasNoLocalAccess(cloudCamera.model),
    captureMode: null,
  };

  if (camera.noLocalAccess) {
    // Probing is pointless: TP-Link blocks every local path on these models.
    logger.warn(
      `"${camera.name}" (${camera.model}) blocks third-party local access: no image can be captured from it.`,
    );
    return camera;
  }

  if (!camera.ip) {
    // Nothing to probe: the cloud reported no address and none was configured.
    logger.warn(
      `"${camera.name}" (${camera.model}) has no known local address. Add it under "Camera addresses" as "${camera.name}|192.168.x.y".`,
    );
    return camera;
  }

  // Independent round trips on the same camera, so they run together rather than
  // one after the other. The privacy probe joins them because it depends on
  // neither: it speaks the local API, not ONVIF, so a battery camera without any
  // ONVIF at all still gets its switch.
  const [captureMode, onvif, privacyMode] = await Promise.all([
    detectCaptureMode(camera, config),
    hasOnvif(camera),
    probePrivacyMode(camera, config),
  ]);
  camera.captureMode = captureMode;
  camera.hasOnvif = onvif;
  camera.hasPrivacyMode = privacyMode;

  // A camera serving ONVIF can report motion, whether or not it runs on battery
  // — which is what gives a wired camera a motion sensor it never had. The
  // feature is created on the open port alone: the camera account may well be
  // filled in later, and a feature that only appeared then would leave the
  // scenes written in the meantime pointing at nothing.
  if (onvif) {
    camera.hasEvents = true;
  }

  // Asked only once the ONVIF port is known to answer, and only with credentials
  // in hand: both services sit behind the same camera account as the events.
  // Independent round trips on the same camera, so they run together.
  const [ptz, hasDoorbell] = await Promise.all([
    probePtz(camera, config),
    probeDoorbell(camera, config),
  ]);
  camera.ptzMovements = ptz.movements;
  camera.ptzPresets = ptz.presets;
  camera.hasDoorbell = hasDoorbell;

  // Only an RTSP camera can feed the live view: the rtsp-camera service hands the
  // URL straight to ffmpeg, so the proprietary protocol — which needs an
  // encrypted session this integration owns — cannot be expressed as a URL.
  if (camera.captureMode === CAPTURE_MODES.RTSP && hasRtspAccount(config, camera.name)) {
    camera.streamUrl = buildRtspUrl(camera, config);
  }

  if (camera.captureMode) {
    logger.info(`"${camera.name}" (${camera.ip}) will be captured over ${camera.captureMode}`);
  } else {
    logger.warn(
      `"${camera.name}" (${camera.ip}) answers on neither port 554 nor 8800. Check that Gladys can reach it on your network.`,
    );
  }
  return camera;
}

/**
 * Resolve every cloud camera and build the devices to publish.
 * @param {object} gladys - The SDK instance, which namespaces the ids.
 * @param {object[]} cloudCameras - The cameras returned by the cloud.
 * @param {object} config - The normalized configuration.
 * @returns {Promise<object[]>} The devices.
 * @example
 * const devices = await buildDiscoveredDevices(gladys, cameras, config);
 */
export async function buildDiscoveredDevices(gladys, cloudCameras, config) {
  // The cloud knows WHICH cameras exist but not WHERE they are, so the local
  // addresses come from a network scan. A manual address stays authoritative:
  // the user typed it precisely because automatic detection did not suit.
  const discovered = await discoverLocalAddresses(gladys);
  const located = cloudCameras.map((cloudCamera) => ({
    ...cloudCamera,
    ip: cloudCamera.ip || discovered.get(String(cloudCamera.cloudDeviceId).toUpperCase()) || '',
  }));

  // Probing is I/O bound and independent per camera, so resolve them together.
  const cameras = await Promise.all(located.map((camera) => resolveCamera(camera, config)));
  return cameras.map((camera) => buildDevice(gladys, camera));
}

/**
 * Rebuild a resolved camera from a device Gladys created, so a capture needs no
 * cloud call. The capture mode is re-probed when the params carry none (a camera
 * added before its ports answered, or a mode that changed since).
 * @param {object} device - The Gladys device.
 * @param {object} config - The normalized configuration.
 * @returns {Promise<object>} The resolved camera. `unreachable` is set when a
 * probe ran and found no open port, telling the caller not to try a capture.
 * @example
 * const camera = await cameraFromDevice(device, config);
 */
export async function cameraFromDevice(device, config) {
  const cloudDeviceId =
    getParam(device, DEVICE_PARAMS.CLOUD_DEVICE_ID) || parseCloudDeviceId(device.external_id);
  const camera = {
    cloudDeviceId,
    name: device.name || 'Tapo Camera',
    model: getParam(device, DEVICE_PARAMS.MODEL) || '',
    ip: getParam(device, DEVICE_PARAMS.IP) || '',
    captureMode: getParam(device, DEVICE_PARAMS.CAPTURE_MODE) || null,
  };

  // The user may have typed the address by hand after creating the device. The
  // device can also have been renamed in Gladys since, so the cloud device id is
  // accepted as a key too — the only name that never changes.
  if (!camera.ip) {
    camera.ip =
      config.camera_ips[camera.name.toLowerCase()] ||
      config.camera_ips[String(cloudDeviceId).toLowerCase()] ||
      '';
  }

  if (!camera.captureMode && camera.ip) {
    camera.captureMode = await detectCaptureMode(camera, config);
    // The probe just found neither port open. Falling back to a mode here would
    // mean opening a connection the camera has already refused — which is what
    // used to happen: an unplugged camera was retried on the proprietary
    // protocol every cycle, each attempt running until its timeout. Remember the
    // refusal so the caller can report it instead of hammering the camera.
    if (!camera.captureMode) {
      camera.unreachable = true;
      return camera;
    }
  }
  // Without a known mode, the proprietary protocol is the safer guess: it is the
  // one that works without a camera account. This covers the camera that was
  // never probed, not the one that failed its probe just above.
  if (!camera.captureMode) {
    camera.captureMode = CAPTURE_MODES.PROPRIETARY;
  }
  return camera;
}
