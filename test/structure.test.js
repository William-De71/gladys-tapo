// -----------------------------------------------------------------------------
// Structure non-regression: what users of 2.0.0 already created must keep its
// meaning.
//
// The discovery "Update" button of Gladys compares the forever fields of each
// feature (external_id, category, type, unit, min, max); a change there forces
// the user to delete and recreate a device, losing its history and its scenes.
// A change of should_poll / poll_frequency never reaches a device already
// created, so it is locked too.
//
// test/fixtures/discovery.baseline.json was generated from the v2.0.0 code,
// before any change of this version, from test/fixtures/discovery.inputs.json:
// four cameras (PTZ with presets, battery, doorbell, unprobed) and the SMART
// devices (metered plug, power strip, colour bulb, dimmer, wall switch, and an
// H100 hub with its six kinds of sensors). test/fixtures/manifest.baseline.json
// holds the configuration and action keys of 2.0.0. A difference is a breaking
// change: it needs an entry in ALLOWED_CHANGES with its migration, in the
// changelog, the docs and the forum message.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDevice } from '../src/devices.js';
import { buildSmartDevices } from '../src/smart/model.js';
import { fakeGladys } from './helpers/fakeGladys.js';

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const inputs = read('test/fixtures/discovery.inputs.json');
const baseline = read('test/fixtures/discovery.baseline.json');
const manifestBaseline = read('test/fixtures/manifest.baseline.json');
const manifest = read('gladys-assistant-integration.json');

// No allowed change in this version.
const ALLOWED_CHANGES = [];

const FOREVER_FEATURE_FIELDS = [
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
];

/**
 * Build the devices of the baseline inputs with the current code.
 * @returns {object[]} The devices, as discovery publishes them.
 */
function currentDevices() {
  const gladys = fakeGladys();
  return [
    ...inputs.cameras.map((camera) => buildDevice(gladys, camera)),
    ...inputs.smart.flatMap(({ device, state }) => buildSmartDevices(gladys, device, state)),
  ];
}

test('the devices of 2.0.0 keep their external id, params and polling', () => {
  const now = currentDevices();
  assert.equal(now.length, baseline.devices.length);
  baseline.devices.forEach((before, index) => {
    assert.equal(now[index].external_id, before.external_id);
    assert.deepEqual(
      now[index].params.map((param) => param.name).sort(),
      before.params.map((param) => param.name).sort(),
      before.external_id,
    );
    assert.equal(now[index].should_poll, before.should_poll, before.external_id);
    assert.equal(now[index].poll_frequency, before.poll_frequency, before.external_id);
  });
  assert.deepEqual(ALLOWED_CHANGES, []);
});

test('every feature of 2.0.0 is still discovered with the same forever fields', () => {
  const now = currentDevices();
  baseline.devices.forEach((before, index) => {
    const features = new Map(now[index].features.map((feature) => [feature.external_id, feature]));
    for (const feature of before.features) {
      const current = features.get(feature.external_id);
      assert.ok(current, `feature ${feature.external_id} disappeared`);
      for (const field of FOREVER_FEATURE_FIELDS) {
        assert.deepEqual(current[field], feature[field], `${feature.external_id}.${field}`);
      }
    }
  });
});

test('no feature id is published twice on one device', () => {
  for (const device of currentDevices()) {
    const ids = device.features.map((feature) => feature.external_id);
    assert.equal(new Set(ids).size, ids.length, device.external_id);
  }
});

test('the configuration and action keys of 2.0.0 are kept, with their types', () => {
  const current = new Map(manifest.config_schema.map((field) => [field.key, field]));
  for (const field of manifestBaseline.config_schema) {
    const now = current.get(field.key);
    assert.ok(now, `config_schema.${field.key} was removed`);
    assert.equal(now.type, field.type, `config_schema.${field.key}.type`);
    assert.equal(now.required ?? false, field.required, `config_schema.${field.key}.required`);
    assert.equal(now.default, field.default, `config_schema.${field.key}.default`);
  }
  const oldKeys = new Set(manifestBaseline.config_schema.map((field) => field.key));
  for (const field of manifest.config_schema.filter((entry) => !oldKeys.has(entry.key))) {
    // A new required field without a default would block every existing user.
    assert.ok(!field.required || field.default !== undefined, `new required ${field.key}`);
  }
  const actions = new Map(manifest.actions.map((action) => [action.key, action]));
  for (const action of manifestBaseline.actions) {
    assert.ok(actions.has(action.key), `action ${action.key}`);
    const fields = (actions.get(action.key).fields || []).map((field) => field.key);
    for (const key of action.fields) {
      assert.ok(fields.includes(key), `action ${action.key} field ${key}`);
    }
  }
});

test('the type, the transports and the network discovery of 2.0.0 are kept', () => {
  assert.equal(manifest.type, manifestBaseline.type);
  assert.deepEqual(manifest.transports, manifestBaseline.transports);
  assert.deepEqual(manifest.network_discovery, manifestBaseline.network_discovery);
});
