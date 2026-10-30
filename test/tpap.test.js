import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SmartClient } from '../src/smart/client.js';
import {
  TpapCipher,
  TpapTransport,
  credentialFor,
  decodePoint,
  deriveW0W1,
  prove,
  readTpapInfo,
  scalarFromWide,
} from '../src/smart/tpap.js';
import { deviceState, startTpapDevice, startKlapDevice } from './helpers/fakeSmartDevice.js';

const ACCOUNT = { username: 'me@example.com', password: 'S3cret!' };

const hex = (value) => Buffer.from(value, 'hex');

test('the SPAKE2+ prover matches the RFC 9383 P-256 test vector', () => {
  const proof = prove({
    w0: scalarFromWide(hex('bb8e1bbcf3c48f62c08db243652ae55d3e5586053fca77102994f23ad95491b3')),
    w1: scalarFromWide(hex('7e945f34d78785b8a3ef44d0df5a1a97d6b3b460409a345ca7830387a74b1dba')),
    x: scalarFromWide(hex('d1232c8e8693d02368976c174e2088851b8365d0d79a9eee709c6a05a2fad539')),
    context: Buffer.from('SPAKE2+-P256-SHA256-HKDF-SHA256-HMAC-SHA256 Test Vectors'),
    proverIdentity: Buffer.from('client'),
    verifierIdentity: Buffer.from('server'),
    verifierShare: hex(
      '04c0f65da0d11927bdf5d560c69e1d7d939a05b0e88291887d679fcadea75810fb' +
        '5cc1ca7494db39e82ff2f50665255d76173e09986ab46742c798a9a68437b048',
    ),
  });
  assert.equal(
    proof.share.toString('hex'),
    '04ef3bd051bf78a2234ec0df197f7828060fe9856503579bb1733009042c15c0c1' +
      'de127727f418b5966afadfdd95a6e4591d171056b333dab97a79c7193e341727',
  );
  assert.equal(
    proof.confirm.toString('hex'),
    '926cc713504b9b4d76c9162ded04b5493e89109f6d89462cd33adc46fda27527',
  );
  assert.equal(
    proof.sharedKey.toString('hex'),
    '0c5f8ccd1413423a54f6c1fb26ff01534a87f893779c6e68666d772bfd91f3e7',
  );
  assert.equal(
    proof.verifierConfirmKey.toString('hex'),
    'ccd53c7c1fa37b64a462b40db8be101cedcf838950162902054e644b400f1680',
  );
  assert.ok(proof.verify(hex('9747bcc4f8fe9f63defee53ac9b07876d907d55047e6ff2def2e7529089d3e68')));
  assert.ok(!proof.verify(proof.confirm));
});

test('a device share that is not on the curve is refused', () => {
  const share = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 1)]);
  assert.equal(decodePoint(share), null);
  assert.throws(
    () => prove({ w0: 1n, w1: 1n, x: 1n, context: Buffer.alloc(32), verifierShare: share }),
    /BAD_DEVICE_SHARE/,
  );
});

test('scalars are reduced modulo the group order', () => {
  const order = 'ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551';
  assert.equal(scalarFromWide(hex('05')), 5n);
  assert.equal(scalarFromWide(hex(order)), 0n);
  assert.equal(
    scalarFromWide(hex('ff'.repeat(40))).toString(16),
    'fffffffe00000001431905529c0166cd22159165b6faae70f756a571fc632550',
  );
});

test('the password scalars and the credential match the reference implementation', async () => {
  const credential = credentialFor('hunter2', {
    type: 'password_shadow',
    params: { passwd_id: 2 },
  });
  assert.equal(credential, 'f3bbbd66a63d4bf1747940578ec3d0103530e21d');
  const { w0, w1 } = await deriveW0W1(credential, Buffer.from('0123456789abcdef'), 3000);
  assert.equal(w0.toString(16), 'f01588c03f935783a7c530a83ab1ade1a3261b13005521b6946dc5c7ad259f2c');
  assert.equal(w1.toString(16), 'de9bd4a17ba3b23e2a26fbf5ae94010c68f5e0e34388fe6ec227fcb45bd0b42e');
  assert.throws(
    () => credentialFor('hunter2', { type: 'password_shadow', params: { passwd_id: 3 } }),
    (e) => e.unsupportedProtocol === true && /passwd_id/.test(e.message),
  );
  assert.throws(
    () => credentialFor('hunter2', null),
    (e) => e.unsupportedProtocol === true,
  );
});

test('the session cipher matches a known answer and checks the sequence', () => {
  const sharedKey = Buffer.from([...Array(32).keys()]);
  const message = Buffer.from('{"method":"get_device_info"}');
  const { body, seq } = new TpapCipher(sharedKey, 0x01020304).encrypt(message);
  assert.equal(seq, 0x01020304);
  assert.equal(
    body.toString('hex'),
    '01020304c0331c1c36a5df4ce0c68e5a27b2667ebf842dc994a3fd24b9e860a60fab76d4' +
      'b66b9b669d95cca10c012f13',
  );
  const cipher = new TpapCipher(sharedKey, 2 ** 31 - 1);
  const first = cipher.encrypt(message);
  const second = cipher.encrypt(message);
  assert.equal(second.seq, -(2 ** 31), 'the counter wraps like a signed 32-bit integer');
  assert.deepEqual(cipher.decrypt(first.body, first.seq), message);
  assert.throws(() => cipher.decrypt(first.body, second.seq), /WRONG_SEQUENCE/);
  assert.throws(() => cipher.decrypt(Buffer.alloc(19), 0), /SHORT_ANSWER/);
});

test('an announcement without a port cannot be read', () => {
  assert.throws(
    () => readTpapInfo({ tls: 0, pake: [2] }),
    (e) => e.unsupportedProtocol,
  );
  assert.deepEqual(readTpapInfo({ tls: 0, pake: [2], port: 80 }), {
    port: 80,
    tls: 0,
    pake: [2],
  });
});

test('a device turning KLAP down with a 403 is reached over TPAP, with no prior hint', async () => {
  const state = deviceState({ info: { device_on: false, model: 'L530' } });
  const device = await startTpapDevice({ password: ACCOUNT.password, state });
  try {
    const client = new SmartClient({ ip: '127.0.0.1', httpPort: device.port, ...ACCOUNT });
    assert.equal((await client.request('get_device_info')).device_on, false);
    await client.request('set_device_info', { device_on: true });
    assert.equal(state.info.device_on, true);
    assert.equal(client.encryptType, 'TPAP');
    assert.equal(device.stats.klap, 1, 'KLAP tried once, never again');
    assert.equal(device.stats.shares, 1, 'one login for several requests');
  } finally {
    await device.close();
  }
});

test('a device announced as TPAP by the scan is logged in to directly', async () => {
  const state = deviceState({ info: { device_on: true } });
  const device = await startTpapDevice({ password: ACCOUNT.password, state });
  try {
    const client = new SmartClient({
      ip: '127.0.0.1',
      httpPort: device.port,
      encryptType: 'TPAP',
      ...ACCOUNT,
    });
    const results = await client.multiple([{ method: 'get_device_info' }, { method: 'nope' }]);
    assert.equal(results.get_device_info.device_on, true);
    assert.equal(results.nope.code, -1);
    assert.equal(device.stats.klap, 0);
  } finally {
    await device.close();
  }
});

test('a wrong password over TPAP is a credentials problem, then left alone', async () => {
  const state = deviceState({ info: {} });
  const device = await startTpapDevice({ password: 'another one', state });
  try {
    const client = new SmartClient({ ip: '127.0.0.1', httpPort: device.port, ...ACCOUNT });
    await assert.rejects(
      () => client.request('get_device_info'),
      (e) => e.authFailed === true && /BAD_CREDENTIALS/.test(e.message),
    );
    await assert.rejects(() => client.request('get_device_info'), /TAPO_SMART_BACKOFF/);
    assert.equal(device.stats.shares, 1);
  } finally {
    await device.close();
  }
});

test('a TPAP session the device dropped is reopened once, transparently', async () => {
  const state = deviceState({ info: { device_on: true } });
  const device = await startTpapDevice({ password: ACCOUNT.password, state });
  try {
    const client = new SmartClient({
      ip: '127.0.0.1',
      httpPort: device.port,
      encryptType: 'TPAP',
      ...ACCOUNT,
    });
    await client.request('get_device_info');
    device.dropSession();
    assert.equal((await client.request('get_device_info')).device_on, true);
    assert.equal(device.stats.shares, 2);
  } finally {
    await device.close();
  }
});

test('a TPAP login this integration cannot do is reported as unsupported', async () => {
  const state = deviceState({ info: {} });
  const device = await startTpapDevice({
    password: ACCOUNT.password,
    state,
    tpap: { tls: 0, pake: [0, 2] },
  });
  try {
    const transport = new TpapTransport({ ip: '127.0.0.1', port: device.port, ...ACCOUNT });
    await assert.rejects(
      () => transport.send({ method: 'get_device_info' }),
      (e) => e.unsupportedProtocol === true && !e.authFailed,
    );
    assert.equal(device.stats.registers, 0, 'nothing that could count as a failed login');
  } finally {
    await device.close();
  }
});

test('a device announced as TPAP but back on KLAP is reached over KLAP', async () => {
  const state = deviceState({ info: { device_on: true } });
  const device = await startKlapDevice({ ...ACCOUNT, state });
  try {
    const client = new SmartClient({
      ip: '127.0.0.1',
      httpPort: device.port,
      encryptType: 'TPAP',
      ...ACCOUNT,
    });
    assert.equal((await client.request('get_device_info')).device_on, true);
    assert.equal(client.encryptType, 'KLAP');
  } finally {
    await device.close();
  }
});
