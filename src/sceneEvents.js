// -----------------------------------------------------------------------------
// Scene trigger `detection`: a camera or a doorbell saw something.
//
// The motion sensor of a camera says THAT something moved; this trigger also
// says WHAT, when the camera tells (person, vehicle, pet), so a scene can light
// the garden for a person and ignore the cat. A doorbell press is a detection
// of its own kind, so one scene can cover every camera.
//
// One event per detection, not per notification: a camera repeats its state
// for as long as the motion lasts, so each camera and kind is quiet for
// COOLDOWN_MS after an event (300 scene events per minute at most). Data is
// flat and limited to the declared variables.
// -----------------------------------------------------------------------------

import { logger } from '@gladysassistant/integration-sdk';

export const SCENE_TRIGGERS = { DETECTION: 'detection' };

/** The `kind` values of the trigger, forever. */
export const DETECTION_KINDS = ['person', 'vehicle', 'pet', 'motion', 'doorbell'];

export const COOLDOWN_MS = 60 * 1000;

/**
 * Create the scene event source of the integration.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {object} [options] - Options (the tests shorten the delay).
 * @param {number} [options.cooldownMs] - Quiet time per camera and kind.
 * @param {() => number} [options.now] - Clock.
 * @returns {{ detection: Function }} The event source.
 * @example
 * createSceneEvents(gladys).detection(device, 'person');
 */
export function createSceneEvents(gladys, options = {}) {
  const cooldownMs = options.cooldownMs ?? COOLDOWN_MS;
  const now = options.now || Date.now;
  /** Time of the last event per `<external id>|<kind>`. */
  const last = new Map();

  return {
    /**
     * A camera saw something.
     * @param {object} device - The Gladys device.
     * @param {string} kind - One of DETECTION_KINDS.
     * @returns {Promise<void>} Resolves once sent, refused or skipped.
     */
    async detection(device, kind) {
      if (!DETECTION_KINDS.includes(kind)) {
        return;
      }
      const key = `${device.external_id}|${kind}`;
      const at = now();
      const recent = (k) => at - (last.get(`${device.external_id}|${k}`) ?? -Infinity) < cooldownMs;
      if (recent(kind)) {
        return;
      }
      // A smart detection comes with the plain cell motion of the same scene:
      // the person already fired, the motion adds nothing.
      if (kind === 'motion' && ['person', 'vehicle', 'pet'].some(recent)) {
        return;
      }
      last.set(key, at);
      const data = { camera: device.external_id, name: device.name, kind };
      try {
        await gladys.publishSceneEvent(SCENE_TRIGGERS.DETECTION, data);
        logger.debug(`Scene event detection sent: ${JSON.stringify(data)}`);
      } catch (e) {
        logger.warn(`Scene event detection refused: ${e.message}`);
      }
    },
  };
}
