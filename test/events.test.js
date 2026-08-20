import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '@gladysassistant/integration-sdk';
import { EventWatcher, classifyEvent, eventTimestamp } from '../src/tapo/events.js';
import { buildDevice } from '../src/devices.js';
import { normalizeConfig } from '../src/config.js';
import {
  ONVIF_MOTION_FALL_DELAY_MS,
  BATTERY_THRESHOLDS,
  BATTERY_LOW_POLL_INTERVAL_MS,
} from '../src/tapo/constants.js';
import { BatteryGuard } from '../src/tapo/batteryGuard.js';
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
  // The privacy state is only read for a camera that HAS the switch — the local
  // session is not opened for questions the device cannot answer — so the fake
  // camera must declare it whenever the test cares about it.
  const device = buildDevice(gladys, {
    ...doorbellCamera,
    hasPrivacyMode: privacy === null ? undefined : privacy,
  });
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
  // The fall is held back to swallow the blips these firmwares mix into an
  // ongoing detection, so it lands a moment after the camera reported it.
  await new Promise((resolve) => setTimeout(resolve, ONVIF_MOTION_FALL_DELAY_MS + 50));

  const motions = gladys.published.states.filter((state) =>
    state.featureExternalId.endsWith(':motion'),
  );
  assert.deepEqual(
    motions.map((state) => state.value),
    [1, 0],
  );
  watcher.stop();
});

test('the falling edge cancels the fallback timer', async () => {
  // The timer only exists for firmwares that never send the falling edge. Left
  // armed, it would publish a second 0 long after the camera already did.
  const { watcher, device } = buildWatcher({});

  await watcher.handleOnvifEvent(device, 'ID1', { kind: 'motion', active: true, at: Date.now() });
  assert.ok(watcher.motionResets.has('ID1'), 'the safety net must be armed');

  await watcher.handleOnvifEvent(device, 'ID1', { kind: 'motion', active: false, at: Date.now() });
  await new Promise((resolve) => setTimeout(resolve, ONVIF_MOTION_FALL_DELAY_MS + 50));
  assert.equal(watcher.motionResets.has('ID1'), false);
  watcher.stop();
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

test('a camera with nothing local to answer is not logged into at all', async () => {
  // The bug this pins: every tick opened a session on a wired, ONVIF-covered
  // camera just to ask questions it has no features for. On a camera that
  // refuses those credentials, that is a failed login every 20 seconds — which
  // held a C210 in a permanent lockout instead of a few minutes.
  const gladys = fakeGladys();
  const wired = buildDevice(gladys, {
    ...doorbellCamera,
    cloudDeviceId: 'ID3',
    hasBattery: false,
    hasEvents: true,
  });
  gladys.devices = [wired];

  const watcher = new EventWatcher({ gladys, cloud: fakeCloud() });
  watcher.config = normalizeConfig({ email: 'a@b.c', password: 'x' });
  // Its events arrive over ONVIF, so the detections are skipped too: nothing at
  // all is left to ask.
  watcher.onvifCovered.add('ID3');

  let opened = false;
  watcher.getLocalApi = () => {
    opened = true;
    return fakeLocalApi({});
  };

  await watcher.checkDevice(wired);
  assert.equal(opened, false, 'no local session must be opened with nothing to read');
});

// --- ONVIF subscriptions ------------------------------------------------------

test('the ONVIF setup asks Gladys for the devices instead of reading a stale list', async () => {
  // The regression that silently killed motion detection: the setup read
  // `gladys.devices`, which the SDK only refreshes when the WebSocket
  // (re)connects. On the `config-updated` path — a re-publish, then the watcher
  // restarted — that list is stale, and empty on a first setup. No camera was
  // ever filtered in, so no subscription was opened and no error was logged:
  // the motion sensor simply never fired again.
  const gladys = fakeGladys();
  const camera = buildDevice(gladys, { ...doorbellCamera, cloudDeviceId: 'ID9' });
  // Exactly the production shape: the property is stale/empty while the API
  // serves the real list.
  gladys.devices = [];
  gladys.getDevices = async () => [camera];

  const watcher = new EventWatcher({ gladys, cloud: fakeCloud() });
  watcher.config = normalizeConfig({
    email: 'a@b.c',
    password: 'x',
    rtsp_username: 'gladys',
    rtsp_password: 'secret',
  });

  const tried = [];
  watcher.setupOnvif = async (device) => {
    tried.push(device.external_id);
    return true;
  };

  await watcher.setupOnvifSubscriptions();
  assert.deepEqual(tried, [camera.external_id], 'the camera must be offered to ONVIF');
});

// --- Motion deduplication -----------------------------------------------------

test('a repeated motion state is published once, not on every notification', async () => {
  // Measured at ~15 notifications a second on a C500: one person walking past is
  // hundreds of identical `motion=true`. The host API allows 300 states a minute,
  // so republishing each one burned the budget and the dashboard showed nothing.
  const gladys = fakeGladys();
  const device = buildDevice(gladys, { ...doorbellCamera, cloudDeviceId: 'ID7' });
  const watcher = new EventWatcher({ gladys, cloud: fakeCloud() });
  watcher.config = normalizeConfig({ email: 'a@b.c', password: 'x' });

  for (let i = 0; i < 20; i += 1) {
    await watcher.handleOnvifEvent(device, 'ID7', { kind: 'motion', active: true, at: Date.now() });
  }
  const published = gladys.published.states.filter((state) =>
    state.featureExternalId.endsWith(':motion'),
  );
  assert.equal(published.length, 1, 'twenty notifications, one state');
  assert.equal(published[0].value, 1);
  // The active motion armed a reset timer; without this the test process hangs
  // until it fires.
  watcher.stop();
});

test('a motion is reported again after it ended', async () => {
  // The trap of deduplicating: a sensor that fires once and then never again.
  const gladys = fakeGladys();
  const device = buildDevice(gladys, { ...doorbellCamera, cloudDeviceId: 'ID8' });
  const watcher = new EventWatcher({ gladys, cloud: fakeCloud() });
  watcher.config = normalizeConfig({ email: 'a@b.c', password: 'x' });

  await watcher.handleOnvifEvent(device, 'ID8', { kind: 'motion', active: true, at: Date.now() });
  // The fall is held back, so it has to be let through for this test.
  await watcher.handleOnvifEvent(device, 'ID8', { kind: 'motion', active: false, at: Date.now() });
  await new Promise((resolve) => setTimeout(resolve, ONVIF_MOTION_FALL_DELAY_MS + 50));
  await watcher.handleOnvifEvent(device, 'ID8', { kind: 'motion', active: true, at: Date.now() });

  const values = gladys.published.states
    .filter((state) => state.featureExternalId.endsWith(':motion'))
    .map((state) => state.value);
  assert.deepEqual(values, [1, 0, 1], 'each real change is published');
  watcher.stop();
});

test('a lone false in the middle of a motion does not drop the sensor', async () => {
  // Measured on a C500: runs of 50 to 150 `true` split by exactly ONE `false`,
  // over and over, while someone is still walking past. Publishing that blip
  // dropped the sensor a second after it rose — the detection showed for a
  // blink on the dashboard while the logs showed half a minute of motion.
  const gladys = fakeGladys();
  const device = buildDevice(gladys, { ...doorbellCamera, cloudDeviceId: 'ID10' });
  const watcher = new EventWatcher({ gladys, cloud: fakeCloud() });
  watcher.config = normalizeConfig({ email: 'a@b.c', password: 'x' });

  const motion = (active) =>
    watcher.handleOnvifEvent(device, 'ID10', { kind: 'motion', active, at: Date.now() });

  await motion(true);
  await motion(false); // the blip
  await motion(true); // the motion is still going on
  await new Promise((resolve) => setTimeout(resolve, ONVIF_MOTION_FALL_DELAY_MS + 50));

  const values = gladys.published.states
    .filter((state) => state.featureExternalId.endsWith(':motion'))
    .map((state) => state.value);
  assert.deepEqual(values, [1], 'the blip must not reach Gladys');
  watcher.stop();
});

test('two notifications during one publish do not publish it twice', async () => {
  // Measured in production, 13ms apart:
  //   08:47:13.656 Motion detected on "Caméra_Salon" (ONVIF)
  //   08:47:13.669 Motion detected on "Caméra_Salon" (ONVIF)
  // `motionStates` only records what the host ACCEPTED, so while the first
  // publish awaits its answer the map still reads the old value and the second
  // notification passes the "is this a change?" test too. At ~15 notifications
  // a second the window is hit constantly.
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let first = true;
  const gladys = fakeGladys({
    delayPublishState: ({ featureExternalId }) => {
      if (first && featureExternalId.endsWith(':motion')) {
        first = false;
        return held;
      }
      return undefined;
    },
  });
  const device = buildDevice(gladys, { ...doorbellCamera, cloudDeviceId: 'ID14' });
  const watcher = new EventWatcher({ gladys, cloud: fakeCloud() });
  watcher.config = normalizeConfig({ email: 'a@b.c', password: 'x' });

  const motion = (active) =>
    watcher.handleOnvifEvent(device, 'ID14', { kind: 'motion', active, at: Date.now() });

  // The second arrives while the first is still in flight, exactly as the
  // camera sends them.
  const inFlight = motion(true);
  await motion(true);
  release();
  await inFlight;

  const values = gladys.published.states
    .filter((state) => state.featureExternalId.endsWith(':motion'))
    .map((state) => state.value);
  assert.deepEqual(values, [1], 'one rising edge is one published state');
  watcher.stop();
});

test('a rejected motion is retried, not swallowed for good', async () => {
  // The deduplication makes `motionStates` the record of what Gladys is showing.
  // Recording a value the host never accepted silences the sensor until the
  // process restarts: the map reads `true`, so every later notification is
  // filtered out as "no change" — which is exactly why a camera came back
  // working after a restart, with no code change.
  let rejectNext = true;
  const gladys = fakeGladys({
    failPublishState: ({ featureExternalId }) => {
      if (rejectNext && featureExternalId.endsWith(':motion')) {
        rejectNext = false;
        return true;
      }
      return false;
    },
  });
  const device = buildDevice(gladys, { ...doorbellCamera, cloudDeviceId: 'ID11' });
  const watcher = new EventWatcher({ gladys, cloud: fakeCloud() });
  watcher.config = normalizeConfig({ email: 'a@b.c', password: 'x' });

  const motion = (active) =>
    watcher.handleOnvifEvent(device, 'ID11', { kind: 'motion', active, at: Date.now() });

  await motion(true); // rejected by the host
  assert.equal(
    watcher.motionStates.get('ID11'),
    undefined,
    'a state the host refused must not be recorded as published',
  );

  await motion(true); // the camera is still reporting the same motion

  const values = gladys.published.states
    .filter((state) => state.featureExternalId.endsWith(':motion'))
    .map((state) => state.value);
  assert.deepEqual(values, [1], 'the next notification publishes the motion after all');
  watcher.stop();
});

test('a rejected falling edge leaves the safety net armed', async () => {
  // Disarming it on a fall the host refused leaves Gladys showing a motion that
  // is over, with nothing left to bring the sensor back down.
  const gladys = fakeGladys({
    failPublishState: ({ featureExternalId, value }) =>
      featureExternalId.endsWith(':motion') && value === 0,
  });
  const device = buildDevice(gladys, { ...doorbellCamera, cloudDeviceId: 'ID12' });
  const watcher = new EventWatcher({ gladys, cloud: fakeCloud() });
  watcher.config = normalizeConfig({ email: 'a@b.c', password: 'x' });

  const motion = (active) =>
    watcher.handleOnvifEvent(device, 'ID12', { kind: 'motion', active, at: Date.now() });

  await motion(true);
  await motion(false);
  await new Promise((resolve) => setTimeout(resolve, ONVIF_MOTION_FALL_DELAY_MS + 50));

  assert.ok(watcher.motionResets.has('ID12'), 'the fallback must survive a refused fall');
  assert.equal(watcher.motionStates.get('ID12'), true, 'Gladys still shows the motion');
  watcher.stop();
});

test('a camera without a subscription is retried on the next tick', async () => {
  // The setup only runs at startup, so a camera unreachable at that moment
  // stayed on the polled path for the whole life of the process — silently,
  // since only the first failure was logged.
  const gladys = fakeGladys({ devices: [] });
  const device = buildDevice(gladys, { ...doorbellCamera, cloudDeviceId: 'ID13', hasEvents: true });
  gladys.getDevices = async () => [device];

  const watcher = new EventWatcher({ gladys, cloud: fakeCloud() });
  watcher.config = normalizeConfig({ email: 'a@b.c', password: 'x' });
  // Stand in for the real probe+subscribe, which needs a camera on the network.
  const tried = [];
  watcher.setupOnvif = async (target) => {
    tried.push(target.name);
    return false;
  };
  // The polled path must not run: it would need a live local API.
  watcher.checkDevice = async () => {};

  await watcher.tick();
  // The retry is deliberately not awaited by the tick, so let it settle.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(tried, ['Sonnette'], 'the uncovered camera is retried');

  // Once covered, it is left alone: no second subscription for the same camera.
  tried.length = 0;
  watcher.onvifCovered.add('ID13');
  await watcher.tick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(tried, [], 'a covered camera is not probed again');
  watcher.stop();
});

test('a flat camera is polled for its battery alone, and only now and then', async () => {
  // The C610 on the cabin: blocked from capturing at all, and still losing
  // charge visibly. Blocking the captures left the poll untouched, so the camera
  // was woken every `event_poll_interval` for three local calls — 180 wake-ups
  // an hour on a solar cell that only refills in bursts.
  const gladys = fakeGladys();
  const battery = buildDevice(gladys, {
    ...doorbellCamera,
    cloudDeviceId: 'ID15',
    hasBattery: true,
  });
  gladys.devices = [battery];

  const guard = new BatteryGuard();
  guard.update(battery.external_id, BATTERY_THRESHOLDS.STOP_ALL - 1, 'Camera_cabane');

  const watcher = new EventWatcher({ gladys, cloud: fakeCloud(), batteryGuard: guard });
  watcher.config = normalizeConfig({ email: 'a@b.c', password: 'x' });

  let opened = 0;
  const api = fakeLocalApi({ battery: 12, events: [{ eventTime: 1 }] });
  let detections = 0;
  let privacyReads = 0;
  api.getDetections = async () => {
    detections += 1;
    return [];
  };
  api.getPrivacyMode = async () => {
    privacyReads += 1;
    return null;
  };
  watcher.getLocalApi = () => {
    opened += 1;
    return api;
  };

  // First round: the pulse is due, so the battery is read — and nothing else.
  await watcher.checkDevice(battery);
  assert.equal(opened, 1, 'the battery is still read, or the camera could never recover');
  assert.equal(detections, 0, 'a camera that cannot capture has no use for its detections');
  assert.equal(privacyReads, 0, 'nor for its privacy mode');

  // Every round that follows inside the interval must not touch the camera at
  // all — not even opening a session, which is itself a wake-up.
  await watcher.checkDevice(battery);
  await watcher.checkDevice(battery);
  assert.equal(opened, 1, 'no session may be opened between two pulses');

  // Once the interval has passed it is woken again, so a camera charging back up
  // is noticed.
  guard.polledAt.set(battery.external_id, Date.now() - BATTERY_LOW_POLL_INTERVAL_MS - 1);
  await watcher.checkDevice(battery);
  assert.equal(opened, 2, 'the pulse resumes after the interval');
});

test('a healthy battery camera is polled in full', async () => {
  // The throttling must not leak into the normal case: a camera with charge
  // keeps its detections and its privacy mode every round.
  const gladys = fakeGladys();
  const battery = buildDevice(gladys, {
    ...doorbellCamera,
    cloudDeviceId: 'ID16',
    hasBattery: true,
  });
  gladys.devices = [battery];

  const guard = new BatteryGuard();
  guard.update(battery.external_id, 95);

  const watcher = new EventWatcher({ gladys, cloud: fakeCloud(), batteryGuard: guard });
  watcher.config = normalizeConfig({ email: 'a@b.c', password: 'x' });

  let detections = 0;
  const api = fakeLocalApi({ battery: 95 });
  api.getDetections = async () => {
    detections += 1;
    return [];
  };
  watcher.getLocalApi = () => api;

  await watcher.checkDevice(battery);
  await watcher.checkDevice(battery);
  assert.equal(detections, 2, 'a charged camera keeps its full poll every round');
});

test('a solar camera is not asked for a camera account it cannot have', async () => {
  // Solar and wire-free models offer no camera account to create in the Tapo
  // app, so the "ONVIF events unavailable" line sent the user looking for a
  // setting that does not exist — every round, burying the messages that do ask
  // for an action. They have no use for ONVIF either: their detections come
  // from the local list.
  const gladys = fakeGladys();
  const solar = buildDevice(gladys, {
    ...doorbellCamera,
    cloudDeviceId: 'ID17',
    name: 'Camera_cabane',
    model: 'C610',
    hasBattery: true,
  });

  const lines = [];
  const watcher = new EventWatcher({ gladys, cloud: fakeCloud() });
  // No camera account anywhere in the config, exactly the production case.
  watcher.config = normalizeConfig({ email: 'a@b.c', password: 'x' });

  const debug = logger.debug;
  logger.debug = (message) => lines.push(String(message));
  try {
    assert.equal(await watcher.setupOnvif(solar), false, 'it still declines ONVIF');
  } finally {
    logger.debug = debug;
  }
  assert.equal(
    lines.some((line) => line.includes('No camera account')),
    false,
    'nothing must ask for an account this model cannot provide',
  );

  // A wired camera DOES have one to create, so it must keep being told.
  const wired = buildDevice(gladys, {
    ...doorbellCamera,
    cloudDeviceId: 'ID18',
    name: 'Caméra_Salon',
    model: 'C210',
    hasBattery: false,
  });
  lines.length = 0;
  logger.debug = (message) => lines.push(String(message));
  try {
    await watcher.setupOnvif(wired);
  } finally {
    logger.debug = debug;
  }
  assert.ok(
    lines.some((line) => line.includes('No camera account')),
    'a wired camera is still told what is missing',
  );
});
