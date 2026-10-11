// -----------------------------------------------------------------------------
// Integration configuration.
//
// The user-facing values come from the `config_schema` of the manifest; the SDK
// fetches them (`gladys.getConfig()`) and notifies changes through
// `gladys.onConfigUpdated()`.
//
// This module provides the defaults, normalizes the received object (a numeric
// field arrives as a string from the form), and parses the free-text fields the
// manifest cannot express structurally (manual addresses and camera accounts).
//
// Two more keys live OUTSIDE the schema, written by the configuration actions
// rather than typed by the user (the spec allows an integration free storage
// under keys the schema does not declare): `device_addresses` and
// `camera_account_store`. Both are JSON objects keyed by the CLOUD DEVICE ID —
// the one identifier that survives a rename in Gladys, a rename in the Tapo app
// and an IP change — which is what makes them more robust than the text fields.
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
  // seconds, between two reads of the plugs, lights and hub sensors. Short on
  // purpose: these devices push nothing, so a button press or a door opening
  // reaches Gladys at the next read.
  device_poll_interval: 5,
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
 * Reduce a device name to what a person means by it.
 *
 * Names reach this code from three places that spell them differently: the
 * cloud alias (sometimes in decomposed Unicode, "e" + combining accent), what
 * the user typed (composed "é", maybe another case, spaces where the app shows
 * underscores) and the Gladys device name. Comparing them raw is how an
 * address typed for "Tapo_C230_Salon" could fail to match the camera of the
 * same name. Case, accents, and runs of spaces, underscores and dashes are not
 * what tells two devices apart.
 * @param {unknown} name - The name.
 * @returns {string} The comparable form.
 * @example
 * normalizeName('Tapo_C660  Façade'); // 'tapo c660 facade'
 */
export function normalizeName(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .trim();
}

/**
 * Normalize a MAC address to twelve uppercase hex digits, or null.
 * @param {unknown} value - The candidate.
 * @returns {string|null} The MAC, or null when the value is not one.
 * @example
 * macKey('28:ee:52:00:00:01'); // '28EE52000001'
 */
function macKey(value) {
  const text = String(value ?? '').trim();
  if (!/^[0-9a-f]{2}([-:]?[0-9a-f]{2}){5}$/i.test(text)) {
    return null;
  }
  return text.replace(/[-:]/g, '').toUpperCase();
}

/**
 * Parse the "manual addresses" field: `name|ip` entries, separated by commas
 * (or new lines).
 *
 * `=` is accepted as well as `|`, since it is what people reach for. The left
 * side may be the device name (compared through `normalizeName`), its cloud
 * device id, or its MAC address. Keys are stored in their comparable form;
 * a MAC under `mac:<HEX>`.
 * @param {unknown} raw - The raw field value.
 * @returns {Record<string, string>} IPs indexed by comparable key.
 * @example
 * parseCameraIps('Sonnette|192.168.1.42'); // { sonnette: '192.168.1.42' }
 */
export function parseCameraIps(raw) {
  /** @type {Record<string, string>} */
  const ips = {};
  splitEntries(raw).forEach((line) => {
    // Only the FIRST separator splits: splitting on all of them would silently
    // truncate a malformed entry instead of ignoring it.
    const separator = line.search(/[|=]/);
    if (separator <= 0) {
      return;
    }
    const left = line.slice(0, separator).trim();
    const ip = line.slice(separator + 1).trim();
    if (!left || !ip) {
      return;
    }
    const mac = macKey(left);
    ips[mac ? `mac:${mac}` : normalizeName(left)] = ip;
  });
  return ips;
}

/**
 * Find the address the user entered for one device, in the action store first,
 * then in the manual field.
 * @param {object} config - The normalized configuration.
 * @param {object} device - What is known of the device.
 * @param {string} [device.cloudDeviceId] - The cloud device id.
 * @param {string} [device.name] - Its name (cloud or Gladys).
 * @param {string} [device.mac] - Its MAC address.
 * @returns {string} The address, or '' when none was entered.
 * @example
 * manualAddressFor(config, { cloudDeviceId: '8022...', name: 'Salon' });
 */
export function manualAddressFor(config, { cloudDeviceId, name, mac } = {}) {
  const id = String(cloudDeviceId || '').toUpperCase();
  if (id && config.device_addresses?.[id]) {
    return config.device_addresses[id];
  }
  const ips = config.camera_ips || {};
  const macEntry = mac ? ips[`mac:${macKey(mac) || ''}`] : undefined;
  return (id && ips[normalizeName(id)]) || macEntry || (name && ips[normalizeName(name)]) || '';
}

/**
 * Parse one of the off-schema JSON stores, tolerating anything unusable.
 * @param {unknown} raw - The stored value (a JSON string, or already an object).
 * @returns {Record<string, any>} The object, empty when unreadable.
 * @example
 * parseStore('{"ID1":"192.168.1.2"}');
 */
export function parseStore(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw !== 'string' || !raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
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
 * comma, which separates the entries, nor start or end with a space, since each
 * entry is trimmed — the "Save a camera account" action stores any password
 * as is, and is the way to go for those.
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
    const name = normalizeName(line.slice(0, first));
    const username = line.slice(first + 1, second).trim();
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
    device_poll_interval: numberOrDefault(raw.device_poll_interval, 'device_poll_interval'),
    camera_ips: parseCameraIps(raw.camera_ips),
    camera_accounts: parseCameraAccounts(raw.camera_accounts),
    // Written by the actions, keyed by cloud device id (see the header).
    device_addresses: upperKeys(parseStore(raw.device_addresses)),
    camera_account_store: upperKeys(parseStore(raw.camera_account_store)),
  };
}

/**
 * Upper-case the keys of a store, so a cloud device id matches whatever case
 * it was written in.
 * @param {Record<string, any>} store - The store.
 * @returns {Record<string, any>} The same entries, keys upper-cased.
 * @example
 * upperKeys({ abc: 1 }); // { ABC: 1 }
 */
function upperKeys(store) {
  return Object.fromEntries(
    Object.entries(store).map(([key, value]) => [key.toUpperCase(), value]),
  );
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
 * The Tapo app creates that account per camera, so a per-camera entry wins: the
 * one saved through the action (keyed by cloud device id, so a renamed camera
 * keeps it), then the manual field (by name or id). The global fields act as the
 * default for users who reused the same credentials on every camera.
 * @param {object} config - The normalized configuration.
 * @param {string|{ name?: string, cloudDeviceId?: string }} camera - The camera,
 * or just its name.
 * @returns {{ username: string, password: string }} The account, possibly empty.
 * @example
 * resolveRtspAccount(config, { name: 'Camera_jardin', cloudDeviceId: '8022...' });
 */
export function resolveRtspAccount(config, camera) {
  const { name, cloudDeviceId } = typeof camera === 'object' && camera ? camera : { name: camera };
  const id = String(cloudDeviceId || '').toUpperCase();
  const stored = id ? config.camera_account_store?.[id] : null;
  if (stored && stored.username && stored.password) {
    return { username: stored.username, password: stored.password };
  }
  const accounts = config.camera_accounts || {};
  const specific = (id && accounts[normalizeName(id)]) || accounts[normalizeName(name)];
  if (specific) {
    return specific;
  }
  return { username: config.rtsp_username, password: config.rtsp_password };
}

/**
 * Tell whether a camera has usable RTSP credentials. Without them, an RTSP
 * camera cannot be captured — the proprietary protocol is the only fallback.
 * @param {object} config - The normalized configuration.
 * @param {string|object} [camera] - The camera (or its name); omit to test the
 * global account.
 * @returns {boolean} True when RTSP capture is possible.
 * @example
 * hasRtspAccount(config, camera);
 */
export function hasRtspAccount(config, camera) {
  const account = resolveRtspAccount(config, camera);
  return Boolean(account.username && account.password);
}
