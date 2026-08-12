import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventWatcher, classifyEvent, eventTimestamp } from '../src/tapo/events.js';
import { buildDevice } from '../src/devices.js';
import { normalizeConfig } from '../src/config.js';
import { fakeGladys, fakeCloud, fakeLocalApi } from './helpers/fakeGladys.js';

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
function buildWatcher({ events = [], battery = null, privacy = null, onDoorbell } = {}) {
  const gladys = fakeGladys();
  const device = buildDevice(gladys, doorbellCamera);
  gladys.devices = [device];
  const watcher = new EventWatcher({ gladys, cloud: fakeCloud(), onDoorbell });
  watcher.config = normalizeConfig({ email: 'a@b.c', password: 'x' });
  // The events now come from the LOCAL API of the camera, not from the cloud:
  // the cloud passthrough answers -20571 on every camera.
  const api = fakeLocalApi({ events, battery, privacy });
  watcher.localApis.set(doorbellCamera.ip, api);
  return { watcher, device, gladys, api };
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
    events: [{ alarm_type: 3, start_time: 1750000000 }],
  });
  await watcher.checkDevice(device);
  assert.deepEqual(gladys.published.states, []);
});

test('a new doorbell press is published once, not replayed', async () => {
  const { watcher, device, gladys } = buildWatcher({
    events: [{ alarm_type: 3, start_time: 1750000000 }],
  });
  // First pass sets the watermark.
  await watcher.checkDevice(device);
  // A newer event fires.
  watcher.localApis.set(
    doorbellCamera.ip,
    fakeLocalApi({ events: [{ alarm_type: 3, start_time: 1750000060 }] }),
  );
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
    events: [{ alarm_type: 3, start_time: 1 }],
    onDoorbell: async (rung) => captured.push(rung.name),
  });
  await watcher.checkDevice(device);
  watcher.localApis.set(
    doorbellCamera.ip,
    fakeLocalApi({ events: [{ alarm_type: 3, start_time: 1750000060 }] }),
  );
  await watcher.checkDevice(device);
  assert.deepEqual(captured, ['Sonnette']);
});

test('a failing image capture does not lose the press itself', async () => {
  const { watcher, device, gladys } = buildWatcher({
    events: [{ alarm_type: 3, start_time: 1 }],
    onDoorbell: async () => {
      throw new Error('camera unreachable');
    },
  });
  await watcher.checkDevice(device);
  watcher.localApis.set(
    doorbellCamera.ip,
    fakeLocalApi({ events: [{ alarm_type: 3, start_time: 1750000060 }] }),
  );
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
  watcher.localApis.set(
    doorbellCamera.ip,
    fakeLocalApi({ events: [{ alarm_type: 2, start_time: 1750000060 }] }),
  );
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

test('the local alarm_type decides the kind of event', () => {
  // Measured on a C610: the local API reports a numeric `alarm_type`, not the
  // textual fields the cloud used to send.
  assert.equal(classifyEvent({ alarm_type: 3, start_time: 1785400633 }), 'doorbell');
  assert.equal(classifyEvent({ alarm_type: 2, start_time: 1785400633 }), 'motion');
  // An unknown numeric type fires nothing rather than guessing.
  assert.equal(classifyEvent({ alarm_type: 99 }), null);
});

test('the textual fields still work, for firmwares that use them', () => {
  // Kept as a fallback: not every model reports alarm_type.
  assert.equal(classifyEvent({ eventType: 'ring' }), 'doorbell');
  assert.equal(classifyEvent({ type: 'motion' }), 'motion');
});

test('start_time is the timestamp the local API reports', () => {
  // Real entry: {"start_time":1785400633,"end_time":1785400648,"alarm_type":2}
  assert.equal(eventTimestamp({ start_time: 1785400633, alarm_type: 2 }), 1785400633000);
});

// --- ONVIF: events pushed by the camera --------------------------------------

test('a camera covered by ONVIF is not polled for its detections', async () => {
  // The two sources report the SAME detections. Publishing both would fire every
  // scene twice: once instantly, once up to a poll later — which reads as a
  // second, separate motion.
  const { watcher, device, gladys } = buildWatcher({
    events: [{ alarm_type: 2, start_time: 1750000000 }],
    battery: 88,
  });
  watcher.onvifCovered.add('ID1');

  // Two rounds: the first would set the watermark, the second would publish.
  await watcher.checkDevice(device);
  await watcher.checkDevice(device);

  const motions = gladys.published.states.filter((state) =>
    state.featureExternalId.endsWith(':motion'),
  );
  assert.deepEqual(motions, [], 'the polled path must publish nothing for an ONVIF camera');
});

test('the battery is still read on a camera covered by ONVIF', async () => {
  // ONVIF carries motion and rings, never the battery level — which is exactly
  // what the guard needs to release a recovering camera.
  const { watcher, device, gladys } = buildWatcher({ battery: 73 });
  watcher.onvifCovered.add('ID1');

  await watcher.checkDevice(device);

  const battery = gladys.published.states.find((state) =>
    state.featureExternalId.endsWith(':battery'),
  );
  assert.ok(battery, 'the battery must keep being published');
  assert.equal(battery.value, 73);
});

test('an ONVIF motion publishes its rising and falling edge', async () => {
  // The falling edge is what the polled path could never provide: the sensor
  // follows the camera instead of an arbitrary timer.
  const { watcher, device, gladys } = buildWatcher({});

  await watcher.handleOnvifEvent(device, 'ID1', { kind: 'motion', active: true, at: Date.now() });
  await watcher.handleOnvifEvent(device, 'ID1', { kind: 'motion', active: false, at: Date.now() });

  const motions = gladys.published.states.filter((state) =>
    state.featureExternalId.endsWith(':motion'),
  );
  assert.deepEqual(
    motions.map((state) => state.value),
    [1, 0],
  );
});

test('the falling edge cancels the fallback timer', async () => {
  // The timer only exists for firmwares that never send the falling edge. Left
  // armed, it would publish a second 0 long after the camera already did.
  const { watcher, device } = buildWatcher({});

  await watcher.handleOnvifEvent(device, 'ID1', { kind: 'motion', active: true, at: Date.now() });
  assert.ok(watcher.motionResets.has('ID1'), 'the safety net must be armed');

  await watcher.handleOnvifEvent(device, 'ID1', { kind: 'motion', active: false, at: Date.now() });
  assert.equal(watcher.motionResets.has('ID1'), false);
});

test('an ONVIF ring publishes the press and pushes an image', async () => {
  const captured = [];
  const { watcher, device, gladys } = buildWatcher({
    onDoorbell: async (target) => captured.push(target.name),
  });

  await watcher.handleOnvifEvent(device, 'ID1', { kind: 'doorbell', active: true, at: Date.now() });

  const button = gladys.published.states.find((state) =>
    state.featureExternalId.endsWith(':button'),
  );
  assert.ok(button);
  assert.equal(button.value, 1);
  assert.deepEqual(captured, ['Sonnette']);
});

test('a ring reported as inactive is not a second press', async () => {
  // A ring is an instant, not a state. Some firmwares still send a closing
  // message, and publishing it would ring the scene twice.
  const { watcher, device, gladys } = buildWatcher({});
  await watcher.handleOnvifEvent(device, 'ID1', {
    kind: 'doorbell',
    active: false,
    at: Date.now(),
  });
  assert.deepEqual(gladys.published.states, []);
});

test('ONVIF is not attempted without a camera account', async () => {
  // ONVIF authenticates against the CAMERA account, not the Tapo one. Without
  // it there is nothing to try, and the camera stays on the polled path.
  const { watcher, device } = buildWatcher({});
  const subscribed = await watcher.setupOnvif(device);
  assert.equal(subscribed, false);
  assert.equal(watcher.onvifCovered.size, 0);
});

test('dropping the ONVIF subscription puts the camera back on the polled path', async () => {
  // Corrected credentials are the reason this exists: a live client keeps using
  // the old ones, and the camera would otherwise be considered already handled.
  const { watcher, device } = buildWatcher({});
  const stopped = [];
  watcher.onvifClients.set('192.168.1.42', { stop: () => stopped.push('stopped') });
  watcher.onvifCovered.add('ID1');

  watcher.dropOnvif(device);

  assert.deepEqual(stopped, ['stopped'], 'the subscription must be released, not just forgotten');
  assert.equal(watcher.onvifClients.size, 0);
  assert.equal(watcher.onvifCovered.has('ID1'), false, 'the polled path must take over again');
});

test('stopping the watcher releases every ONVIF subscription', () => {
  // A camera only accepts a few subscriptions at once: dropping them without
  // unsubscribing would leave a restart unable to open new ones.
  const { watcher } = buildWatcher({});
  const stopped = [];
  watcher.onvifClients.set('192.168.1.42', { stop: () => stopped.push('a') });
  watcher.onvifClients.set('192.168.1.43', { stop: () => stopped.push('b') });
  watcher.onvifCovered.add('ID1');

  watcher.stop();

  assert.deepEqual(stopped.sort(), ['a', 'b']);
  assert.equal(watcher.onvifClients.size, 0);
  assert.equal(watcher.onvifCovered.size, 0);
});

// --- Privacy mode -------------------------------------------------------------

test('the privacy mode is published and remembered on every check', async () => {
  const { watcher, device, gladys } = buildWatcher({ privacy: true });
  await watcher.checkDevice(device);

  const published = gladys.published.states.filter((state) =>
    state.featureExternalId.endsWith(':privacy'),
  );
  assert.equal(published.length, 1);
  assert.equal(published[0].value, 1, 'a masked lens publishes 1');
  // Remembered too: the capture path has no other way of knowing, since a masked
  // camera answers with a black frame instead of failing.
  assert.equal(watcher.isPrivacyModeOn(device.external_id), true);
});

test('a camera without a lens mask publishes no privacy state', async () => {
  // `null` means the camera never said. Publishing 0 would light up a switch the
  // camera does not have.
  const { watcher, device, gladys } = buildWatcher({ privacy: null });
  await watcher.checkDevice(device);

  assert.equal(
    gladys.published.states.filter((state) => state.featureExternalId.endsWith(':privacy')).length,
    0,
  );
  assert.equal(watcher.isPrivacyModeOn(device.external_id), false);
});

test('an unmasked camera is not held back from being captured', async () => {
  const { watcher, device, gladys } = buildWatcher({ privacy: false });
  await watcher.checkDevice(device);

  const published = gladys.published.states.filter((state) =>
    state.featureExternalId.endsWith(':privacy'),
  );
  assert.equal(published[0].value, 0);
  assert.equal(watcher.isPrivacyModeOn(device.external_id), false);
});

test('a command updates the remembered state without waiting for a poll', async () => {
  // Otherwise a camera the user just un-masked would keep being skipped by the
  // capture guard for up to a minute, which reads as a switch that did nothing.
  const { watcher, device } = buildWatcher({ privacy: true });
  await watcher.checkDevice(device);
  assert.equal(watcher.isPrivacyModeOn(device.external_id), true);

  watcher.setPrivacyMode(device.external_id, false);
  assert.equal(watcher.isPrivacyModeOn(device.external_id), false);
});

test('the local client is shared rather than opened twice', async () => {
  // The firmware only accepts a handful of sessions: a second client would
  // eventually get every login refused with -40413.
  const { watcher, api } = buildWatcher({});
  assert.equal(watcher.getLocalApi(doorbellCamera.ip), api);
  assert.equal(watcher.getLocalApi(doorbellCamera.ip), watcher.getLocalApi(doorbellCamera.ip));
});
