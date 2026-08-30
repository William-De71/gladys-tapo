// -----------------------------------------------------------------------------
// Integration configuration.
//
// The user-facing values come from the `config_schema` of the manifest; the SDK
// fetches them (`gladys.getConfig()`) and notifies changes through
// `gladys.onConfigUpdated()`.
//
// This module provides the defaults, normalizes the received object (a numeric
// field arrives as a string from the form), and parses the one free-text field
// the manifest cannot express structurally: the manual camera addresses.
// -----------------------------------------------------------------------------

import {
  CLOUD_ENDPOINTS,
  RTSP_STREAMS,
  BATTERY_THRESHOLDS,
  BATTERY_EVENT_POLL_INTERVAL,
} from './tapo/constants.js';

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest.
export const DEFAULT_CONFIG = {
  region: 'europe',
  stream_quality: 'HD',
  event_poll_interval: 20, // seconds, between two event checks (wired)
  // Battery cameras get their OWN poll interval, for the same reason they get
  // their own refresh interval: the poll wakes the camera far more often than any
  // capture, and the wake-up is what costs the cell.
  battery_event_poll_interval: BATTERY_EVENT_POLL_INTERVAL,
  capture_timeout: 14, // seconds, before giving up on a capture
  image_refresh_interval: 60, // seconds, between two automatic captures (wired)
  // Battery cameras get their OWN interval: the wired one exists to keep a
  // dashboard image fresh, which is cheap on mains and expensive on a cell. Tying
  // them together meant sparing a battery camera also degraded every wired one.
  // 15 min is roughly what a solar panel refills between two captures.
  battery_image_refresh_interval: 900,
  battery_pause_refresh: BATTERY_THRESHOLDS.PAUSE_REFRESH, // percent, below which the auto refresh stops
  battery_stop_all: BATTERY_THRESHOLDS.STOP_ALL, // percent, below which nothing is captured
  battery_resume: BATTERY_THRESHOLDS.RESUME, // percent, at which capturing resumes
};

/**
 * Split a multi-entry field into its trimmed, non-empty entries.
 *
 * Entries are separated by a COMMA, because the Gladys configuration form renders
 * a `string`/`secret` field as a single-line input: a newline simply cannot be
 * typed there. Newlines are accepted all the same, so a value pasted from a note
 * — or entered in a future multi-line field — still parses.
 * @param {unknown} raw - The raw field value.
 * @returns {string[]} The meaningful entries.
 * @example
 * splitEntries('jardin|192.168.1.42, salon|192.168.1.43');
 */
function splitEntries(raw) {
  if (typeof raw !== 'string') {
    return [];
  }
  return raw
    .split(/[,\r\n]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Parse the "camera addresses" field: one `name|ip` pair per line. The name is
 * lower-cased so an address entered as "Sonnette" still matches the camera the
 * cloud reports as "sonnette".
 * @param {unknown} raw - The raw field value.
 * @returns {Record<string, string>} IPs indexed by lower-cased camera name.
 * @example
 * parseCameraIps('sonnette|192.168.1.42'); // { sonnette: '192.168.1.42' }
 */
export function parseCameraIps(raw) {
  /** @type {Record<string, string>} */
  const ips = {};
  splitEntries(raw).forEach((line) => {
    // Only the FIRST separator splits: splitting on all of them would silently
    // truncate a malformed entry instead of ignoring it.
    const separator = line.indexOf('|');
    if (separator <= 0) {
      return;
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    const ip = line.slice(separator + 1).trim();
    if (name && ip) {
      ips[name] = ip;
    }
  });
  return ips;
}

/**
 * Parse the "camera accounts" field: one `name|username|password` triple per
 * line.
 *
 * The Tapo app creates the camera account PER CAMERA, so a single global
 * username/password only works when the user reused the same credentials
 * everywhere. This field carries the per-camera ones.
 *
 * The password is taken as the rest of the entry, so it may legitimately contain
 * a `|`; only the first two separators split. It cannot, however, contain a
 * comma, which separates the entries — the documentation says so, and the global
 * account fields remain available for such a password.
 * @param {unknown} raw - The raw field value.
 * @returns {Record<string, { username: string, password: string }>} Accounts
 * indexed by lower-cased camera name.
 * @example
 * parseCameraAccounts('jardin|user|p@ss'); // { jardin: { username: 'user', password: 'p@ss' } }
 */
export function parseCameraAccounts(raw) {
  /** @type {Record<string, { username: string, password: string }>} */
  const accounts = {};
  splitEntries(raw).forEach((line) => {
    const first = line.indexOf('|');
    if (first <= 0) {
      return;
    }
    const second = line.indexOf('|', first + 1);
    if (second === -1) {
      return;
    }
    const name = line.slice(0, first).trim().toLowerCase();
    const username = line.slice(first + 1, second).trim();
    // Never trimmed: a password may legitimately start or end with a space.
    const password = line.slice(second + 1);
    if (name && username && password) {
      accounts[name] = { username, password };
    }
  });
  return accounts;
}

/**
 * Read a numeric field, falling back to the default when it is unusable.
 *
 * `Number()` alone was not enough: a field the user cleared arrives as `''`,
 * which `Number` turns into 0 — a 0-second refresh interval, or a battery
 * threshold of 0 that disarms the protection entirely. Anything that is not a
 * finite number now falls back to the documented default instead.
 * @param {unknown} value - The raw field value.
 * @param {string} key - The key in `DEFAULT_CONFIG`, used as the fallback.
 * @returns {number} The usable number.
 * @example
 * numberOrDefault('', 'image_refresh_interval'); // 60
 */
function numberOrDefault(value, key) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_CONFIG[key];
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : DEFAULT_CONFIG[key];
}

/**
 * Merge the user config with the defaults, force the numeric types and parse
 * the free-text field.
 * @param {Record<string, unknown>} [raw] - Config returned by the SDK.
 * @returns {object} The normalized configuration.
 * @example
 * const config = normalizeConfig(await gladys.getConfig());
 */
export function normalizeConfig(raw = {}) {
  const region =
    typeof raw.region === 'string' && CLOUD_ENDPOINTS[raw.region]
      ? raw.region
      : DEFAULT_CONFIG.region;
  const quality = raw.stream_quality === 'SD' ? 'SD' : DEFAULT_CONFIG.stream_quality;
  return {
    ...DEFAULT_CONFIG,
    email: typeof raw.email === 'string' ? raw.email.trim() : '',
    // Never trimmed: a password may legitimately start or end with a space.
    password: typeof raw.password === 'string' ? raw.password : '',
    region,
    cloud_url: CLOUD_ENDPOINTS[region],
    // The camera account (RTSP), which is NOT the Tapo account.
    rtsp_username: typeof raw.rtsp_username === 'string' ? raw.rtsp_username.trim() : '',
    rtsp_password: typeof raw.rtsp_password === 'string' ? raw.rtsp_password : '',
    stream_quality: quality,
    rtsp_stream: RTSP_STREAMS[quality],
    event_poll_interval: numberOrDefault(raw.event_poll_interval, 'event_poll_interval'),
    battery_event_poll_interval: numberOrDefault(
      raw.battery_event_poll_interval,
      'battery_event_poll_interval',
    ),
    capture_timeout: numberOrDefault(raw.capture_timeout, 'capture_timeout'),
    image_refresh_interval: numberOrDefault(raw.image_refresh_interval, 'image_refresh_interval'),
    battery_image_refresh_interval: numberOrDefault(
      raw.battery_image_refresh_interval,
      'battery_image_refresh_interval',
    ),
    battery_pause_refresh: numberOrDefault(raw.battery_pause_refresh, 'battery_pause_refresh'),
    battery_stop_all: numberOrDefault(raw.battery_stop_all, 'battery_stop_all'),
    battery_resume: numberOrDefault(raw.battery_resume, 'battery_resume'),
    camera_ips: parseCameraIps(raw.camera_ips),
    camera_accounts: parseCameraAccounts(raw.camera_accounts),
  };
}

/**
 * Tell whether the Tapo account is filled in. Everything else (discovery, image
 * capture) depends on it, so it is worth checking before any cloud call.
 * @param {object} config - The normalized configuration.
 * @returns {boolean} True when the integration can talk to the cloud.
 * @example
 * isConfigured(config);
 */
export function isConfigured(config) {
  return Boolean(config.email && config.password);
}

/**
 * Resolve the camera account to use for one camera.
 *
 * The Tapo app creates that account per camera, so the per-camera entry wins;
 * the global fields act as the default for users who reused the same credentials
 * on every camera.
 * @param {object} config - The normalized configuration.
 * @param {string} cameraName - The camera name, as the cloud reports it.
 * @returns {{ username: string, password: string }} The account, possibly empty.
 * @example
 * resolveRtspAccount(config, 'Camera_jardin');
 */
export function resolveRtspAccount(config, cameraName) {
  const specific = config.camera_accounts[String(cameraName || '').toLowerCase()];
  if (specific) {
    return specific;
  }
  return { username: config.rtsp_username, password: config.rtsp_password };
}

/**
 * Tell whether a camera has usable RTSP credentials. Without them, an RTSP
 * camera cannot be captured — the proprietary protocol is the only fallback.
 * @param {object} config - The normalized configuration.
 * @param {string} [cameraName] - The camera name; omit to test the global account.
 * @returns {boolean} True when RTSP capture is possible.
 * @example
 * hasRtspAccount(config, 'Camera_jardin');
 */
export function hasRtspAccount(config, cameraName) {
  const account = resolveRtspAccount(config, cameraName);
  return Boolean(account.username && account.password);
}
