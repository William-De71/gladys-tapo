import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventWatcher, classifyEvent, eventTimestamp } from '../src/tapo/events.js';
import { buildDevice } from '../src/devices.js';
import { normalizeConfig } from '../src/config.js';
import { fakeGladys, fakeCloud } from './helpers/fakeGladys.js';

const doorbellCamera = {
  cloudDeviceId: 'ID1',
  name: 'Sonnette',
  model: 'D230',
  ip: '192.168.1.42',
  captureMode: 'proprietary',
  hasBattery: true,
  hasEvents: true,
};

/**
 * Build a watcher wired to fakes, ready for a manual `checkDevice`.
 * @param {object} [options] - The cloud payload to serve.
 * @returns {object} The watcher, the device and the fake Gladys.
 * @example
 * const { watcher, device, gladys } = buildWatcher({ events: [] });
 */
function buildWatcher({ events = [], battery = null, onDoorbell } = {}) {
  const gladys = fakeGladys();
  const device = buildDevice(gladys, doorbellCamera);
  gladys.devices = [device];
  const watcher = new EventWatcher({ gladys, cloud: fakeCloud({ events, battery }), onDoorbell });
  watcher.config = normalizeConfig({ email: 'a@b.c', password: 'x' });
  return { watcher, device, gladys };
}

test('event types are classified from whatever field carries them', () => {
  assert.equal(classifyEvent({ eventType: 'ring' }), 'doorbell');
  assert.equal(classifyEvent({ type: 'motion' }), 'motion');
  assert.equal(classifyEvent({ name: 'personDetection' }), 'motion');
  assert.equal(classifyEvent({ eventType: 'firmwareUpdate' }), null);
  assert.equal(classifyEvent({}), null);
});

test('timestamps in seconds and in milliseconds both normalize to ms', () => {
  // Firmwares disagree on the unit; treating seconds as ms dates events to 1970.
  assert.equal(eventTimestamp({ timestamp: 1750000000 }), 1750000000000);
  assert.equal(eventTimestamp({ timestamp: 1750000000000 }), 1750000000000);
  assert.equal(eventTimestamp({}), 0);
});

test('the first check never fires an event', async () => {
  // Starting the integration must not replay a ring that happened an hour ago.
  const { watcher, device, gladys } = buildWatcher({
    events: [{ eventType: 'ring', timestamp: 1750000000 }],
  });
  await watcher.checkDevice(device);
  assert.deepEqual(gladys.published.states, []);
});

test('a new doorbell press is published once, not replayed', async () => {
  const { watcher, device, gladys } = buildWatcher({
    events: [{ eventType: 'ring', timestamp: 1750000000 }],
  });
  // First pass sets the watermark.
  await watcher.checkDevice(device);
  // A newer event fires.
  watcher.cloud = fakeCloud({ events: [{ eventType: 'ring', timestamp: 1750000060 }] });
  await watcher.checkDevice(device);
  assert.deepEqual(gladys.published.states, [
    { featureExternalId: 'ext:ext-dev-tapo:camera:ID1:button', value: 1 },
  ]);

  // The same event again must stay silent: the cloud keeps returning its window.
  await watcher.checkDevice(device);
  assert.equal(gladys.published.states.length, 1);
});

test('a doorbell press also pushes a fresh image', async () => {
  // So the widget already shows who rang when the user opens the notification.
  const captured = [];
  const { watcher, device } = buildWatcher({
    events: [{ eventType: 'ring', timestamp: 1 }],
    onDoorbell: async (rung) => captured.push(rung.name),
  });
  await watcher.checkDevice(device);
  watcher.cloud = fakeCloud({ events: [{ eventType: 'ring', timestamp: 1750000060 }] });
  await watcher.checkDevice(device);
  assert.deepEqual(captured, ['Sonnette']);
});

test('a failing image capture does not lose the press itself', async () => {
  const { watcher, device, gladys } = buildWatcher({
    events: [{ eventType: 'ring', timestamp: 1 }],
    onDoorbell: async () => {
      throw new Error('camera unreachable');
    },
  });
  await watcher.checkDevice(device);
  watcher.cloud = fakeCloud({ events: [{ eventType: 'ring', timestamp: 1750000060 }] });
  await watcher.checkDevice(device);
  assert.deepEqual(gladys.published.states, [
    { featureExternalId: 'ext:ext-dev-tapo:camera:ID1:button', value: 1 },
  ]);
});

test('a motion is published and scheduled to come back down', async () => {
  // The cloud only reports the rising edge: without a reset the sensor would
  // stay "motion detected" forever.
  const { watcher, device, gladys } = buildWatcher({
    events: [{ eventType: 'motion', timestamp: 1 }],
  });
  await watcher.checkDevice(device);
  watcher.cloud = fakeCloud({ events: [{ eventType: 'motion', timestamp: 1750000060 }] });
  await watcher.checkDevice(device);

  assert.deepEqual(gladys.published.states, [
    { featureExternalId: 'ext:ext-dev-tapo:camera:ID1:motion', value: 1 },
  ]);
  assert.equal(watcher.motionResets.size, 1, 'a reset must be pending');
  watcher.stop();
  assert.equal(watcher.motionResets.size, 0, 'stopping cancels the pending resets');
});

test('the battery level is published on every check', async () => {
  const { watcher, device, gladys } = buildWatcher({ battery: 78 });
  await watcher.checkDevice(device);
  assert.deepEqual(gladys.published.states, [
    { featureExternalId: 'ext:ext-dev-tapo:camera:ID1:battery', value: 78 },
  ]);
});

test('an unparseable cloud payload yields no event instead of crashing', async () => {
  // The passthrough payload shape varies across models and firmwares.
  const { watcher, device, gladys } = buildWatcher();
  watcher.cloud = { authenticatedRequest: async () => ({ responseData: 'not json' }) };
  await watcher.checkDevice(device);
  assert.deepEqual(gladys.published.states, []);
});

test('overlapping ticks are skipped rather than piling up', async () => {
  // A slow cloud must not spawn concurrent runs publishing the same event twice.
  const { watcher } = buildWatcher();
  watcher.running = true;
  await watcher.tick();
  assert.equal(watcher.cloud.calls.calls, 0);
});

test('only the devices carrying event features are polled', async () => {
  // A wired camera has no button or motion feature: polling it would be wasted.
  const gladys = fakeGladys();
  const wired = buildDevice(gladys, {
    ...doorbellCamera,
    cloudDeviceId: 'ID2',
    hasEvents: false,
    hasBattery: false,
  });
  gladys.devices = [wired];
  const watcher = new EventWatcher({ gladys, cloud: fakeCloud() });
  watcher.config = normalizeConfig({ email: 'a@b.c', password: 'x' });
  await watcher.tick();
  assert.equal(watcher.cloud.calls.calls, 0);
});
