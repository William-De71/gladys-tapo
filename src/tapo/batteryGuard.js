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
// Recovery waits well above the pause threshold rather than a couple of points
// over it. Resuming early restarts the drain on a still-weak reserve, and
// repeated shallow cycles in the low range wear the cell faster than one proper
// cycle — so the camera earns its way back only once genuinely refilled.
//
// Reading the battery and the detections is NOT gated: those are cheap, and the
// battery reading is what tells us when to resume.
//
// Two failure modes this guard has to survive, both of which silently disarmed
// it before:
//
//   - a level that stops being refreshed. The guard decides from the LAST known
//     level, so a camera whose readings stop coming — asleep, session refused,
//     network down — would keep being captured against an ever-staler number.
//     A reading therefore expires, and an expired battery camera drops to
//     on-demand;
//   - a battery camera that never answered at all. With no level, the old code
//     returned FULL and captured freely, which is exactly backwards: the models
//     that need protecting are the ones that go quiet. A camera declared as a
//     battery model is now held to on-demand until it proves its level.
// -----------------------------------------------------------------------------

import { logger } from '@gladysassistant/integration-sdk';
import {
  BATTERY_THRESHOLDS,
  BATTERY_READING_MAX_AGE_MS,
  BATTERY_LOW_POLL_INTERVAL_MS,
} from './constants.js';

/**
 * Resume level above which a solar camera is unlikely to ever be released.
 *
 * Not a limit — the user stays free to set it — but the point past which the
 * setting is worth a warning: a solar camera charges in bursts and is sampled
 * every few minutes, so a level set this high is simply never read, and a camera
 * that dipped once below the pause level stays paused for good.
 */
const UNREACHABLE_RESUME_PERCENT = 90;

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
   * @param {number} [thresholds.resume] - At this level, capturing resumes.
   */
  constructor({ pauseRefresh, stopAll, resume } = {}) {
    this.pauseRefresh = BATTERY_THRESHOLDS.PAUSE_REFRESH;
    this.stopAll = BATTERY_THRESHOLDS.STOP_ALL;
    this.resume = BATTERY_THRESHOLDS.RESUME;
    this.applyThresholds({ pauseRefresh, stopAll, resume });

    /** Latest known level per device external id. */
    this.levels = new Map();
    /** When each level was read, to drop the ones that went stale. */
    this.readAt = new Map();
    /** Cameras currently held back, waiting to be refilled. */
    this.recovering = new Set();
    /** Cameras known to run on battery, whether or not they ever answered. */
    this.batteryCameras = new Set();
    /** When each throttled camera was last polled, to space out its pulses. */
    this.polledAt = new Map();
  }

  /**
   * Apply the thresholds, keeping them in a usable order.
   *
   * Validated rather than trusted: the manifest lets the user type 0 in any of
   * these fields, and an unordered set would silently disarm a whole band — a
   * stop threshold above the pause one makes the on-demand band unreachable, and
   * a resume below the pause one lets a camera bounce straight back into the
   * drain it was pulled out of.
   * @param {object} thresholds - The candidate values.
   * @param {number} [thresholds.pauseRefresh] - Below this, no auto refresh.
   * @param {number} [thresholds.stopAll] - Below this, no capture at all.
   * @param {number} [thresholds.resume] - At this level, capturing resumes.
   * @example
   * guard.applyThresholds({ pauseRefresh: 50, stopAll: 30 });
   */
  applyThresholds({ pauseRefresh, stopAll, resume } = {}) {
    if (Number.isFinite(pauseRefresh)) {
      this.pauseRefresh = clampPercent(pauseRefresh);
    }
    if (Number.isFinite(stopAll)) {
      // Never above the pause threshold, or the on-demand band would vanish.
      this.stopAll = Math.min(clampPercent(stopAll), this.pauseRefresh);
    }
    if (Number.isFinite(resume)) {
      this.resume = clampPercent(resume);
    }
    // A resume at or below the pause threshold would release a camera the moment
    // it crosses back, which is the shallow cycling this guard exists to avoid.
    const requestedResume = this.resume;
    this.resume = Math.max(this.resume, this.pauseRefresh);
    if (Number.isFinite(resume) && this.resume !== requestedResume) {
      logger.warn(
        `The resume level (${requestedResume}%) was raised to ${this.resume}% to stay above the pause level.`,
      );
    }
    // A resume a solar camera cannot reach locks it out for good: it only charges
    // in bursts, so a level set near the top is simply never read. Worth saying
    // out loud, because nothing else reports it — the camera just stops capturing
    // and never explains why.
    if (this.resume >= UNREACHABLE_RESUME_PERCENT) {
      logger.warn(
        `The resume level is set to ${this.resume}%: a solar camera rarely reads that high, and one that dips below ${this.pauseRefresh}% may stay paused indefinitely.`,
      );
    }
  }

  /**
   * Apply the thresholds from the user configuration.
   * @param {object} config - The normalized configuration.
   * @example
   * guard.configure(config);
   */
  configure(config) {
    this.applyThresholds({
      pauseRefresh: config?.battery_pause_refresh,
      stopAll: config?.battery_stop_all,
      resume: config?.battery_resume,
    });
  }

  /**
   * Declare a camera as running on battery.
   *
   * What makes a camera protected is its MODEL, not whether it happened to
   * answer: a battery camera that never reports its level is the one most likely
   * to be flat, so it must not be treated like a wired camera.
   * @param {string} externalId - The device external id.
   * @example
   * guard.trackBatteryCamera(device.external_id);
   */
  trackBatteryCamera(externalId) {
    this.batteryCameras.add(externalId);
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
    // A camera that reports a level runs on battery, whatever its model says:
    // this catches the models the prefix list does not know about yet.
    this.batteryCameras.add(externalId);

    const previous = this.levels.get(externalId);
    this.levels.set(externalId, level);
    this.readAt.set(externalId, Date.now());

    const wasRecovering = this.recovering.has(externalId);

    if (level < this.pauseRefresh) {
      if (!wasRecovering) {
        this.recovering.add(externalId);
        logger.warn(
          `"${name}" is at ${level}%: image capture is paused until the battery is back to ${this.resume}%.`,
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
    if (wasRecovering && level >= this.resume) {
      this.recovering.delete(externalId);
      logger.info(`"${name}" is charged (${level}%): image capture resumes.`);
    }
  }

  /**
   * The level of a camera, or undefined when there is no usable reading.
   *
   * A reading older than `BATTERY_READING_MAX_AGE_MS` is deliberately discarded
   * rather than kept as a best guess: the battery only moves in one direction
   * while the camera is being captured, so an old level always overestimates
   * what is left.
   * @param {string} externalId - The device external id.
   * @returns {number|undefined} The level, or undefined when none is usable.
   */
  freshLevel(externalId) {
    const level = this.levels.get(externalId);
    if (level === undefined) {
      return undefined;
    }
    const readAt = this.readAt.get(externalId) ?? 0;
    return Date.now() - readAt > BATTERY_READING_MAX_AGE_MS ? undefined : level;
  }

  /**
   * What a camera is currently allowed to do.
   * @param {string} externalId - The device external id.
   * @returns {string} One of CAPTURE_POLICY.
   * @example
   * guard.policyFor(device.external_id);
   */
  policyFor(externalId) {
    const level = this.freshLevel(externalId);
    if (level === undefined) {
      // No usable reading. A wired camera is never throttled; a battery one is
      // held to on-demand, because a battery camera that stopped reporting is
      // more likely to be flat than fine — and the scheduled refresh is exactly
      // what would finish it off.
      return this.batteryCameras.has(externalId) ? CAPTURE_POLICY.ON_DEMAND : CAPTURE_POLICY.FULL;
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
   * Tell whether a camera is treated as running on battery.
   * @param {string} externalId - The device external id.
   * @returns {boolean} True when the battery rules apply to it.
   * @example
   * guard.isBatteryCamera(device.external_id);
   */
  isBatteryCamera(externalId) {
    return this.batteryCameras.has(externalId);
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
   * Tell whether the full local poll may run for this camera.
   *
   * Below `stopAll` the camera is already forbidden from capturing anything, so
   * asking it for its detections and its privacy mode buys nothing and costs a
   * wake-up every round. Only the battery reading survives, and `dueForLowPoll`
   * spaces that one out.
   *
   * A battery camera with NO usable level is throttled too. `policyFor` answers
   * `ON_DEMAND` there rather than `NONE` — it is protecting the captures, and an
   * explicit request must stay possible — so keying the poll on `NONE` alone
   * would run the full 20s round against a camera whose charge is unknown, which
   * is the case `policyFor` already calls out as the most likely to be flat:
   * a reading that stopped coming means asleep, session refused, or network
   * down. A level gone stale past `BATTERY_READING_MAX_AGE_MS` lands here too,
   * which is the point — the guard stopped trusting it, so the poll backs off
   * with it.
   * @param {string} externalId - The device external id.
   * @returns {boolean} True when the camera may be polled normally.
   * @example
   * if (guard.allowsPolling(device.external_id)) { ... }
   */
  allowsPolling(externalId) {
    if (this.policyFor(externalId) === CAPTURE_POLICY.NONE) {
      return false;
    }
    // Unknown level on a battery camera: throttle it as well.
    return !(this.batteryCameras.has(externalId) && this.freshLevel(externalId) === undefined);
  }

  /**
   * Tell whether a throttled camera is due for its spaced-out battery reading.
   *
   * Records the moment it says yes, so the caller cannot ask twice and get two
   * pulses. A camera that has never been pulsed is due immediately: that first
   * reading is what tells the guard where it actually stands.
   * @param {string} externalId - The device external id.
   * @returns {boolean} True when the camera should be woken for its battery.
   * @example
   * if (guard.dueForLowPoll(device.external_id)) { ... }
   */
  dueForLowPoll(externalId) {
    const last = this.polledAt.get(externalId);
    if (last !== undefined && Date.now() - last < BATTERY_LOW_POLL_INTERVAL_MS) {
      return false;
    }
    this.polledAt.set(externalId, Date.now());
    return true;
  }

  /**
   * The last known level of a camera, for messages.
   * @param {string} externalId - The device external id.
   * @returns {number|null} The percentage, or null when never read.
   * @example
   * guard.levelOf(device.external_id);
   */
  levelOf(externalId) {
    // The last known level, stale or not: this one only feeds messages, and
    // "40% (20 min ago)" tells the user more than "unknown".
    const level = this.levels.get(externalId);
    return level === undefined ? null : level;
  }
}

/**
 * Keep a percentage inside 0-100.
 * @param {number} value - The candidate.
 * @returns {number} The clamped percentage.
 * @example
 * clampPercent(140); // 100
 */
function clampPercent(value) {
  return Math.min(100, Math.max(0, value));
}
