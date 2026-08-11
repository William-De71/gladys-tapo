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
  CAMERA_FEATURE_TYPES,
} from './src/tapo/constants.js';
import { BatteryGuard } from './src/tapo/batteryGuard.js';
import { isBatteryModel } from './src/tapo/rtsp.js';

const gladys = new GladysIntegration();
const cloud = new TapoCloud();
// Guards the battery of solar/wire-free cameras: capturing is what drains them,
// so it backs off well before the cell reaches a level it may not recover from.
const batteryGuard = new BatteryGuard();

let config = normalizeConfig();

/** When each device was last captured, to honour its own refresh interval. */
const lastCaptureAt = new Map();

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
 * them on every arrow press would make the camera feel sluggish. It also owns
 * the watchdog, which only bounds a movement if the same client sees the stop.
 * @param {object} device - The Gladys device.
 * @returns {object|null} The client, or null without a camera account.
 * @example
 * const ptz = getPtzClient(device);
 */
function getPtzClient(device) {
  const existing = ptzClients.get(device.external_id);
  if (existing) {
    return existing;
  }

  const ip = (device.params || []).find((param) => param.name === DEVICE_PARAMS.IP)?.value;
  const account = resolveRtspAccount(config, device.name);
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
async function captureDeviceImage(device) {
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
  if (camera.captureMode === CAPTURE_MODES.RTSP && !hasRtspAccount(config, camera.name)) {
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
    try {
      // Re-read the devices every round: a camera may have been added or removed.
      const devices = await gladys.getDevices();
      await refreshImages(devices);
    } catch (e) {
      logger.debug(`The image refresh round failed: ${e.message}`);
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

/**
 * Refresh the configuration, list the cameras and publish them.
 * @returns {Promise<object[]>} The published devices.
 * @example
 * const devices = await publishDevices();
 */
async function publishDevices() {
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

  if (devices.length > 0) {
    await gladys.setConnectionStatus(true).catch(() => {});
  } else {
    await gladys
      .setConnectionStatus(false, {
        en: 'No camera found on your Tapo account. Check that your cameras appear in the Tapo app.',
        fr: "Aucune caméra trouvée sur votre compte Tapo. Vérifiez que vos caméras apparaissent dans l'application Tapo.",
      })
      .catch(() => {});
  }
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

// --- Commands: Gladys writes a value on one of our features ------------------
// ONE handler for the whole integration, on purpose: the SDK stores a single
// `setValue` callback, so a second `onSetValue` would silently replace this one
// and take the other feature down with it. Everything writable routes from here.
gladys.onSetValue(async (device, deviceFeature, value) => {
  // The privacy switch is routed on the CATEGORY, not on the type: `binary` is
  // the same string for eight categories in Gladys, and the motion sensor of
  // these very cameras already uses `sensor.binary`. Matching on the type alone
  // would make a privacy command indistinguishable from a write to the motion
  // sensor.
  if (deviceFeature.category === DEVICE_FEATURE_CATEGORIES.SWITCH) {
    // The selector, not the name: a command payload carries no `name`.
    const label = device.selector || device.external_id;
    const ip = (device.params || []).find((param) => param.name === DEVICE_PARAMS.IP)?.value;
    if (!ip) {
      throw new Error(`No local address known for "${label}"`);
    }

    const enabled = Number(value) === 1;
    logger.info(`onSetValue <- privacy ${enabled ? 'on' : 'off'} on "${label}"`);

    // Through the watcher's client, never a fresh one: the firmware only accepts
    // a handful of sessions and a second client would eventually get every login
    // refused.
    await watcher.getLocalApi(ip).setPrivacyMode(enabled);

    // Remembered right away rather than at the next poll: otherwise a camera the
    // user just un-masked would keep being skipped by the capture guard for up
    // to a minute, which looks like the switch did nothing.
    watcher.setPrivacyMode(device.external_id, enabled);
    return;
  }

  // PTZ: one scalar value per command (spec `docs/specs/camera-ptz-control.md`).
  // Routed on the TYPE, because both features live under the `camera` category.
  const type = deviceFeature.type;
  if (type !== CAMERA_FEATURE_TYPES.MOVE && type !== CAMERA_FEATURE_TYPES.PRESET) {
    // Every other feature of a camera is read-only; a value written to one is a
    // caller mistake worth surfacing rather than a command to guess at.
    logger.debug(`onSetValue <- ignoring ${deviceFeature.category}/${type} on "${device.name}"`);
    return;
  }

  const ptz = getPtzClient(device);
  if (!ptz) {
    throw new Error(`No camera account configured for "${device.name}"`);
  }

  if (type === CAMERA_FEATURE_TYPES.PRESET) {
    const token = presetTokenFor(device, value);
    if (!token) {
      throw new Error(`Unknown preset ${value} on "${device.name}"`);
    }
    logger.debug(`onSetValue <- preset ${value} on "${device.name}"`);
    await ptz.gotoPreset(token);
    return;
  }

  if (Number(value) === CAMERA_MOVE.STOP) {
    logger.debug(`onSetValue <- stop on "${device.name}"`);
    await ptz.stop();
    return;
  }

  // A bounded step, not a continuous move. Gladys sends the release `0` right
  // after a quick tap, but a value can also arrive ALONE — from a scene, or when
  // the release is lost — and the spec is explicit that such a value must mean a
  // nudge rather than the full watchdog of rotation. The step is what makes both
  // callers correct, and the stop that may follow is then a no-op.
  logger.debug(`onSetValue <- move ${value} on "${device.name}"`);
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

  // The battery is read FIRST, and the capture decision is taken after it.
  //
  // This order is the whole point: reading the battery and the events is cheap
  // and is never gated, while capturing is what drains the cell. Capturing
  // first meant every decision below was taken against the PREVIOUS round's
  // level — and, on a camera that had just crossed a threshold, one more
  // capture was let through each time.
  await watcher
    .checkDevice(device)
    .catch((e) => logger.debug(`Poll of "${device.name}" failed: ${e.message}`));

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

    const cameras = await cloud.getCameras(config);
    if (cameras.length === 0) {
      return {
        en: 'Connection to the Tapo cloud OK, but no camera is attached to this account.',
        fr: "Connexion au cloud Tapo OK, mais aucune caméra n'est rattachée à ce compte.",
      };
    }

    // Report what the user needs to know: which cameras can actually be captured.
    const devices = await buildDiscoveredDevices(gladys, cameras, config);
    const capturable = devices.filter((device) =>
      (device.params || []).some(
        (param) => param.name === DEVICE_PARAMS.CAPTURE_MODE && param.value,
      ),
    ).length;
    const blocked = cameras.length - capturable;

    // The exact names matter: they are what the "Save a camera account" action
    // expects, and Gladys cannot render a camera dropdown there today.
    const names = cameras.map((camera) => camera.name).join(', ');

    if (blocked === 0) {
      return {
        en: `Connection OK: ${cameras.length} camera(s) found and reachable on your network — ${names}.`,
        fr: `Connexion OK : ${cameras.length} caméra(s) trouvée(s) et joignable(s) sur votre réseau — ${names}.`,
      };
    }
    return {
      en: `Connection OK: ${cameras.length} camera(s) found (${names}), ${capturable} reachable. The other ${blocked} do not answer locally: check that they are powered on, on the same network, and that "Third-Party Compatibility" is enabled in the Tapo app.`,
      fr: `Connexion OK : ${cameras.length} caméra(s) trouvée(s) (${names}), ${capturable} joignable(s). Les ${blocked} autres ne répondent pas en local : vérifiez qu'elles sont allumées, sur le même réseau, et que la « Compatibilité tierce » est activée dans l'application Tapo.`,
    };
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

// --- Manifest action: refresh every image ------------------------------------
// --- Manifest action: save the camera account of one camera ------------------
// A dedicated mini-form beats asking the user to type `name|user|password` into
// a single box: the camera is picked from a list, and the password goes into a
// masked field instead of sitting in clear next to the username.
gladys.onAction('set_camera_account', async (fields) => {
  const { camera: cameraName, username, password } = fields || {};

  // Matched on the name rather than a dropdown: a `select` fed by the dynamic
  // `devices` source is rejected by Gladys today (it validates the value against
  // an empty option list), so the name typed by the user is the reliable input.
  const devices = await gladys.getDevices();
  const wanted = String(cameraName || '')
    .trim()
    .toLowerCase();
  const device = devices.find((entry) => String(entry.name || '').toLowerCase() === wanted);
  if (!device) {
    const known = devices.map((entry) => entry.name).join(', ');
    return {
      en: `No camera named "${cameraName}". Known cameras: ${known || 'none yet'}.`,
      fr: `Aucune caméra nommée « ${cameraName} ». Caméras connues : ${known || 'aucune pour le moment'}.`,
    };
  }

  // The accounts live in the same config key as the manual field, so both ways
  // of entering them stay interchangeable.
  config = normalizeConfig(await gladys.getConfig());
  const accounts = {
    ...config.camera_accounts,
    [device.name.toLowerCase()]: { username, password },
  };
  const serialized = Object.entries(accounts)
    .map(([name, account]) => `${name}|${account.username}|${account.password}`)
    .join(', ');

  await gladys.setConfig({ camera_accounts: serialized });
  config = normalizeConfig(await gladys.getConfig());

  // Re-publish so CAMERA_URL is rebuilt with the new credentials: it is what the
  // rtsp-camera service reads to serve the live view, and a stale URL would keep
  // the live broken even though the account is now right.
  await publishDevices().catch((e) =>
    logger.warn(`Re-publish after saving the account failed: ${e.message}`),
  );

  // The account that was just saved is exactly what ONVIF authenticates against,
  // so this is the moment the camera becomes able to push its events. Without
  // this the subscription would only be attempted at the next restart, and the
  // camera would keep being polled for no reason in the meantime.
  // Dropped first: an existing client still holds the PREVIOUS credentials, and
  // `setupOnvif` treats a camera it already has a client for as done — so a
  // corrected password would never be picked up.
  watcher.dropOnvif(device);
  watcher
    .setupOnvif(device)
    .catch((e) => logger.debug(`ONVIF setup after saving the account failed: ${e.message}`));

  // Capture right away: the user learns immediately whether the account works,
  // instead of discovering it later through an empty widget.
  try {
    const image = await captureDeviceImage(device);
    await gladys.publishCameraImage(device.external_id, image);
    return {
      en: `Account saved for "${device.name}", and an image was captured successfully.`,
      fr: `Compte enregistré pour « ${device.name} », et une image a bien été capturée.`,
    };
  } catch (e) {
    logger.warn(`The test capture of "${device.name}" failed: ${e.message}`);
    return {
      en: `Account saved for "${device.name}", but the test capture failed: ${e.message}`,
      fr: `Compte enregistré pour « ${device.name} », mais la capture de test a échoué : ${e.message}`,
    };
  }
});

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
  ptzClients.forEach((client) => client.clearWatchdog());
  ptzClients.clear();
  await publishDevices().catch((e) => logger.error('Re-publish after config update failed', e));
  if (isConfigured(config)) {
    // Thresholds first: the watcher polls straight away, and a tick landing
    // before the new thresholds were applied would decide on the old ones.
    batteryGuard.configure(config);
    watcher.start(config);
    startImageRefresh();
  } else {
    watcher.stop();
    stopImageRefresh();
  }
});

// --- Connection lifecycle ----------------------------------------------------
gladys.on('connected', async () => {
  try {
    // Load the devices the user created, so the event watcher knows what to poll.
    const devices = await gladys.getDevices();
    await publishDevices();
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
