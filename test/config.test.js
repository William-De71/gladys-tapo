import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeConfig,
  parseCameraIps,
  parseCameraAccounts,
  isConfigured,
  hasRtspAccount,
  resolveRtspAccount,
  DEFAULT_CONFIG,
} from '../src/config.js';
import { BATTERY_EVENT_POLL_INTERVAL } from '../src/tapo/constants.js';

test('an empty config falls back to the defaults', () => {
  const config = normalizeConfig();
  assert.equal(config.region, DEFAULT_CONFIG.region);
  assert.equal(config.event_poll_interval, DEFAULT_CONFIG.event_poll_interval);
  assert.equal(config.capture_timeout, DEFAULT_CONFIG.capture_timeout);
  assert.equal(config.email, '');
  assert.deepEqual(config.camera_ips, {});
});

test('a numeric field arriving as a string from the form is coerced', () => {
  // The config form posts strings; a string interval would break setInterval.
  const config = normalizeConfig({ event_poll_interval: '45', capture_timeout: '9' });
  assert.equal(config.event_poll_interval, 45);
  assert.equal(config.capture_timeout, 9);
});

test('the region resolves to its cloud endpoint, unknown values fall back', () => {
  assert.match(normalizeConfig({ region: 'america' }).cloud_url, /use1-wap/);
  assert.match(normalizeConfig({ region: 'not-a-region' }).cloud_url, /eu-wap/);
});

test('the quality selects the matching RTSP stream', () => {
  // Tapo names them stream1 (HD) and stream2 (SD); mixing them up silently
  // captures the wrong resolution.
  assert.equal(normalizeConfig({ stream_quality: 'HD' }).rtsp_stream, 'stream1');
  assert.equal(normalizeConfig({ stream_quality: 'SD' }).rtsp_stream, 'stream2');
});

test('the email is trimmed but the passwords are left untouched', () => {
  // A password may legitimately begin or end with a space; trimming it would
  // make the login fail for reasons the user cannot see.
  const config = normalizeConfig({
    email: '  me@example.com  ',
    password: ' secret ',
    rtsp_password: ' rtsp ',
  });
  assert.equal(config.email, 'me@example.com');
  assert.equal(config.password, ' secret ');
  assert.equal(config.rtsp_password, ' rtsp ');
});

test('the camera addresses are parsed and indexed lower-cased', () => {
  const ips = parseCameraIps('Sonnette|192.168.1.42\n\n Garden | 192.168.1.43 ');
  assert.deepEqual(ips, { sonnette: '192.168.1.42', garden: '192.168.1.43' });
});

test('a malformed address line is ignored, not truncated', () => {
  // Dropping the entry is safe; keeping half of it would point at a wrong host.
  assert.deepEqual(parseCameraIps('no-separator\n|192.168.1.1\nname|'), {});
});

test('the configuration guards tell what the integration can do', () => {
  assert.equal(isConfigured(normalizeConfig({ email: 'a@b.c', password: 'x' })), true);
  assert.equal(isConfigured(normalizeConfig({ email: 'a@b.c' })), false);
  assert.equal(hasRtspAccount(normalizeConfig({ rtsp_username: 'u', rtsp_password: 'p' })), true);
  assert.equal(hasRtspAccount(normalizeConfig({ rtsp_username: 'u' })), false);
});

test('the camera accounts are parsed per camera', () => {
  // The Tapo app creates that account PER CAMERA, so a single global pair only
  // fits users who reused the same credentials everywhere.
  const accounts = parseCameraAccounts('Camera_jardin|gladys|secret\n Salon | user2 | pass2');
  assert.deepEqual(accounts.camera_jardin, { username: 'gladys', password: 'secret' });
  // The password keeps its leading space (only the whole line was trimmed): a
  // password is taken verbatim, unlike the name and the username.
  assert.deepEqual(accounts.salon, { username: 'user2', password: ' pass2' });
});

test('a password containing a pipe survives the parsing', () => {
  // Only the first two separators split; the rest of the line is the password.
  const accounts = parseCameraAccounts('jardin|user|p@ss|word');
  assert.equal(accounts.jardin.password, 'p@ss|word');
});

test('an incomplete account line is ignored', () => {
  assert.deepEqual(parseCameraAccounts('jardin|user\nno-separator\njardin||pass'), {});
});

test('a per-camera account wins over the default one', () => {
  const config = normalizeConfig({
    rtsp_username: 'default',
    rtsp_password: 'defaultpass',
    camera_accounts: 'Camera_jardin|specific|specificpass',
  });
  assert.deepEqual(resolveRtspAccount(config, 'Camera_jardin'), {
    username: 'specific',
    password: 'specificpass',
  });
  // A camera with no entry falls back to the default pair.
  assert.deepEqual(resolveRtspAccount(config, 'Camera_salon'), {
    username: 'default',
    password: 'defaultpass',
  });
});

test('hasRtspAccount answers per camera', () => {
  const config = normalizeConfig({ camera_accounts: 'jardin|user|pass' });
  // No default account, but this camera has its own.
  assert.equal(hasRtspAccount(config, 'Jardin'), true);
  assert.equal(hasRtspAccount(config, 'Salon'), false);
});

test('entries are separated by a comma, as the single-line input requires', () => {
  // The Gladys config form renders string/secret as a one-line input: a newline
  // cannot be typed there, so the comma is the real-world separator.
  const ips = parseCameraIps('Camera_jardin|192.168.1.42, Camera_salon|192.168.1.43');
  assert.deepEqual(ips, { camera_jardin: '192.168.1.42', camera_salon: '192.168.1.43' });

  const accounts = parseCameraAccounts('jardin|user|pass, salon|user2|pass2');
  assert.deepEqual(Object.keys(accounts), ['jardin', 'salon']);
  assert.equal(accounts.salon.password, 'pass2');
});

test('newlines still work, for a pasted value', () => {
  // Kept on purpose: a value pasted from a note, or a future multi-line field.
  const ips = parseCameraIps('jardin|192.168.1.42\nsalon|192.168.1.43');
  assert.deepEqual(Object.keys(ips), ['jardin', 'salon']);
});

test('accounts survive a serialize/parse round-trip', () => {
  // The "Save a camera account" action rewrites the whole field from the parsed
  // accounts: a lossy round-trip would silently drop the other cameras.
  const accounts = {
    camera_jardin: { username: 'gladys', password: 'p@ss' },
    camera_salon: { username: 'user2', password: 'other' },
  };
  const serialized = Object.entries(accounts)
    .map(([name, account]) => `${name}|${account.username}|${account.password}`)
    .join(', ');
  assert.deepEqual(parseCameraAccounts(serialized), accounts);
});

test('the image refresh interval is configurable, one minute by default', () => {
  // A capture is the most demanding thing asked of a camera, so this is the
  // first knob to turn on a solar model that discharges faster than it refills.
  assert.equal(normalizeConfig().image_refresh_interval, 60);
  assert.equal(normalizeConfig({ image_refresh_interval: '180' }).image_refresh_interval, 180);
});

test('battery cameras have their own refresh interval', () => {
  // The two used to share one setting, so sparing a solar camera also let every
  // wired camera's image go stale. They are unrelated costs.
  const config = normalizeConfig({
    image_refresh_interval: '60',
    battery_image_refresh_interval: '1800',
  });
  assert.equal(config.image_refresh_interval, 60);
  assert.equal(config.battery_image_refresh_interval, 1800);
});

test('the battery refresh interval defaults well above the wired one', () => {
  const config = normalizeConfig();
  assert.ok(
    config.battery_image_refresh_interval > config.image_refresh_interval,
    'a battery camera must not be captured as often as a wired one',
  );
});

test('changing the wired interval leaves the battery one alone', () => {
  const config = normalizeConfig({ image_refresh_interval: '15' });
  assert.equal(
    config.battery_image_refresh_interval,
    DEFAULT_CONFIG.battery_image_refresh_interval,
  );
});

test('a cleared numeric field falls back to its default', () => {
  // `Number('')` is 0: a cleared refresh interval used to become a 0-second
  // loop, and a cleared battery threshold disarmed the protection entirely.
  const config = normalizeConfig({
    image_refresh_interval: '',
    battery_image_refresh_interval: '',
    battery_pause_refresh: '',
    battery_stop_all: '',
    capture_timeout: '',
  });
  assert.equal(config.image_refresh_interval, DEFAULT_CONFIG.image_refresh_interval);
  assert.equal(
    config.battery_image_refresh_interval,
    DEFAULT_CONFIG.battery_image_refresh_interval,
  );
  assert.equal(config.battery_pause_refresh, DEFAULT_CONFIG.battery_pause_refresh);
  assert.equal(config.battery_stop_all, DEFAULT_CONFIG.battery_stop_all);
  assert.equal(config.capture_timeout, DEFAULT_CONFIG.capture_timeout);
});

test('a non-numeric value falls back to its default', () => {
  assert.equal(
    normalizeConfig({ image_refresh_interval: 'soon' }).image_refresh_interval,
    DEFAULT_CONFIG.image_refresh_interval,
  );
});

test('the resume level is configurable', () => {
  assert.equal(normalizeConfig().battery_resume, DEFAULT_CONFIG.battery_resume);
  assert.equal(normalizeConfig({ battery_resume: '90' }).battery_resume, 90);
});

test('the battery poll interval falls back to its default', () => {
  // Battery cameras get their own poll interval for the same reason they get
  // their own refresh interval: the poll wakes the camera far more often than any
  // capture, and the wake-up is what costs the cell.
  const config = normalizeConfig({ email: 'a@b.c', password: 'x' });
  assert.equal(config.battery_event_poll_interval, BATTERY_EVENT_POLL_INTERVAL);
  // Independent of the wired one, which stays short for cameras on mains.
  assert.equal(config.event_poll_interval, 20);

  const custom = normalizeConfig({
    email: 'a@b.c',
    password: 'x',
    battery_event_poll_interval: 900,
  });
  assert.equal(custom.battery_event_poll_interval, 900);

  // An empty field must not become a 0-second interval.
  const blank = normalizeConfig({
    email: 'a@b.c',
    password: 'x',
    battery_event_poll_interval: '',
  });
  assert.equal(blank.battery_event_poll_interval, BATTERY_EVENT_POLL_INTERVAL);
});
