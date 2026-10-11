import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  buildDiscoveryRequest,
  parseDiscoveryReply,
  discoverDevices,
  forgetLastScan,
  normalizeMac,
} from '../src/tapo/discovery.js';
import { buildDiscoveredDevices, buildDevice, getParam } from '../src/devices.js';
import { normalizeConfig } from '../src/config.js';
import { DEVICE_PARAMS } from '../src/tapo/constants.js';
import { fakeGladys } from './helpers/fakeGladys.js';

/**
 * A discovery reply shaped like a real one — fields copied from python-kasa's
 * capture of a C200 (`tests/fixtures/smartcam/C200_1.0_1.3.17.json`). Note the
 * `device_id`: 32 hex characters, a hash, NOT the 40-character id the cloud
 * lists. The MAC is the only identifier both sides state in clear.
 * @param {object} [overrides] - Fields to change.
 * @returns {string} The base64 payload, as the core relays it.
 * @example
 * realReply({ mac: '28-EE-52-00-00-02' });
 */
function realReply(overrides = {}) {
  const header = Buffer.alloc(16);
  const body = Buffer.from(
    JSON.stringify({
      error_code: 0,
      result: {
        device_id: '00000000000000000000000000000000',
        device_model: 'C200',
        device_type: 'SMART.IPCAMERA',
        ip: '127.0.0.123',
        mac: '28-EE-52-00-00-01',
        mgt_encrypt_schm: { is_support_https: true },
        encrypt_type: ['3'],
        protocol_version: 1,
        ...overrides,
      },
    }),
  );
  return Buffer.concat([header, body]).toString('base64');
}

const CLOUD_ID = '8022ABCDEF0123456789ABCDEF0123456789ABCD';

beforeEach(() => {
  forgetLastScan();
});

test('the probe is a well-formed TDP packet the core agrees to send', () => {
  // The first version sent the magic and sixteen zero bytes: no size, no CRC,
  // no key — which recent firmwares ignore.
  const probe = buildDiscoveryRequest();
  assert.ok(probe.length <= 512, 'the core refuses a payload past 512 bytes');
  assert.equal(probe.readUInt8(0), 2, 'TDP version');
  assert.equal(probe.readUInt16BE(2), 1, 'probe op code');
  assert.equal(probe.readUInt16BE(4), probe.length - 16, 'payload size');
  assert.equal(probe.readUInt8(6), 17, 'flags');

  const body = JSON.parse(probe.subarray(16).toString());
  assert.match(body.params.rsa_key, /BEGIN PUBLIC KEY/);

  // The CRC is computed with the magic 0x5A6B7C8D in its own slot.
  const check = Buffer.from(probe);
  const crc = check.readUInt32BE(12);
  check.writeUInt32BE(0x5a6b7c8d, 12);
  assert.equal(zlib.crc32(check) >>> 0, crc);
});

test('a real reply is read: MAC, model and type', () => {
  const parsed = parseDiscoveryReply(Buffer.from(realReply(), 'base64'));
  assert.equal(parsed.mac, '28EE52000001');
  assert.equal(parsed.model, 'C200');
  assert.equal(parsed.deviceType, 'SMART.IPCAMERA');
  assert.equal(parsed.https, true);
});

test('a model announced with its region is reduced to the reference', () => {
  const parsed = parseDiscoveryReply(
    Buffer.from(realReply({ device_model: 'C210(EU)' }), 'base64'),
  );
  assert.equal(parsed.model, 'C210');
});

test('an unreadable reply yields nothing rather than a guess', () => {
  assert.equal(parseDiscoveryReply(Buffer.from('garbage')), null);
});

test('MAC spellings are normalized to the same key', () => {
  assert.equal(normalizeMac('28-ee-52-00-00-01'), '28EE52000001');
  assert.equal(normalizeMac('28:EE:52:00:00:01'), '28EE52000001');
  assert.equal(normalizeMac('28EE52000001'), '28EE52000001');
  assert.equal(normalizeMac('not a mac'), null);
});

test('a camera is located by its MAC, whatever its announced id', async () => {
  const gladys = fakeGladys({
    scanResults: [{ source_ip: '192.168.1.42', payload_base64: realReply() }],
  });
  const config = normalizeConfig({ email: 'a@b.c', password: 'x' });
  const devices = await buildDiscoveredDevices(
    gladys,
    [{ cloudDeviceId: CLOUD_ID, name: 'Jardin', model: 'C200', ip: '', mac: '28EE52000001' }],
    config,
  );
  assert.equal(getParam(devices[0], DEVICE_PARAMS.IP), '192.168.1.42');
  assert.equal(getParam(devices[0], DEVICE_PARAMS.IP_SOURCE), 'scan');
  assert.equal(getParam(devices[0], DEVICE_PARAMS.MAC), '28EE52000001');
});

test('an address entered by the user wins over the scan', async () => {
  const gladys = fakeGladys({
    scanResults: [{ source_ip: '192.168.1.42', payload_base64: realReply() }],
  });
  const config = normalizeConfig({
    email: 'a@b.c',
    password: 'x',
    device_addresses: JSON.stringify({ [CLOUD_ID]: '10.0.0.5' }),
  });
  const devices = await buildDiscoveredDevices(
    gladys,
    [{ cloudDeviceId: CLOUD_ID, name: 'Jardin', model: 'C200', ip: '', mac: '28EE52000001' }],
    config,
  );
  assert.equal(getParam(devices[0], DEVICE_PARAMS.IP), '10.0.0.5');
  assert.equal(getParam(devices[0], DEVICE_PARAMS.IP_SOURCE), 'manual');
});

test('a failed scan keeps the address the device already had', async () => {
  // Measured on a user setup: the scan answered 429, and the re-publish blanked
  // the address of every camera — TAPO_CAMERA_IP_UNKNOWN on all of them.
  const config = normalizeConfig({ email: 'a@b.c', password: 'x' });
  const probe = fakeGladys();
  const existing = buildDevice(probe, {
    cloudDeviceId: CLOUD_ID,
    name: 'Jardin',
    model: 'C200',
    ip: '192.168.1.42',
    ipSource: 'scan',
  });
  const gladys = fakeGladys({
    devices: [existing],
    scanResults: Object.assign(new Error('Too Many Requests'), { status: 429 }),
  });
  const devices = await buildDiscoveredDevices(
    gladys,
    [{ cloudDeviceId: CLOUD_ID, name: 'Jardin', model: 'C200', ip: '', mac: '28EE52000001' }],
    config,
  );
  assert.equal(getParam(devices[0], DEVICE_PARAMS.IP), '192.168.1.42');
  assert.equal(getParam(devices[0], DEVICE_PARAMS.IP_SOURCE), 'previous');
});

test('a manual address the user removed is not resurrected', async () => {
  const config = normalizeConfig({ email: 'a@b.c', password: 'x' });
  const existing = buildDevice(fakeGladys(), {
    cloudDeviceId: CLOUD_ID,
    name: 'Jardin',
    model: 'C200',
    ip: '10.0.0.5',
    ipSource: 'manual',
  });
  const gladys = fakeGladys({ devices: [existing] });
  const devices = await buildDiscoveredDevices(
    gladys,
    [{ cloudDeviceId: CLOUD_ID, name: 'Jardin', model: 'C200', ip: '' }],
    config,
  );
  assert.equal(getParam(devices[0], DEVICE_PARAMS.IP), '');
});

test('scans close together share one broadcast', async () => {
  let scans = 0;
  const gladys = fakeGladys();
  gladys.scanNetwork = async () => {
    scans += 1;
    return [{ source_ip: '192.168.1.42', payload_base64: realReply() }];
  };
  await Promise.all([discoverDevices(gladys), discoverDevices(gladys)]);
  await discoverDevices(gladys);
  assert.equal(scans, 1);
});

test('an expired cache still backs a refused scan', async () => {
  const gladys = fakeGladys();
  gladys.scanNetwork = async () => [{ source_ip: '192.168.1.42', payload_base64: realReply() }];
  const realNow = Date.now;
  try {
    await discoverDevices(gladys);
    Date.now = () => realNow() + 10 * 60 * 1000;
    gladys.scanNetwork = async () => {
      throw Object.assign(new Error('Too Many Requests'), { status: 429 });
    };
    const found = await discoverDevices(gladys);
    assert.equal(found.length, 1);
    assert.equal(found[0].ip, '192.168.1.42');
  } finally {
    Date.now = realNow;
  }
});
