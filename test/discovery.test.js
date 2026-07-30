import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDiscoveryRequest,
  parseDiscoveryReply,
  discoverLocalAddresses,
} from '../src/tapo/discovery.js';
import { buildDiscoveredDevices, getParam } from '../src/devices.js';
import { normalizeConfig } from '../src/config.js';
import { DEVICE_PARAMS } from '../src/tapo/constants.js';
import { fakeGladys } from './helpers/fakeGladys.js';

/**
 * Build a fake discovery reply carrying a device id.
 * @param {string} deviceId - The device id to announce.
 * @param {string} [model] - The model to announce.
 * @returns {string} The base64 payload, as the core relays it.
 * @example
 * fakeReply('AABBCCDDEEFF00112233445566778899');
 */
function fakeReply(deviceId, model = 'C210 1.0') {
  const header = Buffer.alloc(16);
  const body = Buffer.from(
    JSON.stringify({ result: { device_id: deviceId, device_model: model } }),
  );
  return Buffer.concat([header, body]).toString('base64');
}

const DEVICE_ID = 'AABBCCDDEEFF00112233445566778899';

test('the discovery request carries the TP-Link magic header', () => {
  const request = buildDiscoveryRequest();
  assert.equal(request.length, 16);
  assert.deepEqual([...request.subarray(0, 4)], [0x02, 0x00, 0x00, 0x01]);
});

test('a reply yields its device id and model', () => {
  const parsed = parseDiscoveryReply(Buffer.from(fakeReply(DEVICE_ID), 'base64'));
  assert.equal(parsed.deviceId, DEVICE_ID);
  // The model is announced as "C210 1.0"; only the reference is useful.
  assert.equal(parsed.model, 'C210');
});

test('the camelCase spelling some firmwares use is accepted', () => {
  const body = Buffer.from(JSON.stringify({ deviceId: DEVICE_ID }));
  const payload = Buffer.concat([Buffer.alloc(16), body]);
  assert.equal(parseDiscoveryReply(payload).deviceId, DEVICE_ID);
});

test('an unreadable reply yields no id instead of throwing', () => {
  assert.deepEqual(parseDiscoveryReply(Buffer.from('garbage')), { deviceId: null, model: null });
});

test('the scan maps device ids to their local address', async () => {
  const gladys = fakeGladys({
    scanResults: [
      { source_ip: '192.168.1.20', source_port: 20002, payload_base64: fakeReply(DEVICE_ID) },
    ],
  });
  const addresses = await discoverLocalAddresses(gladys);
  assert.equal(addresses.get(DEVICE_ID), '192.168.1.20');
});

test('a failing scan degrades to no address, never throws', async () => {
  // Discovery enhances the cloud list; it must never break the whole publish.
  const gladys = fakeGladys({ scanResults: new Error('no Gladys Plus') });
  assert.equal((await discoverLocalAddresses(gladys)).size, 0);
});

test('a discovered address fills the gap the cloud leaves', async () => {
  // The core of the fix: the cloud never reports the local IP, so without the
  // scan a camera is listed but unreachable.
  const gladys = fakeGladys({
    scanResults: [
      { source_ip: '192.168.1.20', source_port: 20002, payload_base64: fakeReply(DEVICE_ID) },
    ],
  });
  const devices = await buildDiscoveredDevices(
    gladys,
    [{ cloudDeviceId: DEVICE_ID, name: 'Jardin', model: 'C210', ip: '' }],
    normalizeConfig(),
  );
  assert.equal(getParam(devices[0], DEVICE_PARAMS.IP), '192.168.1.20');
});

test('a manually configured address wins over the scan', async () => {
  // The user typed it precisely because the automatic detection did not suit.
  const gladys = fakeGladys({
    scanResults: [
      { source_ip: '192.168.1.20', source_port: 20002, payload_base64: fakeReply(DEVICE_ID) },
    ],
  });
  const devices = await buildDiscoveredDevices(
    gladys,
    // `cloud.js` already applied the manual address, hence a non-empty ip here.
    [{ cloudDeviceId: DEVICE_ID, name: 'Jardin', model: 'C210', ip: '192.168.1.99' }],
    normalizeConfig(),
  );
  assert.equal(getParam(devices[0], DEVICE_PARAMS.IP), '192.168.1.99');
});
