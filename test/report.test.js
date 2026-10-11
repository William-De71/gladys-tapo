import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConnectionReport,
  connectionStatusFor,
  isValidAddress,
  reportLine,
} from '../src/report.js';
import { buildDevice } from '../src/devices.js';
import { fakeGladys } from './helpers/fakeGladys.js';

const gladys = fakeGladys();

/**
 * A published camera.
 * @param {object} overrides - Fields of the resolved camera.
 * @returns {object} The device.
 * @example
 * camera({ ip: '' });
 */
function camera(overrides) {
  return buildDevice(gladys, {
    cloudDeviceId: 'ID1',
    name: 'Salon',
    model: 'C230',
    ip: '192.168.1.20',
    ipSource: 'scan',
    captureMode: 'rtsp',
    ...overrides,
  });
}

test('a camera without an address is named, with the action that fixes it', () => {
  const line = reportLine(camera({ ip: '', ipSource: null, captureMode: null }));
  assert.equal(line.ok, false);
  assert.match(line.fr, /Salon \(C230\)/);
  assert.match(line.fr, /Définir l'adresse IP d'un appareil/);
});

test('a camera that does not answer says where its address came from', () => {
  const line = reportLine(camera({ ipSource: 'manual', captureMode: null }));
  assert.equal(line.ok, false);
  assert.match(line.en, /192\.168\.1\.20 \(entered by you\) does not answer/);
});

test('a working camera reports its address, its origin and its capture mode', () => {
  const line = reportLine(camera({}));
  assert.equal(line.ok, true);
  assert.match(line.fr, /192\.168\.1\.20 \(trouvée sur le réseau\), images en RTSP/);
});

test('the report has one line per device under a summary', () => {
  const report = buildConnectionReport([camera({}), camera({ name: 'Jardin', ip: '' })]);
  const lines = report.en.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /2 device\(s\), 1 reachable/);
});

test('the status stays connected but names the devices without an address', () => {
  const status = connectionStatusFor([camera({}), camera({ name: 'Jardin', ip: '' })]);
  assert.equal(status.connected, true);
  assert.match(status.message.fr, /Introuvable\(s\) sur votre réseau : Jardin/);
  assert.deepEqual(connectionStatusFor([camera({})]), { connected: true });
  assert.equal(connectionStatusFor([]).connected, false);
});

test('only plausible addresses are accepted', () => {
  assert.equal(isValidAddress('192.168.1.42'), true);
  assert.equal(isValidAddress(' 10.0.0.5 '), true);
  assert.equal(isValidAddress('camera.lan'), true);
  assert.equal(isValidAddress('192.168.1.256'), false);
  assert.equal(isValidAddress('192.168.1'), false);
  assert.equal(isValidAddress('Salon|192.168.1.42'), false);
  assert.equal(isValidAddress(''), false);
});
