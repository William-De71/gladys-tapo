// -----------------------------------------------------------------------------
// Entry point of the Tapo external integration.
//
// Role of this file: wire the SDK to the cloud client (discovery), the capture
// modules (images) and the event watcher (doorbell, motion, battery).
//
// Split of responsibilities, which explains why both an image handler and an
// event loop exist:
//   - the CLOUD knows which cameras exist and reports their events;
//   - the LOCAL network delivers the images, never the cloud.
//
// The image reaches Gladys two ways: `onGetImage` when the dashboard widget or
// the chat asks for a fresh frame, and `publishCameraImage` when a doorbell press
// happens — so the image is already there when the user looks at the
// notification.
// -----------------------------------------------------------------------------

import {
  GladysIntegration,
  logger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
} from '@gladysassistant/integration-sdk';
import { TapoCloud, TapoAuthError } from './src/tapo/cloud.js';
import { EventWatcher } from './src/tapo/events.js';
import { captureImage } from './src/tapo/snapshot.js';
import { normalizeConfig, isConfigured, hasRtspAccount, resolveRtspAccount } from './src/config.js';
import {
  buildDiscoveredDevices,
  cameraFromDevice,
  parseCloudDeviceId,
  forgetRefusedCredentials,
} from './src/devices.js';
import { TapoPtz } from './src/tapo/ptz.js';
import {
  CAPTURE_MODES,
  DEVICE_PARAMS,
  CAMERA_MOVE,
  FEATURE_SUFFIXES,
  EXTERNAL_ID_TYPE,
} from './src/tapo/constants.js';
import { BatteryGuard } from './src/tapo/batteryGuard.js';
import { isBatteryModel, probePort } from './src/tapo/rtsp.js';
import { buildConnectionReport, connectionStatusFor, isValidAddress } from './src/report.js';
import { forgetLastScan } from './src/tapo/discovery.js';

const gladys = new GladysIntegration();
const cloud = new TapoCloud();
// Guards the battery of solar/wire-free cameras: capturing is what drains them,
// so it backs off well before the cell reaches a level it may not recover from.
const batteryGuard = new BatteryGuard();

let config = normalizeConfig();

/** When each device was last captured, to honour its own refresh interval. */
const lastCaptureAt = new Map();

/**
 * Captures in flight, per device. Four paths can ask for the same camera at the
 * same moment — the refresh loop, the poll, the widget and a doorbell press —
 * and each used to open its own session: two ffmpeg processes on a Raspberry
 * Pi, two wake-ups of a battery camera, and a firmware that only accepts a few
 * sessions refusing the second. They now share the one already running.
 * @type {Map<string, Promise<string>>}
 */
const capturesInFlight = new Map();

/** One PTZ client per device, keyed by external id. */
const ptzClients = new Map();

/**
 * Tell whether a device is one of the battery/solar cameras.
 *
 * Read from the model rather than from the presence of a battery feature: the
 * model is known before the camera has ever answered, and it is precisely the
 * camera that never answers which must not be captured on a loop.
 * @param {object} device - The Gladys device.
 * @returns {boolean} True when the battery rules apply.
 * @example
 * isBatteryDevice(device);
 */
function isBatteryDevice(device) {
  // A model that looked like a battery one but answered it has none.
  if (batteryGuard.isKnownMains(device.external_id)) {
    return false;
  }
  if (batteryGuard.isBatteryCamera(device.external_id)) {
    return true;
  }
  if (isBatteryModel(device.model || '')) {
    return true;
  }
  const model = (device.params || []).find((param) => param.name === DEVICE_PARAMS.MODEL);
  return isBatteryModel(model?.value || '');
}

/**
 * The PTZ client of a device, built once and kept.
 *
 * Reused across commands on purpose: the client caches the PTZ service address
 * and the media profile, which cost two round trips to discover — rediscovering
 * them on every arrow press would make the camera feel sluggish.
 *
 * The device is RE-READ rather than used as handed over: a command payload
 * carries only the external id, the selector and the params — no `name`. A
 * camera account typed in the manual field is indexed BY NAME, so building the
 * client from the payload alone looked up an account for "undefined" and every
 * movement was refused. (An account saved by the action is keyed by cloud id,
 * which the external id carries.)
 * @param {object} device - The Gladys device, as the command payload carries it.
 * @returns {Promise<object|null>} The client, or null without a camera account.
 * @example
 * const ptz = await getPtzClient(device);
 */
async function getPtzClient(device) {
  const existing = ptzClients.get(device.external_id);
  if (existing) {
    return existing;
  }

  // Only on the first command of a camera: the client is then cached, so the
  // arrows that follow cost nothing extra.
  const known = await gladys
    .getDevices()
    .then((devices) => devices.find((entry) => entry.external_id === device.external_id))
    .catch(() => null);
  const name = known?.name || device.name;

  // The params of the payload are authoritative — they are the ones Gladys just
  // sent — but a re-read device carries them too when the payload has none.
  const params = device.params || known?.params || [];
  const ip = params.find((param) => param.name === DEVICE_PARAMS.IP)?.value;
  const account = resolveRtspAccount(config, {
    name,
    cloudDeviceId: parseCloudDeviceId(device.external_id),
  });
  if (!ip || !account.username || !account.password) {
    return null;
  }

  const client = new TapoPtz(ip, account.username, account.password);
  ptzClients.set(device.external_id, client);
  return client;
}

/**
 * Map a preset option value back to the camera's own token.
 *
 * The feature carries an integer because Gladys options are integers; ONVIF
 * identifies a preset by free text. The device params hold the tokens in option
 * order, which is what makes the translation a lookup rather than a call to the
 * camera.
 * @param {object} device - The Gladys device.
 * @param {number} value - The option value received.
 * @returns {string|null} The token, or null when out of range.
 * @example
 * presetTokenFor(device, 0); // '1'
 */
function presetTokenFor(device, value) {
  const raw = (device.params || []).find((param) => param.name === DEVICE_PARAMS.PRESET_TOKENS);
  const tokens = String(raw?.value || '')
    .split(',')
    .filter(Boolean);
  const index = Number(value);
  return tokens[index] || null;
}

/**
 * How long to wait between two automatic captures of a device.
 *
 * Battery cameras get their own interval on purpose: the two used to share one
 * setting, so sparing a solar camera meant letting every wired camera's image go
 * stale as well. They are unrelated costs and now unrelated settings.
 * @param {object} device - The Gladys device.
 * @returns {number} The interval, in seconds.
 * @example
 * refreshIntervalFor(device);
 */
function refreshIntervalFor(device) {
  return isBatteryDevice(device)
    ? config.battery_image_refresh_interval
    : config.image_refresh_interval;
}

/**
 * Tell whether the automatic refresh of a device is due.
 *
 * The scheduler ticks far more often than a battery camera should be captured —
 * `onPoll` alone fires every minute, and it must keep firing to read the battery
 * and the events. This is what keeps that frequent tick from turning into a
 * frequent capture.
 * @param {object} device - The Gladys device.
 * @returns {boolean} True when enough time has passed.
 * @example
 * if (isRefreshDue(device)) { ... }
 */
function isRefreshDue(device) {
  const last = lastCaptureAt.get(device.external_id);
  if (last === undefined) {
    return true;
  }
  return Date.now() - last >= refreshIntervalFor(device) * 1000;
}

/**
 * Capture a fresh image of a device and return it in the Gladys format.
 * @param {object} device - The Gladys device.
 * @returns {Promise<string>} The `image/jpg;base64,...` string.
 * @example
 * const image = await captureDeviceImage(device);
 */
function captureDeviceImage(device) {
  const running = capturesInFlight.get(device.external_id);
  if (running) {
    return running;
  }
  const capture = runCapture(device).finally(() => {
    capturesInFlight.delete(device.external_id);
  });
  capturesInFlight.set(device.external_id, capture);
  return capture;
}

/**
 * The capture itself, once `captureDeviceImage` made sure it is the only one.
 * @param {object} device - The Gladys device.
 * @returns {Promise<string>} The `image/jpg;base64,...` string.
 * @example
 * await runCapture(device);
 */
async function runCapture(device) {
  if (isCameraDisabled(device)) {
    throw new Error('TAPO_CAMERA_DISABLED');
  }
  if (!batteryGuard.allowsOnDemand(device.external_id)) {
    throw new Error(`TAPO_BATTERY_TOO_LOW:${batteryGuard.levelOf(device.external_id)}%`);
  }
  // A masked camera keeps streaming: it serves a black frame reading "Privacy
  // Mode is on" rather than failing, so capturing would succeed and publish a
  // picture that reads as a broken camera. Refusing here keeps the last useful
  // image on the widget — and spares a battery model a wake-up for nothing.
  if (watcher.isPrivacyModeOn(device.external_id)) {
    throw new Error('TAPO_PRIVACY_MODE_ON');
  }
  const camera = await cameraFromDevice(device, config);
  if (!camera.ip) {
    throw new Error('TAPO_CAMERA_IP_UNKNOWN');
  }
  if (camera.unreachable) {
    // The camera is addressable but answers on neither capture port — powered
    // off, or third-party access turned off in the Tapo app. Give up now: the
    // capture that follows would only wait for its timeout, once per cycle.
    throw new Error('TAPO_NO_CAPTURE_MODE');
  }
  if (camera.captureMode === CAPTURE_MODES.RTSP && !hasRtspAccount(config, camera)) {
    // Failing with a precise reason: the user has a fix to apply (fill in the
    // camera account), which a generic ffmpeg error would not convey.
    throw new Error('TAPO_RTSP_ACCOUNT_MISSING');
  }
  // Stamped here rather than at the call sites, and BEFORE the capture: what
  // costs the battery is waking the camera up, so a capture that then fails
  // still has to count against the interval. Stamping on success only would let
  // a flaky camera be retried every single tick.
  lastCaptureAt.set(device.external_id, Date.now());
  return captureImage(camera, config);
}

/**
 * Capture and publish the image of every camera passed in.
 *
 * Sequential on purpose: several ffmpeg captures at once would compete for CPU
 * on a Raspberry Pi, and a camera answers faster when it is alone.
 * @param {object[]} devices - The devices to refresh.
 * @param {object} [options] - How to run the round.
 * @param {boolean} [options.force] - Ignore the per-device interval, for a
 * refresh the user explicitly asked for.
 * @returns {Promise<{ published: number, failures: string[] }>} What happened.
 * @example
 * const { published } = await refreshImages(await gladys.getDevices());
 */
async function refreshImages(devices, { force = false } = {}) {
  const cameras = (devices || []).filter((device) =>
    (device.features || []).some((feature) => feature.category === 'camera'),
  );
  let published = 0;
  /** @type {string[]} */
  const failures = [];

  for (const device of cameras) {
    // Disabled in Gladys (private mode): not a failure, a choice.
    if (isCameraDisabled(device)) {
      continue;
    }
    // The scheduled refresh is the expensive part, so it is the first thing a
    // draining battery gives up — an explicit request still goes through.
    if (!force && !batteryGuard.allowsScheduled(device.external_id)) {
      continue;
    }
    // Each camera keeps its own pace: a battery model is captured far less often
    // than a wired one, and the loop ticks at the fastest of the two.
    if (!force && !isRefreshDue(device)) {
      continue;
    }
    try {
      const image = await captureDeviceImage(device);
      await gladys.publishCameraImage(device.external_id, image);
      published += 1;
    } catch (e) {
      logger.warn(`Refreshing the image of "${device.name}" failed: ${e.message}`);
      failures.push(device.name);
    }
  }
  return { published, failures };
}

/** Handle of the image refresh loop, so a config change can restart it. */
let refreshTimer = null;

/**
 * Set while a refresh round runs. A round captures the cameras one after the
 * other and can outlast the interval (several cameras timing out); the next
 * tick then skips instead of starting a second round over the first.
 */
let refreshRunning = false;

/**
 * Start (or restart) the loop that keeps the dashboard images up to date.
 *
 * Why the integration drives this itself rather than relying on `onPoll`: Gladys
 * only wires a device into its poll scheduler when the device is CREATED. A
 * camera added before this integration declared `should_poll` therefore never
 * gets polled, and no re-publish can change that — the image would freeze on the
 * one captured at startup, which is exactly what happens without this loop.
 * @example
 * startImageRefresh();
 */
function startImageRefresh() {
  stopImageRefresh();
  // The loop ticks at the SHORTEST of the two intervals; each camera is then
  // filtered on its own by `isRefreshDue`. Ticking at the longest one would cap
  // every wired camera at the battery pace, which is what this split undoes.
  const intervalSeconds = Math.max(
    5,
    Math.min(config.image_refresh_interval, config.battery_image_refresh_interval),
  );
  refreshTimer = setInterval(async () => {
    if (refreshRunning) {
      return;
    }
    refreshRunning = true;
    try {
      // Re-read the devices every round: a camera may have been added or removed.
      const devices = await gladys.getDevices();
      await refreshImages(devices);
    } catch (e) {
      logger.debug(`The image refresh round failed: ${e.message}`);
    } finally {
      refreshRunning = false;
    }
  }, intervalSeconds * 1000);
  logger.info(
    `Refreshing the camera images every ${config.image_refresh_interval}s (battery cameras: every ${config.battery_image_refresh_interval}s)`,
  );
}

/**
 * Stop the image refresh loop.
 * @example
 * stopImageRefresh();
 */
function stopImageRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// --- Event watching: doorbell, motion, battery -------------------------------
// A doorbell press also pushes a fresh image, so the dashboard widget shows who
// rang without waiting for the user to open it.
const watcher = new EventWatcher({
  gladys,
  cloud,
  batteryGuard,
  onDoorbell: async (device) => {
    const image = await captureDeviceImage(device);
    await gladys.publishCameraImage(device.external_id, image);
  },
});

/** The publish in flight, and the one queued behind it. */
let publishing = null;
let publishQueued = null;

/**
 * Refresh the configuration, list the cameras and publish them.
 *
 * Coalesced: saving the configuration, the action that saves an address and the
 * scan button can all ask within the same second, and each publish probes every
 * camera (and logs in to several of them). A call arriving during a publish
 * waits for it and runs ONE more — so the latest configuration is always the
 * one published — instead of stacking a run per call.
 * @returns {Promise<object[]>} The published devices.
 * @example
 * const devices = await publishDevices();
 */
function publishDevices() {
  if (publishing) {
    if (!publishQueued) {
      publishQueued = publishing
        .catch(() => {})
        .then(() => {
          publishQueued = null;
          return publishDevices();
        });
    }
    return publishQueued;
  }
  publishing = runPublish().finally(() => {
    publishing = null;
  });
  return publishing;
}

/**
 * The publish itself (see `publishDevices`).
 * @returns {Promise<object[]>} The published devices.
 * @example
 * await runPublish();
 */
async function runPublish() {
  config = normalizeConfig(await gladys.getConfig());

  if (!isConfigured(config)) {
    await gladys
      .setConnectionStatus(false, {
        en: 'Fill in your Tapo account (email and password) to find your cameras.',
        fr: 'Renseignez votre compte Tapo (e-mail et mot de passe) pour retrouver vos caméras.',
      })
      .catch(() => {});
    return [];
  }

  const cameras = await cloud.getCameras(config);
  const devices = await buildDiscoveredDevices(gladys, cameras, config);
  await gladys.publishDiscoveredDevices(devices);

  // Declare the battery models to the guard right away. It must know a camera
  // runs on battery BEFORE that camera has ever reported a level: a battery
  // camera that never answers is the one most in need of being spared, and
  // waiting for a reading is waiting for something that may never come.
  devices.filter(isBatteryDevice).forEach((device) => {
    batteryGuard.trackBatteryCamera(device.external_id);
  });

  // Connected as soon as the cloud answered, but a device without an address is
  // named on the Configuration screen, with the fix: the badge used to read
  // "connected" while every image stayed empty, which is how users ended up
  // guessing at the address fields.
  const status = connectionStatusFor(devices);
  await gladys.setConnectionStatus(status.connected, status.message).catch(() => {});
  return devices;
}

// --- Discovery: the user asks for the list of devices ------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> listing the Tapo cameras');
  await publishDevices();
});

// --- Image: Gladys needs a fresh frame ---------------------------------------
gladys.onGetImage(async (device) => {
  logger.debug(`onGetImage <- ${device.external_id}`);
  try {
    return await captureDeviceImage(device);
  } catch (e) {
    // The widget only shows a generic error, so the reason has to reach the logs
    // or the failure is undiagnosable.
    logger.warn(`Capturing the image of "${device.name}" failed: ${e.message}`);
    throw e;
  }
});

/**
 * Cameras whose `camera/enabled` gate was set from Gladys during this process,
 * by external id. The device list also carries the state (`last_value`), but a
 * command lands before the next read of that list.
 * @type {Map<string, boolean>}
 */
const enabledOverrides = new Map();

/**
 * Tell whether a camera is disabled in Gladys (private mode).
 *
 * The core already refuses to poll, serve or store the image of a disabled
 * camera; checking here as well keeps the refresh loop from capturing — and
 * waking a battery camera — for a frame Gladys will throw away.
 * @param {object} device - The Gladys device.
 * @returns {boolean} True when the camera must be left alone.
 * @example
 * isCameraDisabled(device);
 */
function isCameraDisabled(device) {
  if (enabledOverrides.has(device.external_id)) {
    return enabledOverrides.get(device.external_id) === false;
  }
  const gate = (device.features || []).find((feature) =>
    String(feature.external_id || '').endsWith(`:${FEATURE_SUFFIXES.ENABLED}`),
  );
  return gate?.last_value === 0;
}

/**
 * Turn a camera on or off, as the `camera/enabled` gate asks.
 *
 * On a camera with a lens mask, the mask follows: disabling covers the lens, as
 * the Tapo app's privacy mode does. Without one, the gate is Gladys-side only —
 * the core stops polling and serving the camera, and this integration stops
 * capturing it.
 * @param {object} device - The device, as the command payload carries it.
 * @param {boolean} enabled - The requested state.
 * @returns {Promise<void>} Resolves once applied.
 * @example
 * await setCameraEnabled(device, false);
 */
async function setCameraEnabled(device, enabled) {
  // The selector, not the name: a command payload carries no `name`.
  const label = device.selector || device.external_id;
  logger.info(`onSetValue <- camera ${enabled ? 'enabled' : 'disabled'} on "${label}"`);

  const params = device.params || [];
  const lensMask = params.find((param) => param.name === DEVICE_PARAMS.LENS_MASK)?.value === '1';
  const legacySwitch = (device.features || []).some((feature) =>
    String(feature.external_id || '').endsWith(`:${FEATURE_SUFFIXES.PRIVACY}`),
  );
  if (lensMask || legacySwitch) {
    const ip = params.find((param) => param.name === DEVICE_PARAMS.IP)?.value;
    if (!ip) {
      throw new Error(`No local address known for "${label}"`);
    }
    // Through the watcher's client, never a fresh one: the firmware only
    // accepts a handful of sessions and a second client would eventually get
    // every login refused.
    await watcher.getLocalApi(ip).setPrivacyMode(!enabled);
    // Remembered right away rather than at the next poll: a camera the user
    // just un-masked would otherwise stay skipped by the capture guard.
    watcher.setPrivacyMode(device.external_id, !enabled);
  }
  enabledOverrides.set(device.external_id, enabled);

  // `has_feedback` is set on the cameras whose mask is read back: Gladys then
  // waits for the integration to report the new state rather than storing it.
  const cloudDeviceId = parseCloudDeviceId(device.external_id);
  if (lensMask && cloudDeviceId) {
    await gladys
      .publishState(
        gladys.externalIds(EXTERNAL_ID_TYPE, cloudDeviceId).feature(FEATURE_SUFFIXES.ENABLED),
        enabled ? 1 : 0,
      )
      .catch((e) => logger.debug(`Publishing the camera state failed: ${e.message}`));
  }
}

// --- Commands: Gladys writes a value on one of our features ------------------
// ONE handler for the whole integration, on purpose: the SDK stores a single
// `setValue` callback, so a second `onSetValue` would silently replace this one
// and take the other feature down with it. Everything writable routes from here.
gladys.onSetValue(async (device, deviceFeature, value) => {
  const featureId = String(deviceFeature.external_id || '');

  // The private-mode gate (`camera/enabled`), and the privacy switch it replaced
  // on devices created before 1.3 — kept working so the scenes built on it do not
  // break before the user updates the device. Routed on the SUFFIX: `binary` is
  // shared by the motion sensor, and `camera` by the image and PTZ features.
  const isEnabledGate = featureId.endsWith(`:${FEATURE_SUFFIXES.ENABLED}`);
  const isLegacyPrivacy = featureId.endsWith(`:${FEATURE_SUFFIXES.PRIVACY}`);
  if (isEnabledGate || isLegacyPrivacy) {
    // The legacy switch reads the other way round: 1 = masked = disabled.
    const enabled = isEnabledGate ? Number(value) === 1 : Number(value) !== 1;
    await setCameraEnabled(device, enabled);
    return;
  }

  // The manual capture button, on battery cameras. Routed on the SUFFIX, never on
  // the category or the type: the doorbell is a `button/push` too, and matching
  // on either would turn every doorbell press into a capture request.
  if (String(deviceFeature.external_id || '').endsWith(`:${FEATURE_SUFFIXES.CAPTURE}`)) {
    const label = device.selector || device.external_id;
    logger.info(`onSetValue <- manual capture on "${label}"`);
    // The device carried in a command payload is a thin one: it has the feature
    // that was written to, not the params a capture needs. Re-read it whole, or
    // `cameraFromDevice` would find no IP and fail on every press.
    const devices = await gladys.getDevices();
    const full = devices.find((entry) => entry.external_id === device.external_id) || device;
    // Explicit request: the per-camera interval does not apply, which is the
    // whole point of the button on a camera captured once an hour. The hard
    // battery floor still does — `captureDeviceImage` enforces it and throws, so
    // a flat camera reports the failure instead of being woken up.
    const image = await captureDeviceImage(full);
    await gladys.publishCameraImage(full.external_id, image);
    return;
  }

  // PTZ: one scalar value per command (spec `docs/specs/camera-ptz-control.md`).
  // Routed on the TYPE, because both features live under the `camera` category.
  const type = deviceFeature.type;
  if (type !== DEVICE_FEATURE_TYPES.CAMERA.MOVE && type !== DEVICE_FEATURE_TYPES.CAMERA.PRESET) {
    // Every other feature of a camera is read-only; a value written to one is a
    // caller mistake worth surfacing rather than a command to guess at.
    logger.debug(
      `onSetValue <- ignoring ${deviceFeature.category}/${type} on ${device.external_id}`,
    );
    return;
  }

  // The selector, not the name: a command payload carries no `name`, and every
  // message here used to read "undefined" — which is exactly what made the
  // first failure unreadable.
  const label = device.selector || device.external_id;

  const ptz = await getPtzClient(device);
  if (!ptz) {
    throw new Error(`No camera account configured for "${label}"`);
  }

  if (type === DEVICE_FEATURE_TYPES.CAMERA.PRESET) {
    const token = presetTokenFor(device, value);
    if (!token) {
      throw new Error(`Unknown preset ${value} on "${label}"`);
    }
    logger.info(`onSetValue <- preset ${value} on "${label}"`);
    await ptz.gotoPreset(token);
    return;
  }

  if (Number(value) === CAMERA_MOVE.STOP) {
    logger.info(`onSetValue <- stop on "${label}"`);
    await ptz.stop();
    return;
  }

  // A bounded step, not a continuous move. Gladys sends the release `0` right
  // after a quick tap, but a value can also arrive ALONE — from a scene, or when
  // the release is lost — and the spec is explicit that such a value must mean a
  // nudge rather than seconds of rotation. The step is what makes both callers
  // correct, and the stop that may follow is then a no-op.
  //
  // Logged at INFO, not debug: a PTZ command is a user gesture that either
  // reaches the camera or does not, and the debug level hid that entirely.
  logger.info(`onSetValue <- move ${value} on "${label}"`);
  await ptz.step(Number(value));
});

// --- Polling: Gladys asks to refresh a device --------------------------------
// The image itself is pulled by `onGetImage`, so a poll is the moment to refresh
// what the widget does not ask for: the battery level and any missed event.
gladys.onPoll(async (device) => {
  const cloudDeviceId = parseCloudDeviceId(device.external_id);
  if (!cloudDeviceId || !isConfigured(config)) {
    return;
  }

  // A camera carrying an event feature is already read by the watcher's own
  // loop, every `event_poll_interval`: reading it again here doubled the local
  // traffic of every wired camera for nothing. The others — no event feature,
  // so not in that loop — are read here, and FIRST: the capture decision below
  // must be taken against the current battery level, not the previous one.
  const watched = (device.features || []).some(
    (feature) =>
      feature.category === DEVICE_FEATURE_CATEGORIES.BUTTON ||
      feature.category === DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR,
  );
  if (!watched) {
    await watcher
      .checkDevice(device)
      .catch((e) => logger.debug(`Poll of "${device.name}" failed: ${e.message}`));
  }

  // The dashboard camera widget does NOT ask for a fresh image: it displays the
  // last one published, and shows an error when none is recent enough. So the
  // image has to be PUSHED — `onGetImage` alone only covers the live view and
  // the chat intent, which would leave the widget permanently empty.
  const hasCamera = (device.features || []).some((feature) => feature.category === 'camera');
  if (!hasCamera) {
    return;
  }

  // This poll IS a scheduled refresh, so it answers to the scheduled rules.
  // Treating it as an on-demand request — which it was, by omission — left a
  // second capture loop running every minute with only the hard 40% floor in
  // front of it: the 40-60% band was never enforced, and a battery camera kept
  // draining through the very range this guard exists to protect.
  if (!batteryGuard.allowsScheduled(device.external_id)) {
    return;
  }
  if (!isRefreshDue(device)) {
    return;
  }

  try {
    const image = await captureDeviceImage(device);
    await gladys.publishCameraImage(device.external_id, image);
    logger.debug(`Image of "${device.name}" refreshed`);
  } catch (e) {
    logger.warn(`Refreshing the image of "${device.name}" failed: ${e.message}`);
  }
});

// --- Manifest action: test the connection ------------------------------------
gladys.onAction('test_connection', async () => {
  try {
    config = normalizeConfig(await gladys.getConfig());
    if (!isConfigured(config)) {
      return {
        en: 'Fill in your Tapo account first (email and password).',
        fr: "Renseignez d'abord votre compte Tapo (e-mail et mot de passe).",
      };
    }

    // A fresh scan: the user is asking what the integration sees NOW, and the
    // answer is wasted if it comes from a cache filled before they plugged a
    // camera in or moved it to another network.
    forgetLastScan();
    const devices = await publishDevices();
    if (devices.length === 0) {
      return {
        en: 'Connection to the Tapo cloud OK, but no device is attached to this account.',
        fr: "Connexion au cloud Tapo OK, mais aucun appareil n'est rattaché à ce compte.",
      };
    }
    // One line per device: where it is, where that address came from, and
    // what to do when it is missing or silent.
    return buildConnectionReport(devices);
  } catch (e) {
    logger.error('The Tapo connection test failed', e);
    if (e instanceof TapoAuthError) {
      return {
        en: 'Connection refused: check your Tapo email and password.',
        fr: 'Connexion refusée : vérifiez votre e-mail et votre mot de passe Tapo.',
      };
    }
    return {
      en: `Connection failed: ${e.message}`,
      fr: `Échec de la connexion : ${e.message}`,
    };
  }
});

/**
 * Find one of the integration's devices from the value of a `source: "devices"`
 * select, which is the device external id.
 * @param {string} externalId - The selected value.
 * @returns {Promise<object|null>} The device, or null when unknown.
 * @example
 * const device = await findDevice(fields.device);
 */
async function findDevice(externalId) {
  const devices = await gladys.getDevices();
  return devices.find((entry) => entry.external_id === externalId) || null;
}

/**
 * Write one entry of an off-schema store, or remove it.
 * @param {string} key - The config key (`device_addresses`, `camera_account_store`).
 * @param {string} cloudDeviceId - The entry key.
 * @param {unknown} value - The value, or null to remove the entry.
 * @returns {Promise<void>} Resolves once Gladys stored it.
 * @example
 * await writeStoreEntry('device_addresses', 'ID1', '192.168.1.20');
 */
async function writeStoreEntry(key, cloudDeviceId, value) {
  const current = normalizeConfig(await gladys.getConfig())[key] || {};
  const next = { ...current };
  const id = String(cloudDeviceId).toUpperCase();
  if (value === null) {
    delete next[id];
  } else {
    next[id] = value;
  }
  await gladys.setConfig({ [key]: JSON.stringify(next) });
  config = normalizeConfig(await gladys.getConfig());
}

/**
 * The cloud device id of a Gladys device.
 * @param {object} device - The Gladys device.
 * @returns {string|null} The id.
 * @example
 * cloudIdOf(device);
 */
function cloudIdOf(device) {
  return (
    (device.params || []).find((param) => param.name === DEVICE_PARAMS.CLOUD_DEVICE_ID)?.value ||
    parseCloudDeviceId(device.external_id)
  );
}

/**
 * Try a test capture after a setting changed, and phrase the outcome.
 * @param {object} device - The Gladys device, re-read after the publish.
 * @param {{ en: string, fr: string }} saved - What was saved, for the message.
 * @returns {Promise<{ en: string, fr: string }>} The message.
 * @example
 * await reportTestCapture(device, { en: 'Saved.', fr: 'Enregistré.' });
 */
async function reportTestCapture(device, saved) {
  const isCamera = (device.features || []).some((feature) => feature.category === 'camera');
  if (!isCamera) {
    return saved;
  }
  try {
    const image = await captureDeviceImage(device);
    await gladys.publishCameraImage(device.external_id, image);
    return {
      en: `${saved.en}\nAn image was captured: the camera works.`,
      fr: `${saved.fr}\nUne image a été capturée : la caméra fonctionne.`,
    };
  } catch (e) {
    logger.warn(`The test capture of "${device.name}" failed: ${e.message}`);
    return {
      en: `${saved.en}\nBut the test capture failed: ${e.message}`,
      fr: `${saved.fr}\nMais la capture de test a échoué : ${e.message}`,
    };
  }
}

// --- Manifest action: set the IP address of one device -----------------------
// The fix for the most common support question: a device the scan cannot see
// (another subnet or VLAN, broadcast filtered by the router). The device is
// PICKED from a list (`source: "devices"`) rather than typed by name, and the
// address is stored against its cloud id — so neither a typo, nor an accent, nor
// renaming the device later can make it miss.
gladys.onAction('set_device_address', async (fields) => {
  const { device: externalId, ip: rawIp } = fields || {};
  const device = await findDevice(externalId);
  if (!device) {
    return {
      en: 'Pick a device in the list. If it is empty, run a scan from the Discover tab first.',
      fr: "Choisissez un appareil dans la liste. Si elle est vide, lancez d'abord un scan depuis l'onglet Découverte.",
    };
  }
  const cloudDeviceId = cloudIdOf(device);
  const ip = String(rawIp || '').trim();

  if (!ip) {
    // Clearing the field hands the device back to the automatic detection.
    await writeStoreEntry('device_addresses', cloudDeviceId, null);
    forgetLastScan();
    const republished = await publishDevices().catch(() => []);
    const updated = republished.find((entry) => entry.external_id === device.external_id);
    const found = updated && reportLineIp(updated);
    return found
      ? {
          en: `Manual address removed for "${device.name}". The scan found it at ${found}.`,
          fr: `Adresse manuelle supprimée pour « ${device.name} ». Le scan l'a trouvé à ${found}.`,
        }
      : {
          en: `Manual address removed for "${device.name}", but the scan does not see it: it has no address now.`,
          fr: `Adresse manuelle supprimée pour « ${device.name} », mais le scan ne le voit pas : il n'a plus d'adresse.`,
        };
  }

  if (!isValidAddress(ip)) {
    return {
      en: `"${ip}" is not an IP address. Expected something like 192.168.1.42.`,
      fr: `« ${ip} » n'est pas une adresse IP. Attendu : quelque chose comme 192.168.1.42.`,
    };
  }

  // Saved whatever the probe says — the device may simply be asleep — but the
  // user is told at once when nothing answers at that address.
  const ports = [443, 554, 2020, 8800];
  const outcomes = await Promise.all(ports.map((port) => probePort(ip, port)));
  const answers = outcomes.some((outcome) => outcome === 'open');

  await writeStoreEntry('device_addresses', cloudDeviceId, ip);
  // Re-published so the address reaches the device params (and CAMERA_URL,
  // which the live view reads) right away.
  await publishDevices().catch((e) =>
    logger.warn(`Re-publish after saving the address failed: ${e.message}`),
  );
  const updated = (await findDevice(externalId)) || device;
  watcher.dropOnvif(updated);
  watcher
    .setupOnvif(updated)
    .catch((e) => logger.debug(`ONVIF setup after saving the address failed: ${e.message}`));

  if (!answers) {
    return {
      en: `Address ${ip} saved for "${device.name}", but nothing answers there right now. Check the address in the Tapo app (device settings > Device info), and that the device is powered on and on the same network as Gladys.`,
      fr: `Adresse ${ip} enregistrée pour « ${device.name} », mais rien ne répond à cette adresse pour l'instant. Vérifiez-la dans l'application Tapo (paramètres de l'appareil > Infos sur l'appareil), et que l'appareil est allumé et sur le même réseau que Gladys.`,
    };
  }
  return reportTestCapture(updated, {
    en: `Address ${ip} saved for "${device.name}".`,
    fr: `Adresse ${ip} enregistrée pour « ${device.name} ».`,
  });
});

/**
 * The address a published device ended up with.
 * @param {object} device - The published device.
 * @returns {string} The address, or ''.
 * @example
 * reportLineIp(device);
 */
function reportLineIp(device) {
  return (device.params || []).find((param) => param.name === DEVICE_PARAMS.IP)?.value || '';
}

// --- Manifest action: save the camera account of one camera ------------------
// A dedicated mini-form beats asking the user to type `name|user|password` into
// a single box: the camera is picked from a list, and the account is stored as
// JSON against its cloud id — so a password may hold commas or spaces, and the
// account survives renaming the camera.
gladys.onAction('set_camera_account', async (fields) => {
  const { device: externalId, username, password } = fields || {};
  const device = await findDevice(externalId);
  if (!device) {
    return {
      en: 'Pick a camera in the list. If it is empty, run a scan from the Discover tab first.',
      fr: "Choisissez une caméra dans la liste. Si elle est vide, lancez d'abord un scan depuis l'onglet Découverte.",
    };
  }
  const cloudDeviceId = cloudIdOf(device);
  const user = String(username || '').trim();

  if (!user && !password) {
    await writeStoreEntry('camera_account_store', cloudDeviceId, null);
  } else if (!user || !password) {
    return {
      en: 'Fill in both the username and the password of the camera account (or leave both empty to remove it).',
      fr: "Renseignez l'identifiant et le mot de passe du compte caméra (ou laissez les deux vides pour le supprimer).",
    };
  } else {
    await writeStoreEntry('camera_account_store', cloudDeviceId, { username: user, password });
  }

  // The account feeds the RTSP URL (live view), the PTZ client and ONVIF: all
  // three are rebuilt. A client still holding the previous credentials would
  // otherwise keep failing until the next restart.
  ptzClients.delete(device.external_id);
  forgetRefusedCredentials();
  await publishDevices().catch((e) =>
    logger.warn(`Re-publish after saving the account failed: ${e.message}`),
  );
  const updated = (await findDevice(externalId)) || device;
  watcher.dropOnvif(updated);
  watcher
    .setupOnvif(updated)
    .catch((e) => logger.debug(`ONVIF setup after saving the account failed: ${e.message}`));

  if (!user && !password) {
    return {
      en: `Camera account removed for "${device.name}": the default account (or the Tapo protocol) is used again.`,
      fr: `Compte caméra supprimé pour « ${device.name} » : le compte par défaut (ou le protocole Tapo) est de nouveau utilisé.`,
    };
  }
  return reportTestCapture(updated, {
    en: `Account saved for "${device.name}".`,
    fr: `Compte enregistré pour « ${device.name} ».`,
  });
});

// --- Manifest action: refresh every image ------------------------------------
gladys.onAction('refresh_images', async () => {
  const devices = await gladys.getDevices();
  const cameras = devices.filter((device) =>
    (device.features || []).some((feature) => feature.category === 'camera'),
  );
  if (cameras.length === 0) {
    return {
      en: 'No camera created yet. Run a scan from the Discover screen first.',
      fr: "Aucune caméra créée pour l'instant. Lancez d'abord un scan depuis l'écran Découverte.",
    };
  }

  // Forced: the user pressed the button, so the per-device interval does not
  // apply. The battery floor still does — `captureDeviceImage` enforces it, so a
  // camera below the hard limit reports a failure instead of being captured.
  const { published, failures } = await refreshImages(cameras, { force: true });

  if (failures.length === 0) {
    return {
      en: `${published} image(s) refreshed.`,
      fr: `${published} image(s) rafraîchie(s).`,
    };
  }
  return {
    en: `${published} image(s) refreshed. Failed: ${failures.join(', ')}.`,
    fr: `${published} image(s) rafraîchie(s). Échec : ${failures.join(', ')}.`,
  };
});

/**
 * The configuration the watchers were last started with, serialized.
 *
 * The SDK emits `connected` again on every WebSocket reconnection. Restarting
 * everything then — logging out of every camera, unsubscribing every ONVIF
 * pull point, a capture round — turned a network blip between the container
 * and Gladys into a burst of logins on every camera. A reconnection with the
 * same configuration now leaves the running watchers alone.
 * @type {string|null}
 */
let startedWith = null;

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async () => {
  logger.info('onConfigUpdated -> reloading the configuration');
  // The account may have changed: drop the token rather than guess it still works.
  cloud.token = null;
  // Same for the cameras whose credentials were rejected: the user very likely
  // came here to fix exactly that, and the re-publish below must try again
  // rather than keep skipping them until a restart.
  forgetRefusedCredentials();
  // Same reasoning for the PTZ clients: each holds the credentials it was built
  // with, so a corrected camera password would never reach the camera.
  ptzClients.clear();
  await publishDevices().catch((e) => logger.error('Re-publish after config update failed', e));
  if (isConfigured(config)) {
    // Thresholds first: the watcher polls straight away, and a tick landing
    // before the new thresholds were applied would decide on the old ones.
    batteryGuard.configure(config);
    watcher.start(config);
    startImageRefresh();
    startedWith = JSON.stringify(config);
  } else {
    watcher.stop();
    stopImageRefresh();
    startedWith = null;
  }
});

// --- Connection lifecycle ----------------------------------------------------
gladys.on('connected', async () => {
  try {
    // Load the devices the user created, so the event watcher knows what to poll.
    const devices = await gladys.getDevices();
    await publishDevices();
    if (isConfigured(config) && startedWith === JSON.stringify(config) && watcher.timer) {
      logger.info('Reconnected to Gladys: the watchers keep running');
      return;
    }
    if (isConfigured(config)) {
      // Thresholds before anything captures, and battery models declared before
      // the startup refresh: a camera the guard does not yet know about would be
      // captured on the spot, which on a flat cell is the one capture to avoid.
      batteryGuard.configure(config);
      devices.filter(isBatteryDevice).forEach((device) => {
        batteryGuard.trackBatteryCamera(device.external_id);
      });
      watcher.start(config);
      startImageRefresh();
      startedWith = JSON.stringify(config);

      // Read the battery of every camera BEFORE the startup capture. At boot the
      // guard has no readings at all, so without this pass a battery camera is
      // judged on nothing — and the widget being populated one round sooner is
      // not worth a capture on a camera that may be nearly empty.
      await Promise.all(
        devices.map((device) =>
          watcher
            .checkDevice(device)
            .catch((e) =>
              logger.debug(`Initial battery read of "${device.name}" failed: ${e.message}`),
            ),
        ),
      );

      // Publish a first image right away, so the widget is populated at once
      // instead of waiting a full refresh round.
      await refreshImages(devices);
    }
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Initialization failed, check the integration logs.',
        fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
      })
      .catch(() => {});
  }
});

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown(async (signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  watcher.stop();
  stopImageRefresh();
});

// --- Last-resort guards ------------------------------------------------------
// A camera socket dying at the wrong moment must never take the integration
// down: the supervisor would restart it and every camera would lose its images
// until the next round. These handlers keep the process alive and leave a trace.
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception, the integration keeps running: ${err.message}`, err);
});
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection, the integration keeps running: ${reason}`);
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Tapo integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
