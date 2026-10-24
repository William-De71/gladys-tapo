// -----------------------------------------------------------------------------
// The plugs, bulbs, switches and hub sensors: discovery, polling and commands.
//
// The devices push nothing, so their state is polled — one round per physical
// device, every `device_poll_interval` seconds: a single `get_device_info` for a
// plug or a bulb (plus its energy when it meters), a single child list for a
// hub, however many sensors hang off it.
//
// Only CHANGES reach Gladys. The host API rate-limits states (300 a minute per
// integration) and is sized for changes, not snapshots: twenty devices polled
// every few seconds would exhaust it on values that did not move. A value is
// republished anyway after a while, so the "last seen" of a quiet sensor keeps
// meaning something.
// -----------------------------------------------------------------------------

import { logger } from '@gladysassistant/integration-sdk';
import { SmartClient, SmartError } from './client.js';
import {
  FAMILIES,
  SMART_FEATURES,
  SMART_PARAMS,
  SMART_ID_TYPES,
  buildSmartDevices,
  statesFromInfo,
  statesFromSensor,
  buttonValueOf,
  rgbIntToHs,
} from './model.js';
import { DEVICE_PARAMS } from '../tapo/constants.js';

/** A value is republished after this long even when unchanged. */
const REFRESH_UNCHANGED_MS = 10 * 60 * 1000;

/** States per `publishStates` call (the SDK refuses more than 100). */
const STATES_PER_CALL = 100;

/**
 * Read a device param.
 * @param {object} device - The Gladys device.
 * @param {string} name - The param name.
 * @returns {string} The value, '' when absent.
 * @example
 * paramOf(device, 'TAPO_IP');
 */
function paramOf(device, name) {
  return String((device.params || []).find((param) => param.name === name)?.value ?? '');
}

/**
 * The type part of an external id (`ext:<selector>:<type>:<id>`).
 * @param {string} externalId - The id.
 * @returns {string} The type.
 * @example
 * idTypeOf('ext:ext-dev-tapo:plug:8022'); // 'plug'
 */
export function idTypeOf(externalId) {
  return String(externalId || '').split(':')[2] || '';
}

/**
 * Tell whether a Gladys device is one of the devices this module handles.
 * @param {object} device - The Gladys device.
 * @returns {boolean} True for a plug, light, switch or hub sensor.
 * @example
 * isSmartDevice(device);
 */
export function isSmartDevice(device) {
  return SMART_ID_TYPES.includes(idTypeOf(device?.external_id));
}

/**
 * Accumulate a cumulative energy index from a counter that resets daily.
 *
 * The plugs report today's energy (Wh), back to 0 at midnight; the Gladys energy
 * monitoring wants an index that only grows. Each reading adds what was
 * consumed since the previous one; a reading below the previous one is a new
 * day, whose consumption so far is the reading itself. What the plug consumed
 * while the integration was not running is not counted — the index only ever
 * moves forward, never jumps.
 * @param {{ lastToday: number, index: number }|undefined} previous - The state.
 * @param {number} todayWh - Today's energy, in Wh.
 * @param {number} startIndex - The index to start from (kWh), the first time.
 * @returns {{ lastToday: number, index: number }} The new state.
 * @example
 * accumulateEnergy({ lastToday: 100, index: 12.5 }, 150, 0); // index 12.55
 */
export function accumulateEnergy(previous, todayWh, startIndex) {
  if (!previous) {
    return { lastToday: todayWh, index: startIndex };
  }
  const delta = todayWh >= previous.lastToday ? todayWh - previous.lastToday : todayWh;
  return { lastToday: todayWh, index: previous.index + delta / 1000 };
}

/**
 * Discovery, polling and commands of the non-camera devices.
 * @example
 * const manager = new SmartManager({ gladys });
 * manager.start(config);
 */
export class SmartManager {
  /**
   * @param {object} options - The dependencies.
   * @param {object} options.gladys - The SDK instance.
   */
  constructor({ gladys }) {
    this.gladys = gladys;
    this.config = null;
    /** One client per physical device, by address. @type {Map<string, SmartClient>} */
    this.clients = new Map();
    /** Last value published per feature, and when. @type {Map<string, { value: number, at: number }>} */
    this.published = new Map();
    /** Energy accumulation per feature. @type {Map<string, { lastToday: number, index: number }>} */
    this.energy = new Map();
    /** Last button log id seen per sensor. @type {Map<string, number>} */
    this.buttonMarks = new Map();
    /** Last transport published per device. @type {Map<string, string>} */
    this.transports = new Map();
    this.timer = null;
    this.running = false;
  }

  /**
   * The client of a physical device, built once and kept.
   * @param {object} physical - `{ ip, encryptType, loginVersion, httpPort }`.
   * @returns {SmartClient} The client.
   * @example
   * manager.clientFor(physical);
   */
  clientFor(physical) {
    const key = `${physical.ip}:${physical.httpPort || 80}`;
    let client = this.clients.get(key);
    if (!client) {
      client = new SmartClient({
        ip: physical.ip,
        username: this.config?.email || '',
        password: this.config?.password || '',
        encryptType: physical.encryptType || null,
        loginVersion: physical.loginVersion ? Number(physical.loginVersion) : null,
        httpPort: physical.httpPort ? Number(physical.httpPort) : null,
      });
      this.clients.set(key, client);
    }
    return client;
  }

  /**
   * Describe the physical devices as Gladys devices, asking each what it can do.
   *
   * A device that cannot be asked right now (off, unreachable, refusing the
   * account) keeps the devices Gladys already has for it, so a scan never takes
   * away what was already there; one never described before is reported, not
   * published half-built.
   * @param {object[]} physicals - The located cloud devices (non-camera).
   * @param {object[]} knownDevices - What Gladys already holds.
   * @param {object} config - The normalized configuration.
   * @returns {Promise<{ devices: object[], problems: object[] }>} The devices,
   * and what could not be described.
   * @example
   * await manager.describe(physicals, known, config);
   */
  async describe(physicals, knownDevices, config) {
    this.config = config;
    const results = await Promise.all(
      physicals.map(async (physical) => {
        // The H200 hub speaks the cameras' protocol (HTTPS, port 443), not this
        // one: said plainly rather than reported as a device that is off.
        if (physical.family === FAMILIES.HUB && /^H2/i.test(physical.model || '')) {
          return { devices: [], problem: { physical, reason: 'unsupported' } };
        }
        if (!physical.ip) {
          // `listed`: the address action picks among the devices Gladys
          // holds, so one never described can only get its address from the
          // manual field — the report has to say which.
          const previous = this.previousDevicesOf(physical, knownDevices);
          return {
            devices: previous,
            problem: { physical, reason: 'address', listed: previous.length > 0 },
          };
        }
        try {
          return { devices: await this.describeOne(physical), problem: null };
        } catch (e) {
          logger.warn(`"${physical.name}" (${physical.model}) could not be read: ${e.message}`);
          return {
            devices: this.previousDevicesOf(physical, knownDevices),
            problem: {
              physical,
              reason: e.authFailed ? 'credentials' : 'unreachable',
              message: e.message,
            },
          };
        }
      }),
    );
    return {
      devices: results.flatMap((result) => result.devices),
      problems: results.map((result) => result.problem).filter(Boolean),
    };
  }

  /**
   * Ask one physical device what it is.
   * @param {object} physical - The located cloud device.
   * @returns {Promise<object[]>} Its Gladys devices.
   * @example
   * await manager.describeOne(physical);
   */
  async describeOne(physical) {
    const client = this.clientFor(physical);
    if (physical.family === FAMILIES.HUB) {
      const children = await client.getChildren();
      return buildSmartDevices(this.gladys, physical, { children });
    }

    const answers = await client.multiple([
      { method: 'get_device_info' },
      { method: 'get_energy_usage' },
    ]);
    const info = answers.get_device_info;
    if (!info || info instanceof SmartError) {
      throw info || new Error('TAPO_SMART_NO_INFO');
    }
    const metered =
      Boolean(answers.get_energy_usage) && !(answers.get_energy_usage instanceof SmartError);

    // A power strip lists its sockets; a single plug refuses the method.
    let children = [];
    const meteredChildren = new Set();
    if (physical.family === FAMILIES.PLUG) {
      children = await client.getChildren().catch(() => []);
      await Promise.all(
        children.map((child) =>
          client
            .childRequest(child.device_id, 'get_energy_usage')
            .then(() => meteredChildren.add(child.device_id))
            .catch(() => {}),
        ),
      );
    }
    return buildSmartDevices(this.gladys, physical, { info, metered, children, meteredChildren });
  }

  /**
   * The devices Gladys already has for a physical device, kept as they are.
   * @param {object} physical - The located cloud device.
   * @param {object[]} knownDevices - What Gladys holds.
   * @returns {object[]} Those devices.
   * @example
   * manager.previousDevicesOf(physical, known);
   */
  previousDevicesOf(physical, knownDevices) {
    return (knownDevices || []).filter(
      (device) =>
        isSmartDevice(device) &&
        paramOf(device, DEVICE_PARAMS.CLOUD_DEVICE_ID).toUpperCase() ===
          String(physical.cloudDeviceId).toUpperCase(),
    );
  }

  /**
   * Start (or restart) the polling loop.
   * @param {object} config - The normalized configuration.
   * @example
   * manager.start(config);
   */
  start(config) {
    this.stop();
    this.config = config;
    const seconds = Math.max(2, Number(config.device_poll_interval) || 10);
    this.timer = setInterval(() => {
      this.tick().catch((e) => logger.debug(`Tapo device poll failed: ${e.message}`));
    }, seconds * 1000);
    logger.info(`Polling the Tapo plugs, lights and sensors every ${seconds}s`);
  }

  /**
   * Stop the loop and drop the sessions (the account may have changed).
   * @example
   * manager.stop();
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.clients.clear();
  }

  /**
   * Poll every physical device that has at least one Gladys device.
   * @returns {Promise<void>} Resolves once the round is done.
   * @example
   * await manager.tick();
   */
  async tick() {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const devices = (await this.gladys.getDevices()).filter(isSmartDevice);
      // Grouped by the physical device that answers for them: one round trip
      // per hub or strip, whatever the number of sensors or sockets.
      const groups = new Map();
      devices.forEach((device) => {
        const key = `${paramOf(device, DEVICE_PARAMS.IP)}|${paramOf(device, DEVICE_PARAMS.CLOUD_DEVICE_ID)}`;
        if (!groups.has(key)) {
          groups.set(key, []);
        }
        groups.get(key).push(device);
      });
      const states = [];
      const transports = [];
      await Promise.all(
        [...groups.values()].map(async (group) => {
          const reachable = await this.pollGroup(group, states).then(
            () => true,
            (e) => {
              logger.debug(`Polling "${group[0].name}" failed: ${e.message}`);
              return false;
            },
          );
          group.forEach((device) => {
            const transport = reachable ? 'local' : 'unreachable';
            if (this.transports.get(device.external_id) !== transport) {
              this.transports.set(device.external_id, transport);
              transports.push({ external_id: device.external_id, transport });
            }
          });
        }),
      );
      await this.flush(states);
      if (transports.length > 0 && typeof this.gladys.publishTransports === 'function') {
        await this.gladys.publishTransports(transports.slice(0, 100)).catch(() => {});
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * The physical device a Gladys device belongs to, from its params.
   * @param {object} device - The Gladys device.
   * @returns {object} `{ ip, encryptType, loginVersion, httpPort, family }`.
   * @example
   * manager.physicalOf(device);
   */
  physicalOf(device) {
    return {
      ip: paramOf(device, DEVICE_PARAMS.IP),
      encryptType: paramOf(device, SMART_PARAMS.ENCRYPT_TYPE) || null,
      loginVersion: paramOf(device, SMART_PARAMS.LOGIN_VERSION) || null,
      httpPort: paramOf(device, SMART_PARAMS.HTTP_PORT) || null,
      family: paramOf(device, SMART_PARAMS.FAMILY),
    };
  }

  /**
   * Poll the devices of one physical device, adding their states to `states`.
   * @param {object[]} group - Gladys devices sharing one physical device.
   * @param {object[]} states - Where to add the states to publish.
   * @returns {Promise<void>} Resolves once read.
   * @example
   * await manager.pollGroup(group, states);
   */
  async pollGroup(group, states) {
    const physical = this.physicalOf(group[0]);
    if (!physical.ip) {
      throw new Error('TAPO_SMART_NO_ADDRESS');
    }
    const client = this.clientFor(physical);
    const childIds = group.map((device) => paramOf(device, SMART_PARAMS.CHILD_ID)).filter(Boolean);

    if (childIds.length === 0) {
      // A single plug, bulb or switch.
      const device = group[0];
      const wantsEnergy = hasFeature(device, SMART_FEATURES.ENERGY);
      const answers = await client.multiple([
        { method: 'get_device_info' },
        ...(wantsEnergy ? [{ method: 'get_energy_usage' }] : []),
      ]);
      const info = answers.get_device_info;
      if (!info || info instanceof SmartError) {
        throw info || new Error('TAPO_SMART_NO_INFO');
      }
      this.collect(device, statesFromInfo(info), states);
      if (
        wantsEnergy &&
        answers.get_energy_usage &&
        !(answers.get_energy_usage instanceof SmartError)
      ) {
        this.collectEnergy(device, answers.get_energy_usage, states);
      }
      return;
    }

    // A hub or a power strip: one child list for all of them.
    const children = await client.getChildren();
    const byId = new Map(children.map((child) => [child.device_id, child]));
    await Promise.all(
      group.map(async (device) => {
        const childId = paramOf(device, SMART_PARAMS.CHILD_ID);
        const child = byId.get(childId);
        if (!child) {
          return;
        }
        if (physical.family === FAMILIES.HUB) {
          this.collect(device, statesFromSensor(child), states);
          if (hasFeature(device, SMART_FEATURES.BUTTON)) {
            await this.collectButton(client, device, childId, states);
          }
        } else {
          this.collect(device, statesFromInfo(child), states);
          if (hasFeature(device, SMART_FEATURES.ENERGY)) {
            const usage = await client.childRequest(childId, 'get_energy_usage').catch(() => null);
            if (usage) {
              this.collectEnergy(device, usage, states);
            }
          }
        }
      }),
    );
  }

  /**
   * Queue the values that changed (or that went unpublished for too long).
   * @param {object} device - The Gladys device.
   * @param {Record<string, number>} values - Values by feature suffix.
   * @param {object[]} states - Where to add them.
   * @example
   * manager.collect(device, { on: 1 }, states);
   */
  collect(device, values, states) {
    Object.entries(values).forEach(([suffix, value]) => {
      if (!hasFeature(device, suffix)) {
        return;
      }
      const featureId = `${device.external_id}:${suffix}`;
      const last = this.published.get(featureId);
      if (last && last.value === value && Date.now() - last.at < REFRESH_UNCHANGED_MS) {
        return;
      }
      states.push({ device_feature_external_id: featureId, state: value });
    });
  }

  /**
   * Queue the power and the energy index of a metered outlet.
   * @param {object} device - The Gladys device.
   * @param {object} usage - `get_energy_usage`.
   * @param {object[]} states - Where to add them.
   * @example
   * manager.collectEnergy(device, usage, states);
   */
  collectEnergy(device, usage, states) {
    const values = {};
    // Milliwatts on these plugs.
    if (Number.isFinite(usage.current_power)) {
      values[SMART_FEATURES.POWER] = Math.round(usage.current_power / 100) / 10;
    }
    if (Number.isFinite(usage.today_energy)) {
      const featureId = `${device.external_id}:${SMART_FEATURES.ENERGY}`;
      const known = (device.features || []).find((entry) => entry.external_id === featureId);
      const startIndex = Number.isFinite(known?.last_value) ? known.last_value : 0;
      const next = accumulateEnergy(this.energy.get(featureId), usage.today_energy, startIndex);
      this.energy.set(featureId, next);
      values[SMART_FEATURES.ENERGY] = Math.round(next.index * 1000) / 1000;
    }
    this.collect(device, values, states);
  }

  /**
   * Queue the button presses logged since the last look.
   *
   * The first look only records where the log stands: starting the integration
   * must not replay presses made before it.
   * @param {SmartClient} client - The hub client.
   * @param {object} device - The button's Gladys device.
   * @param {string} childId - The button's id.
   * @param {object[]} states - Where to add the presses.
   * @returns {Promise<void>} Resolves once read.
   * @example
   * await manager.collectButton(client, device, childId, states);
   */
  async collectButton(client, device, childId, states) {
    const result = await client
      .childRequest(childId, 'get_trigger_logs', { start_id: 0 })
      .catch(() => null);
    const logs = Array.isArray(result?.logs) ? result.logs : [];
    const latest = logs.reduce((max, log) => Math.max(max, Number(log.id) || 0), 0);
    const mark = this.buttonMarks.get(childId);
    this.buttonMarks.set(childId, Math.max(latest, mark ?? 0));
    if (mark === undefined) {
      return;
    }
    logs
      .filter((log) => Number(log.id) > mark)
      .sort((a, b) => Number(a.id) - Number(b.id))
      .forEach((log) => {
        const value = buttonValueOf(log.event);
        if (value !== null) {
          // A press is an event: published even when equal to the last one.
          states.push({
            device_feature_external_id: `${device.external_id}:${SMART_FEATURES.BUTTON}`,
            state: value,
          });
        }
      });
  }

  /**
   * Publish the queued states, in batches, and remember what was published.
   * @param {object[]} states - The states.
   * @returns {Promise<void>} Resolves once sent.
   * @example
   * await manager.flush(states);
   */
  async flush(states) {
    for (let index = 0; index < states.length; index += STATES_PER_CALL) {
      const batch = states.slice(index, index + STATES_PER_CALL);
      const sent = await this.gladys.publishStates(batch).then(
        () => true,
        (e) => {
          logger.debug(`Publishing ${batch.length} Tapo state(s) failed: ${e.message}`);
          return false;
        },
      );
      if (sent) {
        const now = Date.now();
        batch.forEach((state) => {
          this.published.set(state.device_feature_external_id, { value: state.state, at: now });
        });
      }
    }
  }

  /**
   * Apply a command written by Gladys.
   * @param {object} device - The device, as the command payload carries it.
   * @param {object} deviceFeature - The feature written to.
   * @param {number} value - The value.
   * @returns {Promise<void>} Resolves once the device accepted it.
   * @example
   * await manager.setValue(device, feature, 1);
   */
  async setValue(device, deviceFeature, value) {
    // A command payload carries the params, not always the features: re-read
    // the device when they are missing, the energy/child logic needs them.
    const full =
      (device.params || []).length > 0
        ? device
        : (await this.gladys.getDevices()).find(
            (entry) => entry.external_id === device.external_id,
          ) || device;
    const physical = this.physicalOf(full);
    if (!physical.ip) {
      throw new Error(`No local address known for "${full.selector || full.external_id}"`);
    }
    const client = this.clientFor(physical);
    const childId = paramOf(full, SMART_PARAMS.CHILD_ID);
    const suffix = String(deviceFeature.external_id || '')
      .split(':')
      .pop();
    const params = commandParams(suffix, Number(value));
    if (!params) {
      logger.debug(`Ignoring a write to the read-only "${suffix}" of ${full.external_id}`);
      return;
    }
    logger.info(`onSetValue <- ${suffix}=${value} on "${full.selector || full.external_id}"`);
    if (childId) {
      await client.childRequest(childId, 'set_device_info', params);
    } else {
      await client.request('set_device_info', params);
    }
    // Reported at once: the feature reads back on the next poll anyway, but the
    // dashboard should not wait for it.
    const featureId = `${full.external_id}:${suffix}`;
    await this.flush([{ device_feature_external_id: featureId, state: Number(value) }]);
  }
}

/**
 * Tell whether a device carries a feature, by suffix.
 * @param {object} device - The Gladys device.
 * @param {string} suffix - The feature suffix.
 * @returns {boolean} True when present.
 * @example
 * hasFeature(device, 'energy');
 */
function hasFeature(device, suffix) {
  return (device.features || []).some((entry) =>
    String(entry.external_id || '').endsWith(`:${suffix}`),
  );
}

/**
 * The `set_device_info` params of one command.
 * @param {string} suffix - The feature written to.
 * @param {number} value - The value.
 * @returns {object|null} The params, or null for a read-only feature.
 * @example
 * commandParams('brightness', 40); // { device_on: true, brightness: 40 }
 */
export function commandParams(suffix, value) {
  switch (suffix) {
    case SMART_FEATURES.ON:
      return { device_on: value === 1 };
    case SMART_FEATURES.BRIGHTNESS:
      // 0 is how Gladys dims to nothing: the firmware refuses brightness 0.
      return value <= 0
        ? { device_on: false }
        : { device_on: true, brightness: Math.min(100, Math.max(1, Math.round(value))) };
    case SMART_FEATURES.COLOR:
      // A color only shows with the white channel off (`color_temp: 0`).
      return { ...rgbIntToHs(value), color_temp: 0 };
    case SMART_FEATURES.COLOR_TEMPERATURE:
      return { color_temp: Math.round(value) };
    case SMART_FEATURES.TARGET_TEMPERATURE:
      return { target_temp: value, frost_protection_on: false };
    default:
      return null;
  }
}
