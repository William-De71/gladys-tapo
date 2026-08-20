// -----------------------------------------------------------------------------
// Doorbell, motion and battery events.
//
// Tapo cameras have no local event push, so the events are polled from the cloud
// and turned into feature states. The rules that matter:
//
//   - only NEW events count. The cloud returns a window of recent events, so a
//     timestamp watermark per camera avoids replaying the same ring at every tick;
//   - a first tick never fires anything. Starting the integration must not
//     trigger the scenes of a doorbell press that happened an hour ago;
//   - a binary motion feature has to come back down, otherwise it stays "motion
//     detected" forever — the cloud only reports the rising edge.
// -----------------------------------------------------------------------------

import { logger, DEVICE_FEATURE_CATEGORIES } from '@gladysassistant/integration-sdk';
import { parseCloudDeviceId, cameraIds, getParam } from '../devices.js';
import {
  DEVICE_PARAMS,
  FEATURE_SUFFIXES,
  LOCAL_EVENT_WINDOW_SECONDS,
  ONVIF_MOTION_TIMEOUT_MS,
  ONVIF_MOTION_FALL_DELAY_MS,
} from './constants.js';
import { TapoLocalApi } from './localApi.js';
import { TapoOnvif } from './onvif.js';
import { resolveRtspAccount } from '../config.js';

/** How long a motion stays reported before being reset to 0. */
const MOTION_RESET_MS = 60 * 1000;

/** `alarm_type` values the local API reports. */
const ALARM_TYPES = {
  MOTION: 2,
  DOORBELL: 3,
};

/** Textual event types, used by firmwares that label their events. */
const EVENT_TYPES = {
  DOORBELL: ['ring', 'doorbell', 'button', 'call'],
  MOTION: ['motion', 'person', 'people', 'pet', 'vehicle', 'detection'],
};

/**
 * Classify a raw cloud event.
 * @param {object} event - The raw event.
 * @returns {'doorbell'|'motion'|null} The kind of event, or null when unknown.
 * @example
 * classifyEvent({ eventType: 'ring' }); // 'doorbell'
 */
export function classifyEvent(event) {
  // The local API reports `alarm_type`, a number: 2 is the motion/detection
  // family, 3 the doorbell ring. Measured on a C610; the textual fields are kept
  // as a fallback because other firmwares label their events instead.
  if (event.alarm_type !== undefined) {
    const type = Number(event.alarm_type);
    if (type === ALARM_TYPES.DOORBELL) {
      return 'doorbell';
    }
    if (type === ALARM_TYPES.MOTION) {
      return 'motion';
    }
    return null;
  }

  const raw = `${event.eventType || ''} ${event.type || ''} ${event.name || ''}`.toLowerCase();
  if (EVENT_TYPES.DOORBELL.some((keyword) => raw.includes(keyword))) {
    return 'doorbell';
  }
  if (EVENT_TYPES.MOTION.some((keyword) => raw.includes(keyword))) {
    return 'motion';
  }
  return null;
}

export function eventTimestamp(event) {
  const raw = Number(event.start_time ?? event.timestamp ?? event.time ?? event.startTime ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  // A seconds-based timestamp of a plausible date is far below this bound.
  return raw < 1e11 ? raw * 1000 : raw;
}

/**
 * Watches the cloud for doorbell and motion events, and publishes them as
 * feature states.
 * @example
 * const watcher = new EventWatcher({ gladys, cloud });
 * watcher.start(config);
 */
export class EventWatcher {
  /**
   * @param {object} options - The dependencies.
   * @param {object} options.gladys - The SDK instance.
   * @param {object} options.cloud - The cloud client.
   * @param {(device: object) => Promise<void>} [options.onDoorbell] - Called when
   * a doorbell press is detected, to push a fresh image.
   */
  constructor({ gladys, cloud, onDoorbell, batteryGuard }) {
    this.gladys = gladys;
    this.cloud = cloud;
    this.onDoorbell = onDoorbell;
    /** Shared with the capture side, so a low battery pauses it. */
    this.batteryGuard = batteryGuard;
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
    /** Last event timestamp seen per camera, to only react to new ones. */
    this.watermarks = new Map();
    /** Pending motion resets, per camera. */
    this.motionResets = new Map();
    /** One local API client per camera IP, reused across rounds. */
    this.localApis = new Map();
    /** When each camera was last looked at, to bound the search window. */
    this.lastLookAt = new Map();
    /**
     * Last known privacy mode per device external id.
     *
     * Kept because a masked camera does not FAIL a capture — it serves a black
     * frame reading "Privacy Mode is on" — so this is the only thing that lets
     * the capture path tell "masked" from "working".
     * @type {Map<string, boolean>}
     */
    this.privacyModes = new Map();
    /** One ONVIF client per camera IP, for the cameras that support it. */
    this.onvifClients = new Map();
    /**
     * Cloud device ids whose events arrive over ONVIF.
     *
     * These cameras are skipped by the polled event path: the two sources report
     * the SAME detections, so keeping both would publish every motion twice —
     * once instantly, once up to a poll later, which reads as a second motion
     * and fires the scene again.
     * @type {Set<string>}
     */
    this.onvifCovered = new Set();
    /**
     * Last motion state published per camera, to publish only the CHANGES.
     *
     * A camera repeats its state for as long as the motion lasts — measured at
     * ~15 notifications a second on a C500, so one person walking past is
     * hundreds of identical `motion=true`. The host API rate-limits states at
     * 300 per minute per integration, sized for changes rather than snapshots,
     * so republishing each one burns the whole budget on a single camera and
     * the dashboard ends up showing nothing at all.
     * @type {Map<string, boolean>}
     */
    this.motionStates = new Map();
    /** Pending falling edges, held back to swallow the firmware's blips. */
    this.motionFalls = new Map();
    this.config = null;
    this.running = false;
  }

  /**
   * Subscribe to the ONVIF events of one camera, when it offers them.
   *
   * Best effort by design: ONVIF needs the camera account, and a camera without
   * one — or a battery model that keeps port 2020 closed — simply stays on the
   * polled path. Nothing is lost in that case, the events just arrive later.
   * @param {object} device - The Gladys device.
   * @returns {Promise<boolean>} True when the camera now pushes its events.
   * @example
   * await watcher.setupOnvif(device);
   */
  async setupOnvif(device) {
    const ip = getParam(device, DEVICE_PARAMS.IP);
    const cloudDeviceId =
      getParam(device, DEVICE_PARAMS.CLOUD_DEVICE_ID) || parseCloudDeviceId(device.external_id);
    // The config carries the camera accounts, so there is nothing to try before
    // the watcher has been started — this method is also called straight from
    // the "save a camera account" action, which may land first.
    if (!ip || !cloudDeviceId || !this.config || this.onvifClients.has(ip)) {
      return false;
    }

    // The CAMERA account, not the Tapo one: ONVIF authenticates against the
    // credentials created per camera in the app.
    const account = resolveRtspAccount(this.config, device.name);
    if (!account.username || !account.password) {
      logger.debug(`No camera account for "${device.name}", ONVIF events unavailable`);
      return false;
    }

    const client = new TapoOnvif(ip, account.username, account.password);
    if (!(await client.probe())) {
      // The camera did not accept the account, or serves no ONVIF at all. Both
      // are ordinary, and both mean the same thing here: keep polling.
      return false;
    }

    try {
      await client.subscribe();
    } catch (e) {
      logger.debug(`ONVIF subscription to "${device.name}" failed: ${e.message}`);
      return false;
    }

    this.onvifClients.set(ip, client);
    this.onvifCovered.add(cloudDeviceId);
    client.start((event) => {
      this.handleOnvifEvent(device, cloudDeviceId, event).catch((e) =>
        logger.debug(`Handling the ONVIF event of "${device.name}" failed: ${e.message}`),
      );
    });
    logger.info(`"${device.name}" now pushes its events over ONVIF`);
    return true;
  }

  /**
   * Drop the ONVIF subscription of one camera, so it can be opened again.
   *
   * Needed whenever the credentials change: a live client keeps authenticating
   * with the old ones, and it is what makes `setupOnvif` consider the camera
   * already handled. The camera falls back to the polled path until a new
   * subscription succeeds, so nothing is lost in between.
   * @param {object} device - The Gladys device.
   * @example
   * watcher.dropOnvif(device);
   */
  dropOnvif(device) {
    const ip = getParam(device, DEVICE_PARAMS.IP);
    const cloudDeviceId =
      getParam(device, DEVICE_PARAMS.CLOUD_DEVICE_ID) || parseCloudDeviceId(device.external_id);
    const client = ip ? this.onvifClients.get(ip) : null;
    if (client) {
      client.stop();
      this.onvifClients.delete(ip);
    }
    if (cloudDeviceId) {
      this.onvifCovered.delete(cloudDeviceId);
    }
  }

  /**
   * Publish one event the camera pushed.
   *
   * The falling edge is what ONVIF adds over polling: the camera says when the
   * motion STOPS, so the sensor follows the detection instead of an arbitrary
   * timer. The timer is still armed as a safety net, for the firmwares that only
   * ever report the rising edge.
   * @param {object} device - The Gladys device.
   * @param {string} cloudDeviceId - The cloud device id.
   * @param {object} event - The event, as parsed from the pull.
   * @returns {Promise<void>} Resolves once published.
   * @example
   * await watcher.handleOnvifEvent(device, 'ID1', { kind: 'motion', active: true });
   */
  async handleOnvifEvent(device, cloudDeviceId, event) {
    const ids = cameraIds(this.gladys, cloudDeviceId);

    if (event.kind === 'doorbell') {
      // A ring has no falling edge: it is an instant, not a state.
      if (!event.active) {
        return;
      }
      logger.info(`Doorbell press on "${device.name}" (ONVIF)`);
      await this.gladys
        .publishState(ids.feature(FEATURE_SUFFIXES.BUTTON), 1)
        .catch((e) => logger.debug(`Publishing the doorbell press failed: ${e.message}`));
      if (this.onDoorbell) {
        await this.onDoorbell(device).catch((e) =>
          logger.debug(`Doorbell image capture failed: ${e.message}`),
        );
      }
      return;
    }

    if (event.kind !== 'motion') {
      return;
    }

    // The rising edge is published straight away, and only on a CHANGE: the
    // camera repeats its state for as long as the motion lasts, so publishing
    // each notification sent hundreds of identical values and blew through the
    // 300 states/minute the host API allows.
    if (event.active) {
      // A pending fall is cancelled: the motion is still going on.
      const falling = this.motionFalls.get(cloudDeviceId);
      if (falling) {
        clearTimeout(falling);
        this.motionFalls.delete(cloudDeviceId);
      }

      if (this.motionStates.get(cloudDeviceId) !== true) {
        logger.info(`Motion detected on "${device.name}" (ONVIF)`);
        await this.publishMotion(cloudDeviceId, true);
      }

      // Still armed as the fallback for a camera that never reports the end.
      const pending = this.motionResets.get(cloudDeviceId);
      if (pending) {
        clearTimeout(pending);
        this.motionResets.delete(cloudDeviceId);
      }
      this.scheduleMotionReset(cloudDeviceId, ONVIF_MOTION_TIMEOUT_MS);
      return;
    }

    // The falling edge WAITS. These firmwares slip a single `motion=false` into
    // the middle of an ongoing detection — measured on a C500: runs of 50 to 150
    // `true` split by exactly one `false`, over and over, while someone is still
    // walking in front of the camera. Publishing it at once dropped the sensor
    // back to "no motion" a second after it rose, so the dashboard barely
    // flickered while the logs showed a detection lasting half a minute.
    //
    // Holding the fall for a couple of seconds swallows those blips: a `true`
    // arriving in the meantime cancels it (above), and a motion that really has
    // ended has no more `true` to send, so the state falls a moment later.
    if (this.motionStates.get(cloudDeviceId) !== true || this.motionFalls.has(cloudDeviceId)) {
      return;
    }
    const timer = setTimeout(async () => {
      this.motionFalls.delete(cloudDeviceId);
      const published = await this.publishMotion(cloudDeviceId, false);
      // The camera reported the end itself, so the safety net has nothing left
      // to catch: left armed it would publish a second, pointless 0 minutes
      // later — and, worse, one that could land in the middle of a NEW motion.
      //
      // Only once the 0 actually LANDED, though. A fall the host rejected
      // leaves Gladys showing a motion that is over, and disarming the fallback
      // as well would leave nothing at all to bring the sensor back down.
      if (!published) {
        return;
      }
      const pending = this.motionResets.get(cloudDeviceId);
      if (pending) {
        clearTimeout(pending);
        this.motionResets.delete(cloudDeviceId);
      }
    }, ONVIF_MOTION_FALL_DELAY_MS);
    // Same as the reset above: it must not hold the process open on its own.
    timer.unref?.();
    this.motionFalls.set(cloudDeviceId, timer);
  }

  /**
   * Start (or restart) the polling loop.
   * @param {object} config - The normalized configuration.
   * @example
   * watcher.start(config);
   */
  start(config) {
    this.stop();
    this.config = config;
    // `unref` would let the process exit mid-tick; the shutdown handler stops it.
    this.timer = setInterval(() => {
      this.tick().catch((e) => logger.debug(`Tapo event check failed: ${e.message}`));
    }, config.event_poll_interval * 1000);
    logger.info(`Watching the Tapo events every ${config.event_poll_interval}s`);

    // Try ONVIF on every camera in the background: probing and subscribing take
    // a round trip each, and the polled path already covers the cameras while
    // that happens. Whichever cameras accept it then stop being polled.
    this.setupOnvifSubscriptions().catch((e) =>
      logger.debug(`Setting up the ONVIF subscriptions failed: ${e.message}`),
    );
  }

  /**
   * Try to subscribe every known camera to its ONVIF events.
   * @returns {Promise<void>} Resolves once every camera has been tried.
   * @example
   * await watcher.setupOnvifSubscriptions();
   */
  async setupOnvifSubscriptions() {
    // ASKED, not read off `gladys.devices`. That property is only resynchronized
    // when the WebSocket (re)connects, so on the `config-updated` path — where
    // the watcher is restarted right after a re-publish — it still holds the
    // list from the last connection. On a first setup that list is EMPTY, no
    // camera is ever filtered in, and no subscription is opened: the motion
    // sensor then stays silent for good, with nothing in the logs to say so,
    // because the failure is an empty loop rather than an error.
    const devices = await this.gladys.getDevices().catch((e) => {
      logger.debug(`Listing the devices for the ONVIF setup failed: ${e.message}`);
      return [];
    });
    const cameras = devices.filter((device) =>
      (device.features || []).some(
        (feature) =>
          feature.category === DEVICE_FEATURE_CATEGORIES.BUTTON ||
          feature.category === DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR,
      ),
    );
    if (cameras.length === 0) {
      // Said out loud, because "no camera to subscribe" and "every subscription
      // failed" produced the same silence before — and the first one is the
      // symptom of the devices not being loaded at all.
      logger.debug('No camera carries an event feature: no ONVIF subscription to open');
      return;
    }
    // Independent per camera, and each one is two round trips: doing them
    // together keeps the startup from growing with the number of cameras.
    await Promise.all(
      cameras.map((device) =>
        this.setupOnvif(device).catch((e) => {
          logger.debug(`ONVIF setup for "${device.name}" failed: ${e.message}`);
          return false;
        }),
      ),
    );
  }

  /**
   * Re-try the ONVIF subscription of the cameras that have none.
   *
   * Deliberately fire-and-forget and never awaited by the tick: a camera that is
   * still down must not hold the polled path — which is the fallback covering it
   * meanwhile — for the duration of its timeouts.
   * @param {object[]} devices - The cameras carrying an event feature.
   * @returns {Promise<void>} Resolves once every candidate has been tried.
   * @example
   * await watcher.retryOnvifSubscriptions(devices);
   */
  async retryOnvifSubscriptions(devices) {
    const candidates = devices.filter((device) => {
      const cloudDeviceId =
        getParam(device, DEVICE_PARAMS.CLOUD_DEVICE_ID) || parseCloudDeviceId(device.external_id);
      // `onvifCovered` is the record of a subscription that actually opened, so
      // a camera missing from it is one whose push path is not running.
      return cloudDeviceId && !this.onvifCovered.has(cloudDeviceId);
    });
    if (candidates.length === 0) {
      return;
    }
    await Promise.all(
      candidates.map((device) =>
        this.setupOnvif(device).catch((e) => {
          logger.debug(`ONVIF retry for "${device.name}" failed: ${e.message}`);
          return false;
        }),
      ),
    );
  }

  /**
   * Stop the polling loop and cancel the pending motion resets.
   * @example
   * watcher.stop();
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.motionResets.forEach((timer) => clearTimeout(timer));
    this.motionResets.clear();
    this.motionFalls.forEach((timer) => clearTimeout(timer));
    this.motionFalls.clear();
    // Unsubscribe rather than just dropping the clients: the camera keeps the
    // subscription alive on its side for its full termination time, and only
    // accepts a few at once — a restart would find them all taken.
    this.onvifClients.forEach((client) => client.stop());
    this.onvifClients.clear();
    this.onvifCovered.clear();
    // Log out of every camera: a session left open counts against the handful
    // the firmware allows, and the next start would be refused.
    this.localApis.forEach((api) => {
      api.close().catch(() => {});
    });
    this.localApis.clear();
  }

  /**
   * Run one check. Overlapping ticks are skipped: a slow cloud must not pile up
   * concurrent runs that would each publish the same event.
   * @returns {Promise<void>} Resolves once the tick is done.
   * @example
   * await watcher.tick();
   */
  async tick() {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      // Asked, for the same reason as the ONVIF setup: `gladys.devices` is only
      // resynchronized when the WebSocket (re)connects, so after a config change
      // it is stale — and empty until the first reconnection. This loop is what
      // the CLOUD path relies on, so a stale list here means a battery camera,
      // which has no ONVIF to fall back on, reports nothing at all.
      const devices = await this.gladys.getDevices().catch((e) => {
        logger.debug(`Listing the devices for the event tick failed: ${e.message}`);
        return [];
      });
      // Only the cameras Gladys knows about are worth polling.
      const eventDevices = devices.filter((device) =>
        (device.features || []).some(
          (feature) =>
            feature.category === DEVICE_FEATURE_CATEGORIES.BUTTON ||
            feature.category === DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR,
        ),
      );
      // A camera that has an event feature but no live subscription is retried
      // here. The setup only runs at startup, so a camera that was unreachable
      // then — rebooting, off the network for a minute — stayed on the polled
      // path for the whole life of the process, with nothing in the logs after
      // the first failure to say the push path was never restored.
      this.retryOnvifSubscriptions(eventDevices).catch((e) =>
        logger.debug(`Retrying the ONVIF subscriptions failed: ${e.message}`),
      );

      for (const device of eventDevices) {
        await this.checkDevice(device).catch((e) =>
          logger.debug(`Event check failed for "${device.name}": ${e.message}`),
        );
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Check one camera and publish what changed.
   * @param {object} device - The Gladys device.
   * @returns {Promise<void>} Resolves once published.
   * @example
   * await watcher.checkDevice(device);
   */
  async checkDevice(device) {
    const cloudDeviceId =
      getParam(device, DEVICE_PARAMS.CLOUD_DEVICE_ID) || parseCloudDeviceId(device.external_id);
    if (!cloudDeviceId) {
      return;
    }

    const { events, battery, privacy } = await this.fetchDeviceEvents(device);

    if (this.batteryGuard) {
      // Feed the guard first: it decides whether captures may run at all, and
      // the reading below is what lets it release a recovering camera.
      this.batteryGuard.update(device.external_id, battery, device.name);
    }

    if (battery !== null) {
      await this.gladys
        .publishState(
          cameraIds(this.gladys, cloudDeviceId).feature(FEATURE_SUFFIXES.BATTERY),
          battery,
        )
        .catch(() => {});
    }

    if (privacy !== null) {
      // Remembered as well as published: capturing a masked camera returns a
      // black frame instead of failing, so the capture path has no way of
      // noticing on its own (see `isPrivacyModeOn`).
      this.privacyModes.set(device.external_id, privacy);
      await this.gladys
        .publishState(
          cameraIds(this.gladys, cloudDeviceId).feature(FEATURE_SUFFIXES.PRIVACY),
          privacy ? 1 : 0,
        )
        .catch(() => {});
    }

    // ONVIF already delivered these detections, instantly. Publishing them again
    // from the polled list would fire every scene a second time, so the polled
    // path stops at the battery — which ONVIF does not carry.
    if (this.onvifCovered.has(cloudDeviceId)) {
      return;
    }

    const previous = this.watermarks.get(cloudDeviceId);
    const latest = events.reduce((max, event) => Math.max(max, eventTimestamp(event)), 0);
    // First look at this camera: record where we are and fire nothing.
    if (previous === undefined) {
      this.watermarks.set(cloudDeviceId, latest);
      return;
    }
    if (latest <= previous) {
      return;
    }
    this.watermarks.set(cloudDeviceId, latest);

    const fresh = events.filter((event) => eventTimestamp(event) > previous);
    const kinds = new Set(fresh.map(classifyEvent).filter((kind) => kind !== null));

    if (kinds.has('doorbell')) {
      logger.info(`Doorbell press on "${device.name}"`);
      await this.gladys
        .publishState(cameraIds(this.gladys, cloudDeviceId).feature(FEATURE_SUFFIXES.BUTTON), 1)
        .catch((e) => logger.debug(`Publishing the doorbell press failed: ${e.message}`));
      if (this.onDoorbell) {
        // Best effort: a failed capture must not lose the press itself.
        await this.onDoorbell(device).catch((e) =>
          logger.debug(`Doorbell image capture failed: ${e.message}`),
        );
      }
    }

    if (kinds.has('motion')) {
      logger.debug(`Motion detected on "${device.name}"`);
      await this.publishMotion(cloudDeviceId, true, (message) => logger.debug(message));
      this.scheduleMotionReset(cloudDeviceId);
    }
  }

  /**
   * Publish a motion state and remember it ONLY if the host accepted it.
   *
   * The deduplication above makes this map the single source of truth for what
   * Gladys is believed to be showing: a state equal to the one recorded is never
   * republished. Recording a value the host never received therefore silences
   * the sensor for good — the map reads `true`, every later notification is
   * filtered out as "no change", and no motion is published again until the
   * process restarts and the map is empty. That is not theoretical: a rate-limit
   * rejection or a network blip on the rising edge is enough, and it is exactly
   * how a camera came back from a restart working with no code change.
   *
   * So the write happens AFTER the publish, and only on success. A failed
   * publish leaves the map on its previous value, which makes the next
   * notification a change again — the sensor retries instead of going deaf.
   * @param {string} cloudDeviceId - The cloud device id.
   * @param {boolean} active - The state to publish.
   * @param {(message: string) => void} [onError] - How to report a failure.
   * @returns {Promise<boolean>} True when the host accepted the state.
   * @example
   * await watcher.publishMotion('80224A...', true);
   */
  async publishMotion(cloudDeviceId, active, onError = (message) => logger.warn(message)) {
    try {
      await this.gladys.publishState(
        cameraIds(this.gladys, cloudDeviceId).feature(FEATURE_SUFFIXES.MOTION),
        active ? 1 : 0,
      );
      this.motionStates.set(cloudDeviceId, active);
      return true;
    } catch (e) {
      onError(`Publishing the motion of ${cloudDeviceId} failed: ${e.message}`);
      return false;
    }
  }

  /**
   * Bring a motion feature back to 0. The polled path only reports the start of
   * a motion, so without this the sensor would stay triggered forever.
   * @param {string} cloudDeviceId - The cloud device id.
   * @param {number} [delayMs] - How long to wait; the ONVIF path passes a longer
   * delay because there it is only a fallback for a missing falling edge.
   * @example
   * watcher.scheduleMotionReset('80224A...');
   */
  scheduleMotionReset(cloudDeviceId, delayMs = MOTION_RESET_MS) {
    const pending = this.motionResets.get(cloudDeviceId);
    if (pending) {
      // A new motion extends the window instead of resetting mid-detection.
      clearTimeout(pending);
    }
    const timer = setTimeout(async () => {
      this.motionResets.delete(cloudDeviceId);
      // Kept in step with the deduplication: without this the map would still
      // read `true` after the reset published 0, and the NEXT real motion would
      // be filtered out as "no change" — a sensor that fires once and then never
      // again. `publishMotion` only records the value the host accepted, so a
      // failed reset leaves the map on `true` and the next motion still reads as
      // a change.
      await this.publishMotion(cloudDeviceId, false, (message) => logger.debug(message));
    }, delayMs);
    // Nothing waits on this: it publishes a state, it is not work to finish. Left
    // referenced it holds the event loop open for its full delay — up to three
    // minutes — which is what made the test suite hang rather than exit, and
    // would delay a shutdown by as much.
    timer.unref?.();
    this.motionResets.set(cloudDeviceId, timer);
  }

  /**
   * Tell whether a camera is known to be masked right now.
   *
   * Only ever true when the camera SAID so: a device never polled, or one whose
   * firmware has no lens mask, reads as false and is captured as usual.
   * @param {string} externalId - The device external id.
   * @returns {boolean} True when the lens is known to be masked.
   * @example
   * if (watcher.isPrivacyModeOn(device.external_id)) { ... }
   */
  isPrivacyModeOn(externalId) {
    return this.privacyModes.get(externalId) === true;
  }

  /**
   * Record the privacy mode of a camera after a command changed it.
   *
   * The command path calls this so the capture guard does not keep skipping a
   * camera the user just un-masked, instead of waiting for the next poll.
   * @param {string} externalId - The device external id.
   * @param {boolean} enabled - The new state.
   * @example
   * watcher.setPrivacyMode(device.external_id, true);
   */
  setPrivacyMode(externalId, enabled) {
    this.privacyModes.set(externalId, enabled);
  }

  /**
   * The local API client of one camera, opened once and kept.
   *
   * Public because the command path needs it too: the firmware only accepts a
   * handful of sessions at a time, so a second client opened alongside this one
   * would eventually get every login refused with -40413. Everything talking to
   * a camera locally goes through here.
   * @param {string} ip - The camera address.
   * @returns {object} The client.
   * @example
   * const api = watcher.getLocalApi('192.168.1.20');
   */
  getLocalApi(ip) {
    let api = this.localApis.get(ip);
    if (!api) {
      api = new TapoLocalApi(ip, this.config.password);
      this.localApis.set(ip, api);
    }
    return api;
  }

  /**
   * Fetch the recent events, the battery level and the privacy mode of one
   * camera.
   *
   * The cloud exposes this through a passthrough call whose payload varies across
   * models and firmwares, so every field is read defensively: a shape we do not
   * recognize yields no event rather than a crash.
   * @param {object} device - The Gladys device, carrying the camera address.
   * @returns {Promise<{ events: object[], battery: number|null, privacy: boolean|null }>} What was found.
   * @example
   * const { events, battery, privacy } = await watcher.fetchDeviceEvents(device);
   */
  async fetchDeviceEvents(device) {
    const ip = getParam(device, DEVICE_PARAMS.IP);
    if (!ip) {
      return { events: [], battery: null, privacy: null };
    }

    // A camera pushing its events over ONVIF is not asked for its detections:
    // the answer would be discarded anyway, and every skipped request is one
    // less wake-up for a battery camera.
    const cloudDeviceId =
      getParam(device, DEVICE_PARAMS.CLOUD_DEVICE_ID) || parseCloudDeviceId(device.external_id);
    const skipDetections = this.onvifCovered.has(cloudDeviceId);

    // Nothing to read on this camera: an ONVIF-covered wired camera with no
    // battery and no privacy switch has no local question left. Opening a
    // session anyway is not free — on a camera that refuses these credentials it
    // is a failed login every tick, which is what keeps such a camera locked out
    // permanently instead of for a few minutes.
    const features = device.features || [];
    const wants = (suffix) =>
      features.some((feature) => String(feature.external_id || '').endsWith(`:${suffix}`));
    const wantsBattery = wants(FEATURE_SUFFIXES.BATTERY);
    const wantsPrivacy = wants(FEATURE_SUFFIXES.PRIVACY);
    if (skipDetections && !wantsBattery && !wantsPrivacy) {
      return { events: [], battery: null, privacy: null };
    }

    const api = this.getLocalApi(ip);

    // Only the window since the last look matters, and the camera stores far
    // more than that — asking for everything would return hundreds of entries.
    const now = Math.floor(Date.now() / 1000);
    const since = this.lastLookAt.get(ip) ?? now - LOCAL_EVENT_WINDOW_SECONDS;
    this.lastLookAt.set(ip, now);

    // Only what this device actually exposes is asked for: reading a battery
    // level from a wired camera, or a lens mask from a camera that has no
    // switch, is pure cost with nothing to gain.
    const [battery, events, privacy] = await Promise.all([
      wantsBattery
        ? api.getBatteryLevel().catch((e) => {
            logger.debug(`Reading the battery of ${ip} failed: ${e.message}`);
            return null;
          })
        : Promise.resolve(null),
      skipDetections
        ? Promise.resolve([])
        : api.getDetections(since, now).catch((e) => {
            logger.debug(`Reading the detections of ${ip} failed: ${e.message}`);
            return [];
          }),
      // Re-read every round so a toggle made from the Tapo app reaches Gladys:
      // a switch that only reflects what Gladys itself did is a switch that
      // lies. Only for the cameras that HAVE the switch, though.
      wantsPrivacy
        ? api.getPrivacyMode().catch((e) => {
            logger.debug(`Reading the privacy mode of ${ip} failed: ${e.message}`);
            return null;
          })
        : Promise.resolve(null),
    ]);

    return { events, battery, privacy };
  }
}
