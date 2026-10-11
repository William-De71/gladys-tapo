// -----------------------------------------------------------------------------
// From what a Tapo plug, bulb, switch or hub answers to Gladys devices.
//
// One physical device can become several Gladys devices: each socket of a power
// strip is controlled on its own, and each sensor paired to a hub is a device of
// its own (a door contact, a thermometer…). Every one of them carries, in its
// params, how to reach the PHYSICAL device that answers for it — address,
// protocol, and its own id when it is a sub-device — so a poll or a command
// needs neither the cloud nor a scan.
//
// Features are created from what the device ANSWERED, never from its model:
// a bulb publishes a color feature because its info carries a hue, a plug an
// energy feature because it answered `get_energy_usage`.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { DEVICE_PARAMS } from '../tapo/constants.js';

/** What a cloud `deviceType` is, for this integration. */
export const FAMILIES = {
  CAMERA: 'camera',
  PLUG: 'plug',
  LIGHT: 'light',
  SWITCH: 'switch',
  HUB: 'hub',
};

/**
 * External id types of the Gladys devices built here. A hub sensor is a
 * `sensor` whatever it measures; a strip socket is a `plug`.
 */
export const SMART_ID_TYPES = ['plug', 'light', 'switch', 'sensor'];

/** Feature id suffixes. */
export const SMART_FEATURES = {
  ON: 'on',
  BRIGHTNESS: 'brightness',
  COLOR: 'color',
  COLOR_TEMPERATURE: 'color-temperature',
  POWER: 'power',
  ENERGY: 'energy',
  TEMPERATURE: 'temperature',
  HUMIDITY: 'humidity',
  MOTION: 'motion',
  CONTACT: 'contact',
  LEAK: 'leak',
  BUTTON: 'button',
  BATTERY: 'battery',
  BATTERY_LOW: 'battery-low',
  TARGET_TEMPERATURE: 'target-temperature',
};

/** Params specific to these devices (the shared ones are in DEVICE_PARAMS). */
export const SMART_PARAMS = {
  /** 'plug', 'light', 'switch' or 'hub': the physical device's family. */
  FAMILY: 'TAPO_FAMILY',
  /** The sub-device id, for a strip socket or a hub sensor. */
  CHILD_ID: 'TAPO_CHILD_ID',
  /** 'KLAP' or 'AES', as announced by the device. */
  ENCRYPT_TYPE: 'TAPO_ENCRYPT_TYPE',
  /** 1 or 2, the hashing generation of the login. */
  LOGIN_VERSION: 'TAPO_LOGIN_VERSION',
  /** The HTTP port, when the device announced one other than 80. */
  HTTP_PORT: 'TAPO_HTTP_PORT',
};

/** Values of `button/click`, as Gladys defines them (BUTTON_STATUS). */
export const BUTTON_VALUES = {
  CLICK: 1,
  DOUBLE_CLICK: 2,
  LONG_CLICK: 6,
};

/**
 * Classify a cloud device by its `deviceType`.
 * @param {string} deviceType - E.g. 'SMART.TAPOPLUG'.
 * @returns {string|null} One of FAMILIES, or null when not supported.
 * @example
 * familyOf('SMART.TAPOBULB'); // 'light'
 */
export function familyOf(deviceType) {
  const type = String(deviceType || '').toUpperCase();
  if (!type.startsWith('SMART.')) {
    // `IOT.*` are the older Kasa devices, on another protocol entirely.
    return null;
  }
  if (type.includes('IPCAMERA') || type.includes('DOORBELL')) {
    return FAMILIES.CAMERA;
  }
  if (type.endsWith('PLUG')) {
    return FAMILIES.PLUG;
  }
  if (type.endsWith('BULB')) {
    return FAMILIES.LIGHT;
  }
  if (type.endsWith('SWITCH')) {
    return FAMILIES.SWITCH;
  }
  if (type.endsWith('HUB')) {
    return FAMILIES.HUB;
  }
  return null;
}

/**
 * Decode a device nickname, which the firmware stores base64-encoded.
 * @param {string} nickname - The raw nickname.
 * @returns {string} The name, or '' when there is none.
 * @example
 * decodeNickname('U2Fsb24='); // 'Salon'
 */
export function decodeNickname(nickname) {
  if (!nickname) {
    return '';
  }
  try {
    const text = Buffer.from(nickname, 'base64').toString('utf8').trim();
    // A nickname that was not base64 decodes to garbage: keep the raw one.
    return /^[\p{L}\p{N}\p{P}\p{Zs}\p{S}]+$/u.test(text) ? text : String(nickname);
  } catch {
    return String(nickname);
  }
}

/**
 * Convert a hue/saturation pair to the integer RGB Gladys stores.
 * @param {number} hue - 0-360.
 * @param {number} saturation - 0-100.
 * @returns {number} 0xRRGGBB, at full brightness (Gladys keeps it separate).
 * @example
 * hsToRgbInt(0, 100); // 0xff0000
 */
export function hsToRgbInt(hue, saturation) {
  const h = (((Number(hue) % 360) + 360) % 360) / 60;
  const s = Math.max(0, Math.min(100, Number(saturation))) / 100;
  const c = s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = 1 - c;
  const [r, g, b] =
    h < 1
      ? [c, x, 0]
      : h < 2
        ? [x, c, 0]
        : h < 3
          ? [0, c, x]
          : h < 4
            ? [0, x, c]
            : h < 5
              ? [x, 0, c]
              : [c, 0, x];
  const to255 = (value) => Math.round((value + m) * 255);
  return (to255(r) << 16) | (to255(g) << 8) | to255(b);
}

/**
 * Convert the integer RGB Gladys sends to the hue/saturation Tapo expects.
 * @param {number} rgb - 0xRRGGBB.
 * @returns {{ hue: number, saturation: number }} Hue 0-360, saturation 0-100.
 * @example
 * rgbIntToHs(0x00ff00); // { hue: 120, saturation: 100 }
 */
export function rgbIntToHs(rgb) {
  const value = Math.max(0, Math.min(0xffffff, Math.round(Number(rgb) || 0)));
  const r = ((value >> 16) & 0xff) / 255;
  const g = ((value >> 8) & 0xff) / 255;
  const b = (value & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === r) {
      hue = 60 * (((g - b) / delta) % 6);
    } else if (max === g) {
      hue = 60 * ((b - r) / delta + 2);
    } else {
      hue = 60 * ((r - g) / delta + 4);
    }
  }
  return {
    hue: Math.round((hue + 360) % 360),
    saturation: max === 0 ? 0 : Math.round((delta / max) * 100),
  };
}

/**
 * Build one feature.
 * @param {object} ids - The id factory of the device.
 * @param {string} name - The device name.
 * @param {string} suffix - The feature suffix.
 * @param {object} spec - Category, type and the rest.
 * @returns {object} The feature.
 * @example
 * feature(ids, 'Salon', 'on', { category: 'switch', type: 'binary' });
 */
function feature(ids, name, suffix, spec) {
  return {
    name: `${name} - ${spec.label}`,
    external_id: ids.feature(suffix),
    category: spec.category,
    type: spec.type,
    read_only: spec.readOnly ?? true,
    keep_history: spec.keepHistory ?? true,
    // Every state here is read back from the device at each poll, so Gladys
    // waits for it rather than assuming the command worked.
    has_feedback: spec.hasFeedback ?? true,
    min: spec.min ?? 0,
    max: spec.max ?? 1,
    ...(spec.unit ? { unit: spec.unit } : {}),
  };
}

/**
 * The features of a light: on/off, and what its info shows it can do.
 * @param {object} ids - The id factory.
 * @param {string} name - The device name.
 * @param {object} info - `get_device_info`.
 * @returns {object[]} The features.
 * @example
 * lightFeatures(ids, 'Salon', info);
 */
function lightFeatures(ids, name, info) {
  const C = DEVICE_FEATURE_CATEGORIES.LIGHT;
  const T = DEVICE_FEATURE_TYPES.LIGHT;
  const features = [
    feature(ids, name, SMART_FEATURES.ON, {
      label: 'On',
      category: C,
      type: T.BINARY,
      readOnly: false,
    }),
  ];
  if (info.brightness !== undefined) {
    features.push(
      feature(ids, name, SMART_FEATURES.BRIGHTNESS, {
        label: 'Brightness',
        category: C,
        type: T.BRIGHTNESS,
        readOnly: false,
        min: 1,
        max: 100,
        unit: DEVICE_FEATURE_UNITS.PERCENT,
      }),
    );
  }
  if (info.hue !== undefined && info.saturation !== undefined) {
    features.push(
      feature(ids, name, SMART_FEATURES.COLOR, {
        label: 'Color',
        category: C,
        type: T.COLOR,
        readOnly: false,
        max: 0xffffff,
      }),
    );
  }
  // A range collapsed on one value (an L900 reports [9000, 9000]) is a strip
  // with no white channel to tune: no feature rather than a slider that moves
  // nothing.
  const range = Array.isArray(info.color_temp_range) ? info.color_temp_range : null;
  if (range && range.length === 2 && range[0] < range[1]) {
    features.push(
      feature(ids, name, SMART_FEATURES.COLOR_TEMPERATURE, {
        label: 'Color temperature',
        category: C,
        type: T.TEMPERATURE,
        readOnly: false,
        // Kelvins, which the Gladys light panel reads as such (values > 1000).
        min: range[0],
        max: range[1],
        unit: DEVICE_FEATURE_UNITS.KELVIN,
      }),
    );
  }
  return features;
}

/**
 * The features of an outlet (a plug, a strip socket, an on/off wall switch).
 * @param {object} ids - The id factory.
 * @param {string} name - The device name.
 * @param {boolean} metered - True when it answered `get_energy_usage`.
 * @returns {object[]} The features.
 * @example
 * outletFeatures(ids, 'Lave-linge', true);
 */
function outletFeatures(ids, name, metered) {
  const C = DEVICE_FEATURE_CATEGORIES.SWITCH;
  const T = DEVICE_FEATURE_TYPES.SWITCH;
  const features = [
    feature(ids, name, SMART_FEATURES.ON, {
      label: 'On',
      category: C,
      type: T.BINARY,
      readOnly: false,
    }),
  ];
  if (metered) {
    features.push(
      feature(ids, name, SMART_FEATURES.POWER, {
        label: 'Power',
        category: C,
        type: T.POWER,
        max: 4000,
        unit: DEVICE_FEATURE_UNITS.WATT,
      }),
      // A cumulative index, in kWh — what the Gladys energy monitoring reads
      // consumption from. The plug only reports today's and this month's
      // energy; the index is accumulated from those (see the manager).
      feature(ids, name, SMART_FEATURES.ENERGY, {
        label: 'Energy',
        category: C,
        type: T.ENERGY,
        max: 1000000,
        unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
      }),
    );
  }
  return features;
}

/**
 * The battery features of a hub sensor.
 * @param {object} ids - The id factory.
 * @param {string} name - The device name.
 * @param {object} child - The sensor, from the hub's child list.
 * @returns {object[]} The features.
 * @example
 * batteryFeatures(ids, 'Porte', child);
 */
function batteryFeatures(ids, name, child) {
  const features = [];
  if (child.battery_percentage !== undefined) {
    features.push(
      feature(ids, name, SMART_FEATURES.BATTERY, {
        label: 'Battery',
        category: DEVICE_FEATURE_CATEGORIES.BATTERY,
        type: DEVICE_FEATURE_TYPES.BATTERY.INTEGER,
        max: 100,
        unit: DEVICE_FEATURE_UNITS.PERCENT,
      }),
    );
  }
  if (child.at_low_battery !== undefined) {
    features.push(
      feature(ids, name, SMART_FEATURES.BATTERY_LOW, {
        label: 'Low battery',
        category: DEVICE_FEATURE_CATEGORIES.BATTERY_LOW,
        type: DEVICE_FEATURE_TYPES.BATTERY_LOW.BINARY,
      }),
    );
  }
  return features;
}

/**
 * The unit of a temperature the device reports.
 * @param {object} child - The sensor.
 * @returns {string} The Gladys unit.
 * @example
 * temperatureUnit({ temp_unit: 'fahrenheit' });
 */
function temperatureUnit(child) {
  return String(child.temp_unit || '').toLowerCase() === 'fahrenheit'
    ? DEVICE_FEATURE_UNITS.FAHRENHEIT
    : DEVICE_FEATURE_UNITS.CELSIUS;
}

/**
 * The features of a hub sensor, by its category.
 * @param {object} ids - The id factory.
 * @param {string} name - The device name.
 * @param {object} child - The sensor, from the hub's child list.
 * @returns {object[]|null} The features, or null when the sensor is not supported.
 * @example
 * sensorFeatures(ids, 'Porte', { category: 'subg.trigger.contact-sensor', open: false });
 */
export function sensorFeatures(ids, name, child) {
  const category = String(child.category || '');
  const temperature = () =>
    feature(ids, name, SMART_FEATURES.TEMPERATURE, {
      label: 'Temperature',
      category: DEVICE_FEATURE_CATEGORIES.TEMPERATURE_SENSOR,
      type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
      min: -40,
      max: 100,
      unit: temperatureUnit(child),
    });

  let features;
  if (category.endsWith('temp-hmdt-sensor')) {
    features = [
      temperature(),
      feature(ids, name, SMART_FEATURES.HUMIDITY, {
        label: 'Humidity',
        category: DEVICE_FEATURE_CATEGORIES.HUMIDITY_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
        max: 100,
        unit: DEVICE_FEATURE_UNITS.PERCENT,
      }),
    ];
  } else if (category.endsWith('motion-sensor')) {
    features = [
      feature(ids, name, SMART_FEATURES.MOTION, {
        label: 'Motion',
        category: DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
      }),
    ];
  } else if (category.endsWith('contact-sensor')) {
    features = [
      feature(ids, name, SMART_FEATURES.CONTACT, {
        label: 'Opening',
        category: DEVICE_FEATURE_CATEGORIES.OPENING_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
      }),
    ];
  } else if (category.endsWith('water-leak-sensor')) {
    features = [
      feature(ids, name, SMART_FEATURES.LEAK, {
        label: 'Leak',
        category: DEVICE_FEATURE_CATEGORIES.LEAK_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
      }),
    ];
  } else if (category.endsWith('trigger.button')) {
    features = [
      feature(ids, name, SMART_FEATURES.BUTTON, {
        label: 'Button',
        category: DEVICE_FEATURE_CATEGORIES.BUTTON,
        type: DEVICE_FEATURE_TYPES.BUTTON.CLICK,
        // A press is an event, not a state worth reading back.
        hasFeedback: false,
        min: 0,
        max: BUTTON_VALUES.LONG_CLICK,
      }),
    ];
  } else if (category.endsWith('trv')) {
    features = [
      temperature(),
      feature(ids, name, SMART_FEATURES.TARGET_TEMPERATURE, {
        label: 'Target temperature',
        category: DEVICE_FEATURE_CATEGORIES.THERMOSTAT,
        type: DEVICE_FEATURE_TYPES.THERMOSTAT.TARGET_TEMPERATURE,
        readOnly: false,
        min: Number(child.min_control_temp ?? 5),
        max: Number(child.max_control_temp ?? 30),
        unit: temperatureUnit(child),
      }),
    ];
  } else {
    return null;
  }
  return [...features, ...batteryFeatures(ids, name, child)];
}

/**
 * The params every device built here carries.
 * @param {object} physical - The physical device, as located.
 * @param {object} [extra] - Params specific to this Gladys device.
 * @returns {object[]} The params.
 * @example
 * baseParams(located, { [SMART_PARAMS.CHILD_ID]: '8022…' });
 */
function baseParams(physical, extra = {}) {
  const params = {
    [DEVICE_PARAMS.CLOUD_DEVICE_ID]: physical.cloudDeviceId,
    [DEVICE_PARAMS.IP]: physical.ip || '',
    [DEVICE_PARAMS.IP_SOURCE]: physical.ipSource || '',
    [DEVICE_PARAMS.MAC]: physical.mac || '',
    [DEVICE_PARAMS.MODEL]: physical.model || '',
    [SMART_PARAMS.FAMILY]: physical.family,
    [SMART_PARAMS.ENCRYPT_TYPE]: physical.encryptType || '',
    [SMART_PARAMS.LOGIN_VERSION]: physical.loginVersion ? String(physical.loginVersion) : '',
    [SMART_PARAMS.HTTP_PORT]: physical.httpPort ? String(physical.httpPort) : '',
    ...extra,
  };
  return Object.entries(params).map(([name, value]) => ({ name, value: String(value ?? '') }));
}

/**
 * Build the Gladys devices of one physical device from what it answered.
 * @param {object} gladys - The SDK instance, which namespaces the ids.
 * @param {object} physical - The located cloud device (`family`, `ip`…).
 * @param {object} answers - What the device answered.
 * @param {object} [answers.info] - `get_device_info`.
 * @param {boolean} [answers.metered] - It answered `get_energy_usage`.
 * @param {object[]} [answers.children] - Its sub-devices.
 * @param {Set<string>} [answers.meteredChildren] - Sockets that answered energy.
 * @returns {object[]} The devices.
 * @example
 * buildSmartDevices(gladys, located, { info, metered: true });
 */
export function buildSmartDevices(
  gladys,
  physical,
  { info = {}, metered = false, children = [], meteredChildren = new Set() },
) {
  const name = physical.name || decodeNickname(info.nickname) || physical.model || 'Tapo';
  const base = { model: physical.model || info.model || null, should_poll: false };

  if (physical.family === FAMILIES.HUB) {
    // The hub itself controls nothing Gladys models; its sensors are the
    // devices.
    return children
      .map((child) => {
        const childName = decodeNickname(child.nickname) || child.model || 'Tapo sensor';
        const ids = gladys.externalIds('sensor', child.device_id);
        const features = sensorFeatures(ids, childName, child);
        if (!features) {
          return null;
        }
        return {
          ...base,
          name: childName,
          model: child.model || null,
          external_id: ids.device,
          features,
          params: baseParams(physical, { [SMART_PARAMS.CHILD_ID]: child.device_id }),
        };
      })
      .filter(Boolean);
  }

  if (children.length > 0) {
    // A power strip: one device per socket, each switched on its own.
    return children.map((child, index) => {
      const socketName = decodeNickname(child.nickname) || `${name} ${child.position ?? index + 1}`;
      const ids = gladys.externalIds('plug', child.device_id);
      return {
        ...base,
        name: socketName,
        external_id: ids.device,
        features: outletFeatures(ids, socketName, meteredChildren.has(child.device_id)),
        params: baseParams(physical, { [SMART_PARAMS.CHILD_ID]: child.device_id }),
      };
    });
  }

  // A light is whatever has a brightness: a bulb, a light strip, a wall dimmer.
  const isLight = physical.family === FAMILIES.LIGHT || info.brightness !== undefined;
  const type = isLight ? 'light' : physical.family === FAMILIES.SWITCH ? 'switch' : 'plug';
  const ids = gladys.externalIds(type, physical.cloudDeviceId);
  return [
    {
      ...base,
      name,
      external_id: ids.device,
      features: isLight ? lightFeatures(ids, name, info) : outletFeatures(ids, name, metered),
      params: baseParams(physical),
    },
  ];
}

/**
 * The states of a light or an outlet, from its info.
 * @param {object} info - `get_device_info` (or a strip socket's entry).
 * @returns {Record<string, number>} Values by feature suffix.
 * @example
 * statesFromInfo({ device_on: true, brightness: 40 });
 */
export function statesFromInfo(info) {
  /** @type {Record<string, number>} */
  const states = {};
  if (typeof info.device_on === 'boolean') {
    states[SMART_FEATURES.ON] = info.device_on ? 1 : 0;
  }
  if (Number.isFinite(info.brightness)) {
    states[SMART_FEATURES.BRIGHTNESS] = info.brightness;
  }
  // A bulb in white mode reports its last hue all the same: the color is only
  // meaningful when no color temperature is set.
  if (Number.isFinite(info.hue) && Number.isFinite(info.saturation) && !info.color_temp) {
    states[SMART_FEATURES.COLOR] = hsToRgbInt(info.hue, info.saturation);
  }
  if (Number.isFinite(info.color_temp) && info.color_temp > 0) {
    states[SMART_FEATURES.COLOR_TEMPERATURE] = info.color_temp;
  }
  return states;
}

/**
 * The states of a hub sensor, from the hub's child list.
 * @param {object} child - The sensor entry.
 * @returns {Record<string, number>} Values by feature suffix.
 * @example
 * statesFromSensor({ open: true, at_low_battery: false });
 */
export function statesFromSensor(child) {
  /** @type {Record<string, number>} */
  const states = {};
  if (Number.isFinite(child.current_temp)) {
    states[SMART_FEATURES.TEMPERATURE] = child.current_temp;
  }
  if (Number.isFinite(child.current_humidity)) {
    states[SMART_FEATURES.HUMIDITY] = child.current_humidity;
  }
  if (typeof child.detected === 'boolean') {
    states[SMART_FEATURES.MOTION] = child.detected ? 1 : 0;
  }
  if (typeof child.open === 'boolean') {
    // Gladys: 1 = closed, 0 = open (OPENING_SENSOR_STATE).
    states[SMART_FEATURES.CONTACT] = child.open ? 0 : 1;
  }
  if (typeof child.in_alarm === 'boolean' || child.water_leak_status !== undefined) {
    const wet =
      child.in_alarm === true ||
      (child.water_leak_status !== undefined && child.water_leak_status !== 'water_dry');
    states[SMART_FEATURES.LEAK] = wet ? 1 : 0;
  }
  if (Number.isFinite(child.target_temp)) {
    states[SMART_FEATURES.TARGET_TEMPERATURE] = child.target_temp;
  }
  if (Number.isFinite(child.battery_percentage)) {
    states[SMART_FEATURES.BATTERY] = child.battery_percentage;
  }
  if (typeof child.at_low_battery === 'boolean') {
    states[SMART_FEATURES.BATTERY_LOW] = child.at_low_battery ? 1 : 0;
  }
  return states;
}

/**
 * Map a button log entry to a Gladys click value.
 * @param {string} event - The `event` of a trigger log.
 * @returns {number|null} The click value, or null for an event Gladys has no
 * value for (the rotation of an S200D dial, say).
 * @example
 * buttonValueOf('doubleClick'); // 2
 */
export function buttonValueOf(event) {
  const name = String(event || '').toLowerCase();
  if (name === 'singleclick') {
    return BUTTON_VALUES.CLICK;
  }
  if (name === 'doubleclick') {
    return BUTTON_VALUES.DOUBLE_CLICK;
  }
  if (name.includes('long')) {
    return BUTTON_VALUES.LONG_CLICK;
  }
  return null;
}
