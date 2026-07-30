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
} from '../src/devices.js';
import { isBatteryModel, hasNoLocalAccess, buildRtspUrl } from '../src/tapo/rtsp.js';
import { normalizeConfig } from '../src/config.js';
import { fakeGladys } from './helpers/fakeGladys.js';
import { DEVICE_PARAMS, CAPTURE_MODES } from '../src/tapo/constants.js';

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
