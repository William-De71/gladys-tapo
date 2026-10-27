import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildConnectionReport,
  connectionStatusFor,
  isValidAddress,
  reportLine,
  ADDRESS_ACTION_LABEL,
  describeAddressSource,
  problemLine,
  manualEntryFor,
  MANUAL_ADDRESSES_LABEL,
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

test('every message speaks the four languages of Gladys', () => {
  const LANGUAGES = ['en', 'fr', 'de', 'es'];
  const physical = { name: 'Jardin', model: 'C660', ip: '192.168.1.30', cloudDeviceId: 'ID9' };
  const messages = [
    ADDRESS_ACTION_LABEL,
    ...['manual', 'scan', 'cloud', 'previous', null].map(describeAddressSource),
    reportLine(camera({})),
    reportLine(camera({ captureMode: 'stream' })),
    reportLine(camera({ ip: '', ipSource: null, captureMode: null })),
    reportLine(camera({ captureMode: null })),
    MANUAL_ADDRESSES_LABEL,
    ...['address', 'unsupported', 'credentials', 'third-party', 'unreachable'].map((reason) =>
      problemLine({ physical, reason }),
    ),
    problemLine({ physical, reason: 'address', listed: false }),
    connectionStatusFor([], [{ physical, reason: 'address', listed: false }]).message,
    connectionStatusFor([camera({ ip: '' })], [{ physical, reason: 'address', listed: false }])
      .message,
    buildConnectionReport([camera({})], [{ physical, reason: 'unreachable' }]),
    connectionStatusFor([]).message,
    connectionStatusFor([camera({ ip: '' })]).message,
    connectionStatusFor([camera({})], [{ physical, reason: 'unreachable' }]).message,
    connectionStatusFor([camera({})], [{ physical, reason: 'third-party' }]).message,
  ];
  for (const message of messages) {
    for (const language of LANGUAGES) {
      assert.equal(typeof message[language], 'string', `${language} missing in ${message.en}`);
      if (message.en) {
        assert.ok(message[language].length > 0, `${language} empty in ${message.en}`);
      }
    }
  }
});

test('the report names the address action as the manifest labels it', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../gladys-assistant-integration.json', import.meta.url)),
  );
  const action = manifest.actions.find((entry) => entry.key === 'set_device_address');
  assert.deepEqual(ADDRESS_ACTION_LABEL, action.label);
  const field = manifest.config_schema.find((entry) => entry.key === 'camera_ips');
  assert.deepEqual(MANUAL_ADDRESSES_LABEL, field.label);
});

test('a device the address action cannot list is sent to the manual field', () => {
  // Issue #6: an L530 the scan missed was never published, so the action's
  // list stayed empty while every message pointed to that action.
  const physical = { name: 'Ampoule salon', model: 'L530', mac: 'AA-BB-CC-DD-EE-FF' };
  const problem = { physical, reason: 'address', listed: false };

  const line = problemLine(problem);
  assert.equal(line.ok, false);
  assert.match(line.fr, /« Ampoule salon\|IP » dans « Adresses manuelles \(avancé\) »/);
  assert.doesNotMatch(line.fr, new RegExp(ADDRESS_ACTION_LABEL.fr));

  const status = connectionStatusFor([], [problem]);
  assert.equal(status.connected, true);
  assert.match(status.message.fr, /ajoutez Ampoule salon\|IP dans/);

  // With a camera also without an address, both fixes are given.
  const both = connectionStatusFor([camera({ name: 'Jardin', ip: '' })], [problem]);
  assert.match(both.message.fr, /Ampoule salon\|IP/);
  assert.match(both.message.fr, /Également sans adresse : Jardin/);

  // Already in Gladys: the action stays the advice.
  assert.match(problemLine({ ...problem, listed: true }).fr, new RegExp(ADDRESS_ACTION_LABEL.fr));
});

test('the manual entry falls back to the MAC when the name cannot be typed', () => {
  assert.equal(manualEntryFor({ name: 'Salon' }), 'Salon|IP');
  assert.equal(manualEntryFor({ name: 'Salon, bas', mac: 'AA-BB' }), 'AA-BB|IP');
  assert.equal(manualEntryFor({ name: 'A=B' }), 'A=B|IP');
});

test('every inline message of src/app.js carries de and es after fr', () => {
  // The action results are written inline in src/app.js: a message added in
  // English and French only would show in English in a German interface.
  const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8').split('\n');
  source.forEach((line, index) => {
    if (/^\s*fr: /.test(line)) {
      assert.match(source[index + 1] || '', /^\s*de: /, `de missing after line ${index + 1}`);
      assert.match(source[index + 2] || '', /^\s*es: /, `es missing after line ${index + 1}`);
    }
  });
});

test('a device refusing third-party apps points to the Tapo switch, not to the network', () => {
  const physical = {
    name: 'ampoule',
    model: 'L530EA(EU)',
    ip: '192.168.1.42',
    cloudDeviceId: 'ID6',
  };
  const line = problemLine({ physical, reason: 'third-party' });
  assert.equal(line.ok, false);
  assert.match(line.fr, /Compatibilité tierce/);
  assert.doesNotMatch(line.fr, /ne répond pas/);
  const status = connectionStatusFor(
    [],
    [
      { physical, reason: 'third-party' },
      { physical: { ...physical, name: 'prise' }, reason: 'unreachable' },
    ],
  ).message;
  assert.match(status.fr, /^Refusent les applications tierces : ampoule\./);
  assert.match(status.fr, /\nNe répondent pas : prise\./);
});
