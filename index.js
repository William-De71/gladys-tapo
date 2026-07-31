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

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { TapoCloud, TapoAuthError } from './src/tapo/cloud.js';
import { EventWatcher } from './src/tapo/events.js';
import { captureImage } from './src/tapo/snapshot.js';
import { normalizeConfig, isConfigured, hasRtspAccount } from './src/config.js';
import { buildDiscoveredDevices, cameraFromDevice, parseCloudDeviceId } from './src/devices.js';
import { CAPTURE_MODES, DEVICE_PARAMS } from './src/tapo/constants.js';
import { BatteryGuard } from './src/tapo/batteryGuard.js';

const gladys = new GladysIntegration();
const cloud = new TapoCloud();
// Guards the battery of solar/wire-free cameras: capturing is what drains them,
// so it backs off well before the cell reaches a level it may not recover from.
const batteryGuard = new BatteryGuard();

let config = normalizeConfig();

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
  const camera = await cameraFromDevice(device, config);
  if (!camera.ip) {
    throw new Error('TAPO_CAMERA_IP_UNKNOWN');
  }
  if (camera.captureMode === CAPTURE_MODES.RTSP && !hasRtspAccount(config, camera.name)) {
    // Failing with a precise reason: the user has a fix to apply (fill in the
    // camera account), which a generic ffmpeg error would not convey.
    throw new Error('TAPO_RTSP_ACCOUNT_MISSING');
  }
  return captureImage(camera, config);
}

/**
 * Capture and publish the image of every camera passed in.
 *
 * Sequential on purpose: several ffmpeg captures at once would compete for CPU
 * on a Raspberry Pi, and a camera answers faster when it is alone.
 * @param {object[]} devices - The devices to refresh.
 * @returns {Promise<{ published: number, failures: string[] }>} What happened.
 * @example
 * const { published } = await refreshImages(await gladys.getDevices());
 */
async function refreshImages(devices) {
  const cameras = (devices || []).filter((device) =>
    (device.features || []).some((feature) => feature.category === 'camera'),
  );
  let published = 0;
  /** @type {string[]} */
  const failures = [];

  for (const device of cameras) {
    // The scheduled refresh is the expensive part, so it is the first thing a
    // draining battery gives up — an explicit request still goes through.
    if (!batteryGuard.allowsScheduled(device.external_id)) {
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
  const intervalSeconds = config.image_refresh_interval;
  refreshTimer = setInterval(async () => {
    try {
      // Re-read the devices every round: a camera may have been added or removed.
      const devices = await gladys.getDevices();
      await refreshImages(devices);
    } catch (e) {
      logger.debug(`The image refresh round failed: ${e.message}`);
    }
  }, intervalSeconds * 1000);
  logger.info(`Refreshing the camera images every ${intervalSeconds}s`);
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

// --- Polling: Gladys asks to refresh a device --------------------------------
// The image itself is pulled by `onGetImage`, so a poll is the moment to refresh
// what the widget does not ask for: the battery level and any missed event.
gladys.onPoll(async (device) => {
  const cloudDeviceId = parseCloudDeviceId(device.external_id);
  if (!cloudDeviceId || !isConfigured(config)) {
    return;
  }

  // The dashboard camera widget does NOT ask for a fresh image: it displays the
  // last one published, and shows an error when none is recent enough. So the
  // image has to be PUSHED — `onGetImage` alone only covers the live view and
  // the chat intent, which would leave the widget permanently empty.
  const hasCamera = (device.features || []).some((feature) => feature.category === 'camera');
  if (hasCamera) {
    try {
      const image = await captureDeviceImage(device);
      await gladys.publishCameraImage(device.external_id, image);
      logger.debug(`Image of "${device.name}" refreshed`);
    } catch (e) {
      logger.warn(`Refreshing the image of "${device.name}" failed: ${e.message}`);
    }
  }

  await watcher
    .checkDevice(device)
    .catch((e) => logger.debug(`Poll of "${device.name}" failed: ${e.message}`));
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

  const { published, failures } = await refreshImages(cameras);

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
  await publishDevices().catch((e) => logger.error('Re-publish after config update failed', e));
  if (isConfigured(config)) {
    watcher.start(config);
    batteryGuard.configure(config);
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
      watcher.start(config);
      batteryGuard.configure(config);
      startImageRefresh();
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
