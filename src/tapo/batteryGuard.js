// -----------------------------------------------------------------------------
// Battery protection for solar/battery cameras.
//
// The problem it solves: capturing an image is by far the most expensive thing
// this integration asks of a camera, and a battery model on solar only refills
// in bursts. Left unchecked, a refresh every 30 s drains the cell faster than
// the panel refills it — and a lithium cell taken too low may stop accepting
// charge at all, which is not recoverable remotely.
//
// Two levels, and one deliberate asymmetry:
//
//   >= 60%      everything runs;
//   40% - 60%   the periodic refresh stops, explicit requests still work
//               (opening the widget, a scene, a doorbell press);
//   < 40%       nothing is captured at all.
//
// Recovery waits for a FULL charge rather than a couple of points above the
// pause threshold. Resuming early restarts the drain on a still-weak reserve,
// and repeated shallow cycles in the low range wear the cell faster than one
// proper cycle — so the camera earns its way back only once genuinely refilled.
//
// Reading the battery and the detections is NOT gated: those are cheap, and the
// battery reading is what tells us when to resume.
// -----------------------------------------------------------------------------

import { logger } from '@gladysassistant/integration-sdk';
import { BATTERY_THRESHOLDS } from './constants.js';

/** What a camera is currently allowed to do. */
export const CAPTURE_POLICY = {
  /** Everything, including the periodic refresh. */
  FULL: 'full',
  /** Explicit requests only: widget, scene, doorbell. */
  ON_DEMAND: 'on-demand',
  /** Nothing at all. */
  NONE: 'none',
};

/**
 * Tracks the battery of each camera and decides what it may do.
 *
 * State is kept per camera because the decision is hysteretic: what is allowed
 * depends on how the camera got there, not only on its current level.
 * @example
 * const guard = new BatteryGuard();
 * guard.update('ext:...:camera:ID1', 55);
 * guard.policyFor(device); // 'on-demand'
 */
export class BatteryGuard {
  /**
   * @param {object} [thresholds] - Overrides from the user configuration.
   * @param {number} [thresholds.pauseRefresh] - Below this, no auto refresh.
   * @param {number} [thresholds.stopAll] - Below this, no capture at all.
   */
  constructor({ pauseRefresh, stopAll } = {}) {
    // A stop threshold above the pause one would make the middle band
    // unreachable; keeping them ordered is cheaper than validating the form.
    this.pauseRefresh = Number.isFinite(pauseRefresh)
      ? pauseRefresh
      : BATTERY_THRESHOLDS.PAUSE_REFRESH;
    this.stopAll = Number.isFinite(stopAll)
      ? Math.min(stopAll, this.pauseRefresh)
      : BATTERY_THRESHOLDS.STOP_ALL;
    /** Latest known level per device external id. */
    this.levels = new Map();
    /** Cameras currently held back, waiting for a full charge. */
    this.recovering = new Set();
  }

  /**
   * Apply the thresholds from the user configuration.
   * @param {object} config - The normalized configuration.
   * @example
   * guard.configure(config);
   */
  configure(config) {
    if (Number.isFinite(config?.battery_pause_refresh)) {
      this.pauseRefresh = config.battery_pause_refresh;
    }
    if (Number.isFinite(config?.battery_stop_all)) {
      // Never above the pause threshold, or the on-demand band would vanish.
      this.stopAll = Math.min(config.battery_stop_all, this.pauseRefresh);
    }
  }

  /**
   * Record a battery reading and update what the camera may do.
   * @param {string} externalId - The device external id.
   * @param {number|null} level - The battery percentage, or null when unknown.
   * @param {string} [name] - The camera name, for the logs.
   * @example
   * guard.update(device.external_id, 55, device.name);
   */
  update(externalId, level, name = externalId) {
    if (level === null || !Number.isFinite(level)) {
      return;
    }
    const previous = this.levels.get(externalId);
    this.levels.set(externalId, level);

    const wasRecovering = this.recovering.has(externalId);

    if (level < this.pauseRefresh) {
      if (!wasRecovering) {
        this.recovering.add(externalId);
        logger.warn(
          `"${name}" is at ${level}%: image capture is paused until the battery is back to ${BATTERY_THRESHOLDS.RESUME}%.`,
        );
      } else if (previous !== undefined && level < this.stopAll && previous >= this.stopAll) {
        logger.warn(
          `"${name}" dropped to ${level}%: every capture is now blocked to protect the battery.`,
        );
      }
      return;
    }

    // At or above the pause threshold, but a camera that went low stays held
    // back until it is genuinely refilled.
    if (wasRecovering && level >= BATTERY_THRESHOLDS.RESUME) {
      this.recovering.delete(externalId);
      logger.info(`"${name}" is charged (${level}%): image capture resumes.`);
    }
  }

  /**
   * What a camera is currently allowed to do.
   * @param {string} externalId - The device external id.
   * @returns {string} One of CAPTURE_POLICY.
   * @example
   * guard.policyFor(device.external_id);
   */
  policyFor(externalId) {
    const level = this.levels.get(externalId);
    // A camera with no battery reading is either wired or not yet polled: it is
    // never throttled on a guess.
    if (level === undefined) {
      return CAPTURE_POLICY.FULL;
    }
    if (level < this.stopAll) {
      return CAPTURE_POLICY.NONE;
    }
    if (this.recovering.has(externalId)) {
      return CAPTURE_POLICY.ON_DEMAND;
    }
    return CAPTURE_POLICY.FULL;
  }

  /**
   * Tell whether the periodic refresh may capture this camera.
   * @param {string} externalId - The device external id.
   * @returns {boolean} True when the scheduled refresh is allowed.
   * @example
   * if (guard.allowsScheduled(device.external_id)) { ... }
   */
  allowsScheduled(externalId) {
    return this.policyFor(externalId) === CAPTURE_POLICY.FULL;
  }

  /**
   * Tell whether an explicit request may capture this camera.
   * @param {string} externalId - The device external id.
   * @returns {boolean} True when a widget or doorbell capture is allowed.
   * @example
   * if (guard.allowsOnDemand(device.external_id)) { ... }
   */
  allowsOnDemand(externalId) {
    return this.policyFor(externalId) !== CAPTURE_POLICY.NONE;
  }

  /**
   * The last known level of a camera, for messages.
   * @param {string} externalId - The device external id.
   * @returns {number|null} The percentage, or null when never read.
   * @example
   * guard.levelOf(device.external_id);
   */
  levelOf(externalId) {
    const level = this.levels.get(externalId);
    return level === undefined ? null : level;
  }
}
