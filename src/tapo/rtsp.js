// -----------------------------------------------------------------------------
// RTSP: URL building and capture mode detection.
//
// Most Tapo cameras expose two RTSP streams once a camera account exists in the
// Tapo app. The battery models generally do not, and must go through the
// proprietary protocol instead — this module decides which mode a camera uses.
// -----------------------------------------------------------------------------

import net from 'node:net';
import { logger } from '@gladysassistant/integration-sdk';
import { resolveRtspAccount, hasRtspAccount } from '../config.js';
import {
  RTSP_PORT,
  STREAM_PORT,
  ONVIF_PORT,
  CAPTURE_MODES,
  BATTERY_MODEL_PREFIXES,
  NO_LOCAL_ACCESS_MODELS,
} from './constants.js';

/** A closed port answers fast; an unreachable host is what needs a bound. */
const PROBE_TIMEOUT_MS = 2500;

/**
 * Build the RTSP URL of a camera. The camera account credentials are
 * percent-encoded: they are user-chosen and often contain `@` or `:`, which would
 * otherwise break the URL.
 * @param {object} camera - The resolved camera, with its `ip`.
 * @param {object} config - The normalized configuration.
 * @returns {string} The RTSP URL.
 * @example
 * buildRtspUrl({ ip: '192.168.1.20' }, config);
 */
export function buildRtspUrl(camera, config) {
  // The camera account is per camera in the Tapo app, so it is resolved by name.
  const account = resolveRtspAccount(config, camera.name);
  const user = encodeURIComponent(account.username);
  const password = encodeURIComponent(account.password);
  return `rtsp://${user}:${password}@${camera.ip}:${RTSP_PORT}/${config.rtsp_stream}`;
}

/**
 * Tell whether a TCP port accepts a connection. Used to tell an RTSP camera from
 * a proprietary-only one without waiting for a full capture to fail.
 * @param {string} ip - The camera IP.
 * @param {number} port - The port to probe.
 * @returns {Promise<boolean>} True when the port accepts a connection.
 * @example
 * await isPortOpen('192.168.1.20', 554);
 */
export async function isPortOpen(ip, port) {
  return (await probePort(ip, port)) === 'open';
}

/**
 * Probe a TCP port, keeping WHY it did not answer.
 *
 * `isPortOpen` collapses "the camera refused the port" and "the camera did not
 * answer at all" into the same `false`, which is fine to pick a capture mode but
 * not to decide a camera's capabilities: a camera that was rebooting when it was
 * probed would be recorded as having no ONVIF, and lose its motion sensor until
 * the next full discovery. A refusal is an answer; a timeout is the absence of
 * one, and the two must lead to different decisions.
 * @param {string} ip - The camera IP.
 * @param {number} port - The port to probe.
 * @returns {Promise<'open'|'closed'|'unreachable'>} What the probe found.
 * @example
 * await probePort('192.168.1.20', 2020); // 'open'
 */
export function probePort(ip, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    /**
     * Resolve once and always release the socket.
     * @param {'open'|'closed'|'unreachable'} outcome - What the probe found.
     * @example
     * settle('open');
     */
    const settle = (outcome) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(outcome);
    };

    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('connect', () => settle('open'));
    // A timeout is the camera saying nothing at all — powered off, rebooting, or
    // off the network. `ECONNREFUSED` is the opposite: the host is there and
    // actively closed the door, which is a real "this camera has no ONVIF".
    socket.once('timeout', () => settle('unreachable'));
    socket.once('error', (e) => settle(e.code === 'ECONNREFUSED' ? 'closed' : 'unreachable'));
    socket.connect(port, ip);
  });
}

/**
 * Tell whether a model is known to run on battery, from its model string. Matched
 * as a prefix so C420S2 matches C420.
 * @param {string} model - The camera model.
 * @returns {boolean} True for a battery model.
 * @example
 * isBatteryModel('C425'); // true
 */
export function isBatteryModel(model) {
  const normalized = String(model || '').toUpperCase();
  return BATTERY_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Tell whether a model blocks every local access. TP-Link locks these down
 * entirely: no RTSP, no camera account, and the proprietary port rejects the
 * authentication. Saying so up front beats a mysterious 401 later.
 * @param {string} model - The camera model.
 * @returns {boolean} True when no local capture can work.
 * @example
 * hasNoLocalAccess('C610'); // true
 */
export function hasNoLocalAccess(model) {
  const normalized = String(model || '').toUpperCase();
  return NO_LOCAL_ACCESS_MODELS.some((locked) => normalized.startsWith(locked));
}

/**
 * Tell whether a camera serves ONVIF, by probing the port it uses.
 *
 * Probed rather than deduced from the model, for the same reason the capture
 * mode is: measured on a C210, the port is open and answers; on the battery
 * models it is closed. A model list would have to be maintained against every
 * new reference, and would be wrong the day TP-Link changes its mind.
 *
 * Returns null rather than false when the camera did not answer AT ALL: absence
 * of an answer is not a "no". Recording it as one is what cost a C210 its motion
 * sensor after it happened to be unreachable during one discovery — the feature
 * was dropped, and with no feature left the ONVIF setup never probed it again.
 * @param {object} camera - The camera, with its `ip`.
 * @returns {Promise<boolean|null>} True/false when known, null when unreachable.
 * @example
 * await hasOnvif(camera);
 */
export async function hasOnvif(camera) {
  if (!camera.ip) {
    return false;
  }
  const outcome = await probePort(camera.ip, ONVIF_PORT);
  if (outcome === 'unreachable') {
    return null;
  }
  return outcome === 'open';
}

/**
 * Decide how a camera should be captured, by probing its ports.
 *
 * RTSP is preferred when it is available AND the camera account is filled in: it
 * is the standard path, cheaper and more robust than the proprietary protocol.
 * @param {object} camera - The camera, with its `ip` and `model`.
 * @param {object} config - The normalized configuration.
 * @returns {Promise<string|null>} The capture mode, or null when unreachable.
 * @example
 * const mode = await detectCaptureMode(camera, config);
 */
export async function detectCaptureMode(camera, config) {
  if (!camera.ip) {
    return null;
  }
  const [rtspOpen, streamOpen] = await Promise.all([
    isPortOpen(camera.ip, RTSP_PORT),
    isPortOpen(camera.ip, STREAM_PORT),
  ]);

  const hasAccount = hasRtspAccount(config, camera.name);
  if (rtspOpen && hasAccount) {
    return CAPTURE_MODES.RTSP;
  }
  if (streamOpen) {
    if (rtspOpen && !hasAccount) {
      logger.info(
        `"${camera.name}" exposes RTSP but no camera account is configured, falling back to the proprietary protocol`,
      );
    }
    return CAPTURE_MODES.PROPRIETARY;
  }
  if (rtspOpen) {
    // RTSP is the only door open, but it needs credentials we do not have.
    return CAPTURE_MODES.RTSP;
  }
  logger.debug(`No local port answered on "${camera.name}" (${camera.ip})`);
  return null;
}
