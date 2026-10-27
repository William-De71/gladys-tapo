import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SmartClient, SmartError } from '../src/smart/client.js';
import { KlapTransport } from '../src/smart/klap.js';
import { AesTransport } from '../src/smart/aes.js';
import { parseCookies } from '../src/smart/http.js';
import { deviceState, startKlapDevice, startAesDevice } from './helpers/fakeSmartDevice.js';

const ACCOUNT = { username: 'me@example.com', password: 'S3cret!' };

test('a KLAP v2 device is read and switched over real HTTP', async () => {
  const state = deviceState({ info: { device_on: false, model: 'P100' } });
  const device = await startKlapDevice({ ...ACCOUNT, version: 2, state });
  try {
    const client = new SmartClient({ ip: '127.0.0.1', httpPort: device.port, ...ACCOUNT });
    assert.equal((await client.request('get_device_info')).device_on, false);
    await client.request('set_device_info', { device_on: true });
    assert.equal(state.info.device_on, true);
    assert.equal(device.stats.handshakes, 1, 'one session for several requests');
  } finally {
    await device.close();
  }
});

test('a KLAP v1 firmware is recognized from its handshake, with no prior hint', async () => {
  const state = deviceState({ info: { device_on: true } });
  const device = await startKlapDevice({ ...ACCOUNT, version: 1, state });
  try {
    const transport = new KlapTransport({ ip: '127.0.0.1', port: device.port, ...ACCOUNT });
    const answer = await transport.send({ method: 'get_device_info' });
    assert.equal(answer.result.device_on, true);
    assert.equal(transport.version, 1);
  } finally {
    await device.close();
  }
});

test('a device bound to another account is refused locally, before any login', async () => {
  const state = deviceState({ info: {} });
  const device = await startKlapDevice({ username: 'other@example.com', password: 'x', state });
  try {
    const client = new SmartClient({ ip: '127.0.0.1', httpPort: device.port, ...ACCOUNT });
    await assert.rejects(() => client.request('get_device_info'), /BAD_CREDENTIALS/);
    // And left alone afterwards: retrying cannot fix a wrong password.
    await assert.rejects(() => client.request('get_device_info'), /TAPO_SMART_BACKOFF/);
    assert.equal(device.stats.handshakes, 1);
  } finally {
    await device.close();
  }
});

test('a firmware with Third-Party Compatibility off is told apart from a wrong account', async () => {
  const state = deviceState({ info: {} });
  const device = await startKlapDevice({ ...ACCOUNT, state, thirdPartyOff: true });
  try {
    const client = new SmartClient({ ip: '127.0.0.1', httpPort: device.port, ...ACCOUNT });
    await assert.rejects(
      () => client.request('get_device_info'),
      (e) => e.thirdPartyRefused === true && !e.authFailed && /HANDSHAKE1_HTTP_403/.test(e.message),
    );
    // Not a protocol to fall back from, and nothing a retry would fix by itself.
    assert.equal(client.encryptType, null);
  } finally {
    await device.close();
  }
});

test('a device answering with the built-in test account is still reached', async () => {
  // A known firmware quirk: devices intermittently answer with the Tapo app's
  // built-in account instead of the user's.
  const state = deviceState({ info: { device_on: true } });
  const device = await startKlapDevice({
    username: 'test@tp-link.net',
    password: 'test',
    state,
  });
  try {
    const client = new SmartClient({ ip: '127.0.0.1', httpPort: device.port, ...ACCOUNT });
    assert.equal((await client.request('get_device_info')).device_on, true);
  } finally {
    await device.close();
  }
});

test('a session the device dropped is reopened once, transparently', async () => {
  const state = deviceState({ info: { device_on: true } });
  const device = await startKlapDevice({ ...ACCOUNT, state });
  try {
    const client = new SmartClient({ ip: '127.0.0.1', httpPort: device.port, ...ACCOUNT });
    await client.request('get_device_info');
    device.dropSession();
    assert.equal((await client.request('get_device_info')).device_on, true);
    assert.equal(device.stats.handshakes, 2);
  } finally {
    await device.close();
  }
});

test('an older firmware is reached over securePassthrough, found by trying', async () => {
  // It answers 404 to KLAP: the client falls back on its own.
  const state = deviceState({ info: { device_on: false, model: 'P110' } });
  const device = await startAesDevice({ ...ACCOUNT, loginVersion: 2, state });
  try {
    const client = new SmartClient({ ip: '127.0.0.1', httpPort: device.port, ...ACCOUNT });
    assert.equal((await client.request('get_device_info')).model, 'P110');
    await client.request('set_device_info', { device_on: true });
    assert.equal(state.info.device_on, true);
    assert.equal(client.encryptType, 'AES');
  } finally {
    await device.close();
  }
});

test('the securePassthrough login version is found when not announced', async () => {
  const state = deviceState({ info: { device_on: true } });
  const device = await startAesDevice({ ...ACCOUNT, loginVersion: 1, state });
  try {
    const transport = new AesTransport({ ip: '127.0.0.1', port: device.port, ...ACCOUNT });
    const answer = await transport.send({ method: 'get_device_info' });
    assert.equal(answer.result.device_on, true);
    assert.equal(transport.loginVersion, 1);
  } finally {
    await device.close();
  }
});

test('a refused securePassthrough login is reported as a credentials problem', async () => {
  const state = deviceState({ info: {} });
  const device = await startAesDevice({ username: 'other@example.com', password: 'x', state });
  try {
    const client = new SmartClient({
      ip: '127.0.0.1',
      httpPort: device.port,
      encryptType: 'AES',
      loginVersion: 2,
      ...ACCOUNT,
    });
    await assert.rejects(
      () => client.request('get_device_info'),
      (e) => e.authFailed === true,
    );
  } finally {
    await device.close();
  }
});

test('several methods go out as one multipleRequest, a refused one apart', async () => {
  const state = deviceState({ info: { device_on: true } });
  const device = await startKlapDevice({ ...ACCOUNT, state });
  try {
    const client = new SmartClient({ ip: '127.0.0.1', httpPort: device.port, ...ACCOUNT });
    const results = await client.multiple([
      { method: 'get_device_info' },
      { method: 'get_energy_usage' },
    ]);
    assert.equal(results.get_device_info.device_on, true);
    assert.ok(results.get_energy_usage instanceof SmartError, 'unsupported, not fatal');
  } finally {
    await device.close();
  }
});

test('a socket of a power strip is driven through control_child', async () => {
  const state = deviceState({
    info: { model: 'P300' },
    children: [{ device_id: 'SOCKET1', info: { device_on: false, position: 1 } }],
  });
  const device = await startKlapDevice({ ...ACCOUNT, state });
  try {
    const client = new SmartClient({ ip: '127.0.0.1', httpPort: device.port, ...ACCOUNT });
    const children = await client.getChildren();
    assert.equal(children.length, 1);
    await client.childRequest('SOCKET1', 'set_device_info', { device_on: true });
    assert.equal(state.children[0].entry.device_on, true);
  } finally {
    await device.close();
  }
});

test('a device that is off costs one timeout, then a pause', async () => {
  // Port 9 on localhost: refused at once, which reads as unreachable.
  const client = new SmartClient({ ip: '127.0.0.1', httpPort: 9, ...ACCOUNT });
  await assert.rejects(() => client.request('get_device_info'));
  await assert.rejects(() => client.request('get_device_info'), /TAPO_SMART_BACKOFF/);
});

test('cookies are read whether split across lines or packed on one', () => {
  assert.deepEqual(parseCookies(['TP_SESSIONID=ABC;TIMEOUT=86400']), {
    TP_SESSIONID: 'ABC',
    TIMEOUT: '86400',
  });
  assert.deepEqual(parseCookies(['TP_SESSIONID=ABC; Path=/', 'TIMEOUT=60']), {
    TP_SESSIONID: 'ABC',
    TIMEOUT: '60',
  });
});
