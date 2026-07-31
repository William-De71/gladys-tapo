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

import { logger } from '@gladysassistant/integration-sdk';
import { parseCloudDeviceId, cameraIds, getParam } from '../devices.js';
import { DEVICE_PARAMS, FEATURE_SUFFIXES, LOCAL_EVENT_WINDOW_SECONDS } from './constants.js';
import { TapoLocalApi } from './localApi.js';

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
    this.config = null;
    this.running = false;
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
      const devices = this.gladys.devices || [];
      // Only the cameras Gladys knows about are worth polling.
      const eventDevices = devices.filter((device) =>
        (device.features || []).some(
          (feature) => feature.category === 'button' || feature.category === 'motion-sensor',
        ),
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

    const { events, battery } = await this.fetchDeviceEvents(device);

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
      await this.gladys
        .publishState(cameraIds(this.gladys, cloudDeviceId).feature(FEATURE_SUFFIXES.MOTION), 1)
        .catch((e) => logger.debug(`Publishing the motion failed: ${e.message}`));
      this.scheduleMotionReset(cloudDeviceId);
    }
  }

  /**
   * Bring a motion feature back to 0. The cloud only reports the start of a
   * motion, so without this the sensor would stay triggered forever.
   * @param {string} cloudDeviceId - The cloud device id.
   * @example
   * watcher.scheduleMotionReset('80224A...');
   */
  scheduleMotionReset(cloudDeviceId) {
    const pending = this.motionResets.get(cloudDeviceId);
    if (pending) {
      // A new motion extends the window instead of resetting mid-detection.
      clearTimeout(pending);
    }
    const timer = setTimeout(async () => {
      this.motionResets.delete(cloudDeviceId);
      await this.gladys
        .publishState(cameraIds(this.gladys, cloudDeviceId).feature(FEATURE_SUFFIXES.MOTION), 0)
        .catch((e) => logger.debug(`Resetting the motion failed: ${e.message}`));
    }, MOTION_RESET_MS);
    this.motionResets.set(cloudDeviceId, timer);
  }

  /**
   * Fetch the recent events and the battery level of one camera.
   *
   * The cloud exposes this through a passthrough call whose payload varies across
   * models and firmwares, so every field is read defensively: a shape we do not
   * recognize yields no event rather than a crash.
   * @param {object} device - The Gladys device, carrying the camera address.
   * @returns {Promise<{ events: object[], battery: number|null }>} What was found.
   * @example
   * const { events, battery } = await watcher.fetchDeviceEvents(device);
   */
  async fetchDeviceEvents(device) {
    const ip = getParam(device, DEVICE_PARAMS.IP);
    if (!ip) {
      return { events: [], battery: null };
    }

    // One long-lived client per camera: the firmware only accepts a handful of
    // sessions at a time, so opening one per round would exhaust them and every
    // later login would be refused with -40413.
    let api = this.localApis.get(ip);
    if (!api) {
      api = new TapoLocalApi(ip, this.config.password);
      this.localApis.set(ip, api);
    }

    // Only the window since the last look matters, and the camera stores far
    // more than that — asking for everything would return hundreds of entries.
    const now = Math.floor(Date.now() / 1000);
    const since = this.lastLookAt.get(ip) ?? now - LOCAL_EVENT_WINDOW_SECONDS;
    this.lastLookAt.set(ip, now);

    const [battery, events] = await Promise.all([
      api.getBatteryLevel().catch((e) => {
        logger.debug(`Reading the battery of ${ip} failed: ${e.message}`);
        return null;
      }),
      api.getDetections(since, now).catch((e) => {
        logger.debug(`Reading the detections of ${ip} failed: ${e.message}`);
        return [];
      }),
    ]);

    return { events, battery };
  }
}
