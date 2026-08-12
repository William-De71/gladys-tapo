// -----------------------------------------------------------------------------
// Device orchestration: turning cloud cameras into Gladys devices.
//
// One camera becomes one device carrying up to four features:
//   camera/image        the snapshot shown by the dashboard widget;
//   button/push         the doorbell press, to trigger scenes;
//   motion-sensor/binary  motion detection;
//   battery/integer     the battery level, on battery models only.
//
// A device keeps everything needed to capture it in its params (IP, model,
// capture mode), so a poll or a `onGetImage` never needs the cloud again.
// -----------------------------------------------------------------------------

import {
  logger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import {
  detectCaptureMode,
  isBatteryModel,
  hasNoLocalAccess,
  buildRtspUrl,
  hasOnvif,
} from './tapo/rtsp.js';
import { hasRtspAccount } from './config.js';
import { discoverLocalAddresses } from './tapo/discovery.js';
import { TapoLocalApi } from './tapo/localApi.js';
import {
  EXTERNAL_ID_TYPE,
  DEVICE_PARAMS,
  CAPTURE_MODES,
  FEATURE_SUFFIXES,
  POLL_FREQUENCY_MS,
} from './tapo/constants.js';

/**
 * Build the external ids of one camera through the SDK. Gladys namespaces every
 * external id as `ext:<selector>:<type>:<platformId>` and rejects anything else,
 * so these ids must never be assembled by hand.
 *
 * The cloud device id plays the `platformId` part: it is the only identifier that
 * survives a rename or an IP change.
 * @param {object} gladys - The SDK instance.
 * @param {string} cloudDeviceId - The cloud device id.
 * @returns {object} The device id and the feature id factory.
 * @example
 * const ids = cameraIds(gladys, '80224A...');
 * ids.device; // 'ext:ext-dev-tapo:camera:80224A...'
 */
export function cameraIds(gladys, cloudDeviceId) {
  return gladys.externalIds(EXTERNAL_ID_TYPE, cloudDeviceId);
}

/**
 * Extract the cloud device id from a device or feature external id.
 * @param {string} externalId - The external id.
 * @returns {string|null} The cloud device id, or null when unparseable.
 * @example
 * parseCloudDeviceId('ext:ext-dev-tapo:camera:80224A...:image'); // '80224A...'
 */
export function parseCloudDeviceId(externalId) {
  // `ext:<selector>:<type>:<platformId>[:<feature>]` — the platform id is the
  // fourth segment, whether the id points at the device or at one of its features.
  const parts = String(externalId || '').split(':');
  if (parts[0] !== 'ext' || parts[2] !== EXTERNAL_ID_TYPE || !parts[3]) {
    return null;
  }
  return parts[3];
}

/**
 * Read a device param by name.
 * @param {object} device - The Gladys device.
 * @param {string} name - The param name.
 * @returns {string|null} The value, or null when absent.
 * @example
 * getParam(device, 'TAPO_IP');
 */
export function getParam(device, name) {
  const param = (device.params || []).find((entry) => entry.name === name);
  return param ? String(param.value) : null;
}

/**
 * Build the features of a camera. The doorbell and motion features only exist on
 * battery models, whose events the cloud reports; a wired camera would carry a
 * feature that never updates.
 * @param {object} gladys - The SDK instance, which namespaces the ids.
 * @param {object} camera - The resolved camera.
 * @returns {object[]} The features.
 * @example
 * buildFeatures(gladys, camera);
 */
export function buildFeatures(gladys, camera) {
  const ids = cameraIds(gladys, camera.cloudDeviceId);
  const features = [
    {
      name: camera.name,
      external_id: ids.feature(FEATURE_SUFFIXES.IMAGE),
      category: DEVICE_FEATURE_CATEGORIES.CAMERA,
      type: DEVICE_FEATURE_TYPES.CAMERA.IMAGE,
      read_only: false,
      keep_history: false,
      has_feedback: false,
      min: 0,
      max: 0,
    },
  ];

  if (camera.hasEvents) {
    features.push(
      {
        name: `${camera.name} - Doorbell`,
        external_id: ids.feature(FEATURE_SUFFIXES.BUTTON),
        category: DEVICE_FEATURE_CATEGORIES.BUTTON,
        type: DEVICE_FEATURE_TYPES.BUTTON.PUSH,
        read_only: true,
        keep_history: true,
        has_feedback: false,
        min: 0,
        max: 1,
      },
      {
        name: `${camera.name} - Motion`,
        external_id: ids.feature(FEATURE_SUFFIXES.MOTION),
        category: DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
        read_only: true,
        keep_history: true,
        has_feedback: false,
        min: 0,
        max: 1,
      },
    );
  }

  // Created unless the camera EXPLICITLY answered that it has no lens mask.
  // `hasPrivacyMode` is null when the question could not be asked — no local
  // address, camera asleep, firmware without the method — and a switch that is
  // missing is worse than one that is briefly unresponsive: the scenes built on
  // it would break silently.
  if (camera.hasPrivacyMode !== null && camera.hasPrivacyMode !== undefined) {
    features.push({
      name: `${camera.name} - Privacy mode`,
      external_id: ids.feature(FEATURE_SUFFIXES.PRIVACY),
      category: DEVICE_FEATURE_CATEGORIES.SWITCH,
      type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
      read_only: false,
      keep_history: true,
      // The only feature here whose state is genuinely readable back from the
      // camera: the poll re-reads it, so a toggle made in the Tapo app shows up
      // in Gladys instead of leaving the switch lying.
      has_feedback: true,
      min: 0,
      max: 1,
    });
  }

  if (camera.hasBattery) {
    features.push({
      name: `${camera.name} - Battery`,
      external_id: ids.feature(FEATURE_SUFFIXES.BATTERY),
      category: DEVICE_FEATURE_CATEGORIES.BATTERY,
      type: DEVICE_FEATURE_TYPES.BATTERY.INTEGER,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      read_only: true,
      keep_history: true,
      has_feedback: false,
      min: 0,
      max: 100,
    });
  }

  return features;
}

/**
 * Build the Gladys device of one camera.
 * @param {object} gladys - The SDK instance, which namespaces the ids.
 * @param {object} camera - The resolved camera.
 * @returns {object} The device, ready to be published.
 * @example
 * buildDevice(gladys, camera);
 */
export function buildDevice(gladys, camera) {
  return {
    name: camera.name,
    external_id: cameraIds(gladys, camera.cloudDeviceId).device,
    model: camera.model || null,
    // The dashboard widget shows the last PUBLISHED image, never a fresh one, so
    // the poll is what keeps it up to date (see `onPoll`). Without this, the
    // widget would stay empty until a doorbell press.
    should_poll: true,
    poll_frequency: POLL_FREQUENCY_MS,
    features: buildFeatures(gladys, camera),
    params: [
      { name: DEVICE_PARAMS.CLOUD_DEVICE_ID, value: camera.cloudDeviceId },
      { name: DEVICE_PARAMS.IP, value: camera.ip || '' },
      { name: DEVICE_PARAMS.MODEL, value: camera.model || '' },
      { name: DEVICE_PARAMS.CAPTURE_MODE, value: camera.captureMode || '' },
      // The live view of the dashboard widget calls the rtsp-camera service,
      // which streams ANY device carrying a CAMERA_URL param — whatever service
      // owns it. Publishing the RTSP URL here is therefore what unlocks the live
      // video for an external integration.
      { name: DEVICE_PARAMS.CAMERA_URL, value: camera.streamUrl || '' },
      { name: DEVICE_PARAMS.CAMERA_ROTATION, value: '0' },
    ],
  };
}

/**
 * Ask a camera whether it supports the privacy mode, and what its current state
 * is.
 *
 * Asked rather than deduced from the model, for the reason this project already
 * recorded in `NO_LOCAL_ACCESS_MODELS`: a capability guessed from a model string
 * is a capability guessed wrong.
 *
 * Unlike the ONVIF probes, this one needs no camera account — the local API
 * authenticates with the TP-Link account password — so it covers the battery
 * models too, which expose no ONVIF at all.
 * @param {object} camera - The resolved camera.
 * @param {object} config - The normalized configuration.
 * @returns {Promise<boolean|null>} The current state, or null when the camera
 * does not support it or could not be asked.
 * @example
 * const isPrivate = await probePrivacyMode(camera, config);
 */
export async function probePrivacyMode(camera, config) {
  if (!camera.ip || !config.password) {
    return null;
  }

  // A short-lived session of its own: the watcher's cache is keyed by IP and
  // owned by the event loop, and borrowing from it here — during a scan, before
  // any device exists — would race with it. Closed below so the camera frees the
  // slot right away rather than in a few minutes; the firmware only keeps a few.
  const api = new TapoLocalApi(camera.ip, config.password);
  try {
    const state = await api.getPrivacyMode();
    if (state === null) {
      // The call went through and the camera answered with a shape carrying no
      // lens mask — an older firmware without the feature.
      logger.info(`"${camera.name}" reports no privacy mode: no switch created`);
    }
    return state;
  } catch (e) {
    // Logged at INFO, not debug. This decides whether a camera gets a switch at
    // all, and hiding it left the only symptom being a control that never
    // appeared — undiagnosable without attaching a debugger to the integration.
    // `TAPO_LOCAL_NO_NONCE` here means the camera refused the local session
    // outright, which some firmwares do whatever credentials are offered.
    logger.info(
      `"${camera.name}" refused the local session (${e.message}): no privacy switch created`,
    );
    // Never `false`: "the camera refused the call" and "the camera has no lens
    // mask" must not lead to the same conclusion, since one of them would
    // silently drop the switch of a camera that has one.
    return null;
  } finally {
    api.close();
  }
}

/**
 * Resolve a cloud camera into everything needed to talk to it: its capabilities,
 * and the capture mode its open ports reveal.
 * @param {object} cloudCamera - The camera as returned by the cloud.
 * @param {object} config - The normalized configuration.
 * @returns {Promise<object>} The resolved camera.
 * @example
 * const camera = await resolveCamera(cloudCamera, config);
 */
export async function resolveCamera(cloudCamera, config) {
  const battery = isBatteryModel(cloudCamera.model);
  const camera = {
    ...cloudCamera,
    hasBattery: battery,
    // Battery models report their doorbell/motion through the local detection
    // list. Wired cameras have no such list — their events come from ONVIF,
    // which the probe below decides on.
    hasEvents: battery,
    hasOnvif: false,
    noLocalAccess: hasNoLocalAccess(cloudCamera.model),
    captureMode: null,
  };

  if (camera.noLocalAccess) {
    // Probing is pointless: TP-Link blocks every local path on these models.
    logger.warn(
      `"${camera.name}" (${camera.model}) blocks third-party local access: no image can be captured from it.`,
    );
    return camera;
  }

  if (!camera.ip) {
    // Nothing to probe: the cloud reported no address and none was configured.
    logger.warn(
      `"${camera.name}" (${camera.model}) has no known local address. Add it under "Camera addresses" as "${camera.name}|192.168.x.y".`,
    );
    return camera;
  }

  // Independent round trips on the same camera, so they run together rather than
  // one after the other. The privacy probe joins them because it depends on
  // neither: it speaks the local API, not ONVIF, so a battery camera without any
  // ONVIF at all still gets its switch.
  const [captureMode, onvif, privacyMode] = await Promise.all([
    detectCaptureMode(camera, config),
    hasOnvif(camera),
    probePrivacyMode(camera, config),
  ]);
  camera.captureMode = captureMode;
  camera.hasOnvif = onvif;
  camera.hasPrivacyMode = privacyMode;

  // A camera serving ONVIF can report motion, whether or not it runs on battery
  // — which is what gives a wired camera a motion sensor it never had. The
  // feature is created on the open port alone: the camera account may well be
  // filled in later, and a feature that only appeared then would leave the
  // scenes written in the meantime pointing at nothing.
  if (onvif) {
    camera.hasEvents = true;
  }

  // Only an RTSP camera can feed the live view: the rtsp-camera service hands the
  // URL straight to ffmpeg, so the proprietary protocol — which needs an
  // encrypted session this integration owns — cannot be expressed as a URL.
  if (camera.captureMode === CAPTURE_MODES.RTSP && hasRtspAccount(config, camera.name)) {
    camera.streamUrl = buildRtspUrl(camera, config);
  }

  if (camera.captureMode) {
    logger.info(`"${camera.name}" (${camera.ip}) will be captured over ${camera.captureMode}`);
  } else {
    logger.warn(
      `"${camera.name}" (${camera.ip}) answers on neither port 554 nor 8800. Check that Gladys can reach it on your network.`,
    );
  }
  return camera;
}

/**
 * Resolve every cloud camera and build the devices to publish.
 * @param {object} gladys - The SDK instance, which namespaces the ids.
 * @param {object[]} cloudCameras - The cameras returned by the cloud.
 * @param {object} config - The normalized configuration.
 * @returns {Promise<object[]>} The devices.
 * @example
 * const devices = await buildDiscoveredDevices(gladys, cameras, config);
 */
export async function buildDiscoveredDevices(gladys, cloudCameras, config) {
  // The cloud knows WHICH cameras exist but not WHERE they are, so the local
  // addresses come from a network scan. A manual address stays authoritative:
  // the user typed it precisely because automatic detection did not suit.
  const discovered = await discoverLocalAddresses(gladys);
  const located = cloudCameras.map((cloudCamera) => ({
    ...cloudCamera,
    ip: cloudCamera.ip || discovered.get(String(cloudCamera.cloudDeviceId).toUpperCase()) || '',
  }));

  // Probing is I/O bound and independent per camera, so resolve them together.
  const cameras = await Promise.all(located.map((camera) => resolveCamera(camera, config)));
  return cameras.map((camera) => buildDevice(gladys, camera));
}

/**
 * Rebuild a resolved camera from a device Gladys created, so a capture needs no
 * cloud call. The capture mode is re-probed when the params carry none (a camera
 * added before its ports answered, or a mode that changed since).
 * @param {object} device - The Gladys device.
 * @param {object} config - The normalized configuration.
 * @returns {Promise<object>} The resolved camera.
 * @example
 * const camera = await cameraFromDevice(device, config);
 */
export async function cameraFromDevice(device, config) {
  const cloudDeviceId =
    getParam(device, DEVICE_PARAMS.CLOUD_DEVICE_ID) || parseCloudDeviceId(device.external_id);
  const camera = {
    cloudDeviceId,
    name: device.name || 'Tapo Camera',
    model: getParam(device, DEVICE_PARAMS.MODEL) || '',
    ip: getParam(device, DEVICE_PARAMS.IP) || '',
    captureMode: getParam(device, DEVICE_PARAMS.CAPTURE_MODE) || null,
  };

  // The user may have typed the address by hand after creating the device. The
  // device can also have been renamed in Gladys since, so the cloud device id is
  // accepted as a key too — the only name that never changes.
  if (!camera.ip) {
    camera.ip =
      config.camera_ips[camera.name.toLowerCase()] ||
      config.camera_ips[String(cloudDeviceId).toLowerCase()] ||
      '';
  }

  if (!camera.captureMode && camera.ip) {
    camera.captureMode = await detectCaptureMode(camera, config);
  }
  // Without a known mode, the proprietary protocol is the safer guess: it is the
  // one that works without a camera account.
  if (!camera.captureMode) {
    camera.captureMode = CAPTURE_MODES.PROPRIETARY;
  }
  return camera;
}
