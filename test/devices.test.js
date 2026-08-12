import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cameraIds,
  buildDiscoveredDevices,
  parseCloudDeviceId,
  getParam,
  buildFeatures,
  buildDevice,
  cameraFromDevice,
  probePrivacyMode,
  forgetRefusedCredentials,
} from '../src/devices.js';
import { isBatteryModel, hasNoLocalAccess, buildRtspUrl } from '../src/tapo/rtsp.js';
import { normalizeConfig } from '../src/config.js';
import { fakeGladys } from './helpers/fakeGladys.js';
import { DEVICE_PARAMS, CAPTURE_MODES } from '../src/tapo/constants.js';
import { TapoLocalApi } from '../src/tapo/localApi.js';

const gladys = fakeGladys();

const camera = {
  cloudDeviceId: 'ID1',
  name: 'Jardin',
  model: 'C210',
  ip: '192.168.1.20',
  captureMode: CAPTURE_MODES.RTSP,
  hasBattery: false,
  hasEvents: false,
};

test('the external ids carry the namespace Gladys requires', () => {
  // Gladys rejects with a 400 any external_id not starting with
  // `ext:<selector>:`, so the ids must come from the SDK, never be hand-built.
  const ids = cameraIds(gladys, 'ID1');
  assert.equal(ids.device, 'ext:ext-dev-tapo:camera:ID1');
  assert.equal(ids.feature('image'), 'ext:ext-dev-tapo:camera:ID1:image');
});

test('the cloud device id is recovered from either external id', () => {
  assert.equal(parseCloudDeviceId('ext:ext-dev-tapo:camera:ID1'), 'ID1');
  assert.equal(parseCloudDeviceId('ext:ext-dev-tapo:camera:ID1:image'), 'ID1');
  assert.equal(parseCloudDeviceId('tapo:ID1'), null);
  assert.equal(parseCloudDeviceId(''), null);
});

test('a wired camera only carries the image feature', () => {
  // A doorbell feature on a wired camera would never update.
  const features = buildFeatures(gladys, camera);
  assert.equal(features.length, 1);
  assert.equal(features[0].category, 'camera');
  assert.equal(features[0].type, 'image');
  assert.equal(features[0].read_only, false, 'the widget must be able to ask for an image');
});

test('a battery doorbell carries image, button, motion and battery', () => {
  const features = buildFeatures(gladys, { ...camera, hasBattery: true, hasEvents: true });
  assert.deepEqual(
    features.map((feature) => feature.category),
    ['camera', 'button', 'motion-sensor', 'battery'],
  );
  const motion = features.find((feature) => feature.category === 'motion-sensor');
  assert.equal(motion.type, 'binary');
  const battery = features.find((feature) => feature.category === 'battery');
  assert.equal(battery.unit, 'percent');
  assert.equal(battery.max, 100);
});

test('the device keeps everything a capture needs in its params', () => {
  // A poll or an onGetImage must never need a cloud round-trip.
  const device = buildDevice(gladys, camera);
  assert.equal(device.external_id, 'ext:ext-dev-tapo:camera:ID1');
  assert.equal(getParam(device, DEVICE_PARAMS.IP), '192.168.1.20');
  assert.equal(getParam(device, DEVICE_PARAMS.MODEL), 'C210');
  assert.equal(getParam(device, DEVICE_PARAMS.CAPTURE_MODE), CAPTURE_MODES.RTSP);
  assert.equal(getParam(device, DEVICE_PARAMS.CLOUD_DEVICE_ID), 'ID1');
  assert.equal(getParam(device, 'NOPE'), null);
});

test('battery models are recognized by their model prefix', () => {
  // Matched as a prefix so C420S2 matches C420.
  assert.equal(isBatteryModel('C425'), true);
  assert.equal(isBatteryModel('C420S2'), true);
  assert.equal(isBatteryModel('D230'), true);
  assert.equal(isBatteryModel('C210'), false);
  assert.equal(isBatteryModel(''), false);
});

test('no model is blocked on its name alone', () => {
  // The C610 used to be listed as having no local access. Measuring proved the
  // opposite: it serves its video over the proprietary protocol. Reachability is
  // decided by probing the ports, never by a model name.
  assert.equal(hasNoLocalAccess('C610'), false);
  assert.equal(hasNoLocalAccess('C210'), false);
});

test('the RTSP URL percent-encodes the camera account', () => {
  // Camera passwords often contain @ or :, which would break the URL.
  const config = normalizeConfig({
    rtsp_username: 'user@home',
    rtsp_password: 'p@ss:word',
    stream_quality: 'SD',
  });
  const url = buildRtspUrl({ ip: '192.168.1.20' }, config);
  assert.equal(url, 'rtsp://user%40home:p%40ss%3Aword@192.168.1.20:554/stream2');
});

test('a camera is rebuilt from its device without touching the cloud', async () => {
  const device = buildDevice(gladys, { ...camera, hasBattery: true, hasEvents: true });
  const rebuilt = await cameraFromDevice(device, normalizeConfig());
  assert.equal(rebuilt.cloudDeviceId, 'ID1');
  assert.equal(rebuilt.ip, '192.168.1.20');
  assert.equal(rebuilt.captureMode, CAPTURE_MODES.RTSP);
});

test('a device with no stored IP picks up the manual address', async () => {
  const device = buildDevice(gladys, { ...camera, ip: '', captureMode: CAPTURE_MODES.PROPRIETARY });
  const config = normalizeConfig({ camera_ips: 'jardin|192.168.1.99' });
  const rebuilt = await cameraFromDevice(device, config);
  assert.equal(rebuilt.ip, '192.168.1.99');
});

test('an unknown capture mode falls back to the proprietary protocol', async () => {
  // It is the mode that works without a camera account, so the safer guess.
  const device = buildDevice(gladys, { ...camera, ip: '', captureMode: null });
  const rebuilt = await cameraFromDevice(device, normalizeConfig());
  assert.equal(rebuilt.captureMode, CAPTURE_MODES.PROPRIETARY);
});

test('every published external id is namespaced, device and features alike', async () => {
  // The bug this pins: Gladys answers 400 "must start with ext:<selector>:" and
  // refuses the whole publish if a single id is hand-built.
  const devices = await buildDiscoveredDevices(
    gladys,
    [{ cloudDeviceId: 'ID9', name: 'Sonnette', model: 'D230', ip: '' }],
    normalizeConfig(),
  );
  const prefix = `ext:${gladys.selector}:`;
  for (const device of devices) {
    assert.ok(device.external_id.startsWith(prefix), `device: ${device.external_id}`);
    for (const feature of device.features) {
      assert.ok(feature.external_id.startsWith(prefix), `feature: ${feature.external_id}`);
    }
  }
});

test('a camera device asks to be polled', () => {
  // The dashboard widget displays the last PUBLISHED image and never asks for a
  // fresh one, so without a poll it would stay empty forever.
  const device = buildDevice(gladys, camera);
  assert.equal(device.should_poll, true);
  // Must be one of the frequencies the core accepts, or the publish is rejected.
  assert.ok([1000, 2000, 10000, 15000, 30000, 60000].includes(device.poll_frequency));
});

test('an RTSP camera publishes its stream URL for the live view', async () => {
  // The dashboard live view calls the rtsp-camera service, which streams any
  // device carrying a CAMERA_URL param. Without it, no live video is possible.
  const config = normalizeConfig({ rtsp_username: 'user', rtsp_password: 'pass' });
  const resolved = { ...camera, streamUrl: buildRtspUrl(camera, config) };
  const device = buildDevice(gladys, resolved);
  const url = getParam(device, DEVICE_PARAMS.CAMERA_URL);
  assert.match(url, /^rtsp:\/\/user:pass@192\.168\.1\.20:554\/stream1$/);
  assert.equal(getParam(device, DEVICE_PARAMS.CAMERA_ROTATION), '0');
});

test('a camera with no stream URL publishes an empty one, never a broken one', () => {
  // A proprietary-protocol camera cannot be expressed as a URL: rtsp-camera
  // would hand a bogus URL to ffmpeg and fail in a confusing way.
  const device = buildDevice(gladys, { ...camera, streamUrl: undefined });
  assert.equal(getParam(device, DEVICE_PARAMS.CAMERA_URL), '');
});

// --- Privacy mode feature -----------------------------------------------------

test('a camera that answered gets a privacy switch, in either state', () => {
  [true, false].forEach((state) => {
    const features = buildFeatures(gladys, { ...camera, hasPrivacyMode: state });
    const privacy = features.find((feature) => feature.category === 'switch');
    assert.ok(privacy, `a camera reporting ${state} must expose the switch`);
    assert.equal(privacy.type, 'binary');
    assert.equal(privacy.read_only, false);
    // The one feature here whose state is genuinely readable back, which is what
    // lets a toggle made in the Tapo app show up in Gladys.
    assert.equal(privacy.has_feedback, true);
    assert.equal(privacy.min, 0);
    assert.equal(privacy.max, 1);
  });
});

test('a camera that could not be asked gets no privacy switch', () => {
  // `null` is "unknown", and an unknown capability must not become a switch
  // wired to nothing.
  assert.ok(
    !buildFeatures(gladys, { ...camera, hasPrivacyMode: null }).some(
      (feature) => feature.category === 'switch',
    ),
  );
  assert.ok(!buildFeatures(gladys, camera).some((feature) => feature.category === 'switch'));
});

test('the privacy switch is told apart from the motion sensor', () => {
  // Both are typed `binary` in Gladys — only the category separates them, which
  // is exactly why the command path routes on the category.
  const features = buildFeatures(gladys, {
    ...camera,
    hasEvents: true,
    hasPrivacyMode: false,
  });
  const binaries = features.filter((feature) => feature.type === 'binary');
  assert.equal(binaries.length, 2, 'motion and privacy both type as binary');
  assert.deepEqual(binaries.map((feature) => feature.category).sort(), ['motion-sensor', 'switch']);
  // Only one of the two is writable.
  assert.deepEqual(binaries.map((feature) => feature.read_only).sort(), [false, true]);
});

// --- Privacy probe credentials and lockout ------------------------------------

test('the camera account waits for the NEXT scan, never the same one', async () => {
  // Two failed logins back to back is what arms the camera's brute-force
  // protection: measured, one container update — so one scan — locked a C210
  // out for half an hour. The second account therefore gets its turn one scan
  // later, with the refusal remembered in between.
  const seen = [];
  const probed = { ...camera, ip: '10.0.0.5' };
  const withAccount = normalizeConfig({
    email: 'a@b.c',
    password: 'cloud-secret',
    camera_accounts: 'jardin|william|camera-secret',
  });

  // The probe opens its own client, so the constructor is what has to be
  // observed; recording the arguments is enough to pin which account is used.
  const original = TapoLocalApi.prototype.getPrivacyMode;
  TapoLocalApi.prototype.getPrivacyMode = async function record() {
    seen.push({ username: this.username, password: this.password });
    if (this.password === 'cloud-secret') {
      throw new Error('TAPO_LOCAL_BAD_PASSWORD');
    }
    return false;
  };
  try {
    // First scan: the cloud password only, and it is rejected.
    assert.equal(await probePrivacyMode(probed, withAccount), null);
    assert.equal(seen.length, 1, 'one login per scan, never two');

    // Second scan: now the camera account, and it works.
    assert.equal(await probePrivacyMode(probed, withAccount), false);
  } finally {
    TapoLocalApi.prototype.getPrivacyMode = original;
    forgetRefusedCredentials();
  }

  assert.deepEqual(seen, [
    { username: 'admin', password: 'cloud-secret' },
    { username: 'william', password: 'camera-secret' },
  ]);
});

test('a camera the Tapo password suits is not bothered with a second login', async () => {
  // The regression this pins: preferring the camera account took the switch away
  // from a C500 that the cloud password had been serving all along. Every extra
  // login is also a step towards the lockout.
  const seen = [];
  const probed = { ...camera, ip: '10.0.0.10' };
  const withAccount = normalizeConfig({
    email: 'a@b.c',
    password: 'cloud-secret',
    camera_accounts: 'jardin|william|camera-secret',
  });

  const original = TapoLocalApi.prototype.getPrivacyMode;
  TapoLocalApi.prototype.getPrivacyMode = async function record() {
    seen.push(this.password);
    return true;
  };
  try {
    assert.equal(await probePrivacyMode(probed, withAccount), true);
  } finally {
    TapoLocalApi.prototype.getPrivacyMode = original;
    forgetRefusedCredentials();
  }

  assert.deepEqual(seen, ['cloud-secret']);
});

test('a locked-out camera is not tried with the other account either', async () => {
  // Trying the second account would add a failed login to a camera that is
  // already counting them, which is what deepens the lockout.
  const seen = [];
  const probed = { ...camera, ip: '10.0.0.11' };
  const withAccount = normalizeConfig({
    email: 'a@b.c',
    password: 'cloud-secret',
    camera_accounts: 'jardin|william|camera-secret',
  });

  const original = TapoLocalApi.prototype.getPrivacyMode;
  TapoLocalApi.prototype.getPrivacyMode = async function locked() {
    seen.push(this.password);
    throw new Error('TAPO_LOCAL_NO_NONCE:-40401');
  };
  try {
    assert.equal(await probePrivacyMode(probed, withAccount), null);
  } finally {
    TapoLocalApi.prototype.getPrivacyMode = original;
    forgetRefusedCredentials();
  }

  assert.deepEqual(seen, ['cloud-secret'], 'a locked-out camera is touched once, not twice');
});

test('a camera with no camera account falls back to the Tapo password', async () => {
  const seen = [];
  const probed = { ...camera, ip: '10.0.0.6' };
  const cloudOnly = normalizeConfig({ email: 'a@b.c', password: 'cloud-secret' });

  const original = TapoLocalApi.prototype.getPrivacyMode;
  TapoLocalApi.prototype.getPrivacyMode = async function record() {
    seen.push({ username: this.username, password: this.password });
    return true;
  };
  try {
    await probePrivacyMode(probed, cloudOnly);
  } finally {
    TapoLocalApi.prototype.getPrivacyMode = original;
  }

  assert.deepEqual(seen, [{ username: 'admin', password: 'cloud-secret' }]);
});

test('a camera with no camera account is given up on after one rejection', async () => {
  // Retrying is what walks a camera into an escalating lockout: measured on a
  // C210, five minutes after a few attempts and twenty-nine after a few more.
  // A missing switch costs far less than a camera locked out of every path.
  let attempts = 0;
  const probed = { ...camera, ip: '10.0.0.7' };
  const cloudOnly = normalizeConfig({ email: 'a@b.c', password: 'wrong' });

  const original = TapoLocalApi.prototype.getPrivacyMode;
  TapoLocalApi.prototype.getPrivacyMode = async function refuse() {
    attempts += 1;
    throw new Error('TAPO_LOCAL_BAD_PASSWORD');
  };
  try {
    assert.equal(await probePrivacyMode(probed, cloudOnly), null);
    assert.equal(await probePrivacyMode(probed, cloudOnly), null);
    assert.equal(attempts, 1, 'the second scan must not touch the camera again');

    // The user fixing their settings is exactly the moment to try again.
    forgetRefusedCredentials();
    await probePrivacyMode(probed, cloudOnly);
    assert.equal(attempts, 2);
  } finally {
    TapoLocalApi.prototype.getPrivacyMode = original;
    forgetRefusedCredentials();
  }
});

test('a locked-out camera is left alone rather than probed again', async () => {
  // The case the first guard missed: a camera that already locked the address
  // out answers NO_NONCE, not BAD_PASSWORD. Retrying is what KEEPS it locked —
  // measured, one further scan bought a C210 another 27 minutes.
  let attempts = 0;
  const probed = { ...camera, ip: '10.0.0.8' };
  const cloudOnly = normalizeConfig({ email: 'a@b.c', password: 'x' });

  const original = TapoLocalApi.prototype.getPrivacyMode;
  TapoLocalApi.prototype.getPrivacyMode = async function refuse() {
    attempts += 1;
    throw new Error('TAPO_LOCAL_NO_NONCE:-40401');
  };
  try {
    await probePrivacyMode(probed, cloudOnly);
    await probePrivacyMode(probed, cloudOnly);
    assert.equal(attempts, 1, 'a locked-out camera must be touched once, not every scan');
  } finally {
    TapoLocalApi.prototype.getPrivacyMode = original;
    forgetRefusedCredentials();
  }
});

test('an unreachable camera is retried, since it said nothing about its account', async () => {
  // A timeout is not a refusal: a camera that was asleep or briefly off the
  // network must be probed again, or it would lose its switch until a restart.
  let attempts = 0;
  const probed = { ...camera, ip: '10.0.0.9' };
  const cloudOnly = normalizeConfig({ email: 'a@b.c', password: 'x' });

  const original = TapoLocalApi.prototype.getPrivacyMode;
  TapoLocalApi.prototype.getPrivacyMode = async function timeout() {
    attempts += 1;
    throw new Error('TAPO_LOCAL_TIMEOUT');
  };
  try {
    await probePrivacyMode(probed, cloudOnly);
    await probePrivacyMode(probed, cloudOnly);
    assert.equal(attempts, 2);
  } finally {
    TapoLocalApi.prototype.getPrivacyMode = original;
    forgetRefusedCredentials();
  }
});
