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
