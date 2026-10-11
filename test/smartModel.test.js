import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  familyOf,
  decodeNickname,
  hsToRgbInt,
  rgbIntToHs,
  buildSmartDevices,
  statesFromInfo,
  statesFromSensor,
  buttonValueOf,
  FAMILIES,
} from '../src/smart/model.js';
import { accumulateEnergy, commandParams, isSmartDevice } from '../src/smart/manager.js';
import { fakeGladys } from './helpers/fakeGladys.js';

const gladys = fakeGladys();
const b64 = (text) => Buffer.from(text).toString('base64');

/**
 * The `category/type` list of a device's features.
 * @param {object} device - The device.
 * @returns {string[]} The pairs.
 * @example
 * kinds(device);
 */
const kinds = (device) => device.features.map((feature) => `${feature.category}/${feature.type}`);

test('device families follow the cloud type, cameras and doorbells included', () => {
  assert.equal(familyOf('SMART.TAPOPLUG'), FAMILIES.PLUG);
  assert.equal(familyOf('SMART.KASAPLUG'), FAMILIES.PLUG);
  assert.equal(familyOf('SMART.TAPOBULB'), FAMILIES.LIGHT);
  assert.equal(familyOf('SMART.TAPOSWITCH'), FAMILIES.SWITCH);
  assert.equal(familyOf('SMART.TAPOHUB'), FAMILIES.HUB);
  assert.equal(familyOf('SMART.IPCAMERA'), FAMILIES.CAMERA);
  assert.equal(familyOf('SMART.TAPODOORBELL'), FAMILIES.CAMERA);
  // The older Kasa protocol and the robot vacuums are not handled.
  assert.equal(familyOf('IOT.SMARTPLUGSWITCH'), null);
  assert.equal(familyOf('SMART.TAPOROBOVAC'), null);
});

test('a nickname is decoded from base64, accents included', () => {
  assert.equal(decodeNickname(b64('Lampe du séjour')), 'Lampe du séjour');
  assert.equal(decodeNickname(''), '');
});

test('colors survive the RGB <-> hue/saturation round trip', () => {
  assert.equal(hsToRgbInt(0, 100), 0xff0000);
  assert.equal(hsToRgbInt(120, 100), 0x00ff00);
  assert.deepEqual(rgbIntToHs(0x0000ff), { hue: 240, saturation: 100 });
  assert.deepEqual(rgbIntToHs(0xffffff), { hue: 0, saturation: 0 });
});

const plug = {
  cloudDeviceId: 'PLUG1',
  name: 'Lave-linge',
  model: 'P110',
  family: FAMILIES.PLUG,
  ip: '192.168.1.30',
  ipSource: 'scan',
  encryptType: 'AES',
  loginVersion: 2,
};

test('a metering plug gets on/off, power and an energy index', () => {
  const [device] = buildSmartDevices(gladys, plug, { info: { device_on: true }, metered: true });
  assert.deepEqual(kinds(device), ['switch/binary', 'switch/power', 'switch/energy']);
  assert.equal(device.features[0].read_only, false);
  assert.equal(device.features[2].unit, 'kilowatt-hour');
  assert.ok(device.external_id.includes(':plug:PLUG1'));
  assert.equal(isSmartDevice(device), true);
  const param = (name) => device.params.find((entry) => entry.name === name)?.value;
  assert.equal(param('TAPO_ENCRYPT_TYPE'), 'AES');
  assert.equal(param('TAPO_IP'), '192.168.1.30');
});

test('a plain plug only switches', () => {
  const [device] = buildSmartDevices(gladys, plug, { info: { device_on: true } });
  assert.deepEqual(kinds(device), ['switch/binary']);
});

test('a power strip becomes one device per socket', () => {
  const devices = buildSmartDevices(
    gladys,
    { ...plug, model: 'P300' },
    {
      info: {},
      children: [
        { device_id: 'S1', nickname: b64('Télé'), position: 1, device_on: true },
        { device_id: 'S2', nickname: '', position: 2, device_on: false },
      ],
    },
  );
  assert.deepEqual(
    devices.map((device) => device.name),
    ['Télé', 'Lave-linge 2'],
  );
  assert.equal(devices[0].params.find((entry) => entry.name === 'TAPO_CHILD_ID').value, 'S1');
});

test('a color bulb gets what its info shows, in kelvins for the white', () => {
  const [device] = buildSmartDevices(
    gladys,
    { ...plug, cloudDeviceId: 'BULB1', family: FAMILIES.LIGHT, model: 'L530' },
    {
      info: {
        device_on: true,
        brightness: 80,
        hue: 0,
        saturation: 100,
        color_temp: 2700,
        color_temp_range: [2500, 6500],
      },
    },
  );
  assert.deepEqual(kinds(device), [
    'light/binary',
    'light/brightness',
    'light/color',
    'light/temperature',
  ]);
  const temperature = device.features[3];
  assert.equal(temperature.min, 2500);
  assert.equal(temperature.max, 6500);
  assert.ok(device.external_id.includes(':light:BULB1'));
});

test('a light strip with a collapsed white range gets no temperature slider', () => {
  const [device] = buildSmartDevices(
    gladys,
    { ...plug, family: FAMILIES.LIGHT, model: 'L900' },
    {
      info: {
        device_on: true,
        brightness: 100,
        hue: 0,
        saturation: 100,
        color_temp_range: [9000, 9000],
      },
    },
  );
  assert.deepEqual(kinds(device), ['light/binary', 'light/brightness', 'light/color']);
});

test('a wall dimmer is a light, a wall switch a switch', () => {
  const [dimmer] = buildSmartDevices(
    gladys,
    { ...plug, family: FAMILIES.SWITCH, model: 'S500D' },
    {
      info: { device_on: false, brightness: 46 },
    },
  );
  assert.deepEqual(kinds(dimmer), ['light/binary', 'light/brightness']);
  const [wall] = buildSmartDevices(
    gladys,
    { ...plug, family: FAMILIES.SWITCH, model: 'S500' },
    {
      info: { device_on: false },
    },
  );
  assert.deepEqual(kinds(wall), ['switch/binary']);
  assert.ok(wall.external_id.includes(':switch:'));
});

test('the sensors of a hub become devices of their own', () => {
  const hub = { ...plug, cloudDeviceId: 'HUB1', family: FAMILIES.HUB, model: 'H100' };
  const devices = buildSmartDevices(gladys, hub, {
    children: [
      {
        device_id: 'T310',
        model: 'T310',
        category: 'subg.trigger.temp-hmdt-sensor',
        current_temp: 19.3,
        current_humidity: 54,
        temp_unit: 'celsius',
        at_low_battery: false,
        nickname: b64('Chambre'),
      },
      {
        device_id: 'T100',
        model: 'T100',
        category: 'subg.trigger.motion-sensor',
        detected: false,
        at_low_battery: false,
      },
      {
        device_id: 'T110',
        model: 'T110',
        category: 'subg.trigger.contact-sensor',
        open: false,
        at_low_battery: false,
      },
      {
        device_id: 'T300',
        model: 'T300',
        category: 'subg.trigger.water-leak-sensor',
        in_alarm: false,
        water_leak_status: 'water_dry',
        battery_percentage: 100,
        at_low_battery: false,
      },
      {
        device_id: 'S200B',
        model: 'S200B',
        category: 'subg.trigger.button',
        at_low_battery: false,
      },
      {
        device_id: 'KE100',
        model: 'KE100',
        category: 'subg.trv',
        current_temp: 19.2,
        target_temp: 21,
        min_control_temp: 5,
        max_control_temp: 30,
        temp_unit: 'celsius',
        battery_percentage: 100,
        at_low_battery: false,
      },
      { device_id: 'S210', model: 'S210', category: 'subg.plugswitch.switch' },
    ],
  });
  assert.deepEqual(
    devices.map((device) => [device.name, kinds(device)]),
    [
      ['Chambre', ['temperature-sensor/decimal', 'humidity-sensor/decimal', 'battery-low/binary']],
      ['T100', ['motion-sensor/binary', 'battery-low/binary']],
      ['T110', ['opening-sensor/binary', 'battery-low/binary']],
      ['T300', ['leak-sensor/binary', 'battery/integer', 'battery-low/binary']],
      ['S200B', ['button/click', 'battery-low/binary']],
      [
        'KE100',
        [
          'temperature-sensor/decimal',
          'thermostat/target-temperature',
          'battery/integer',
          'battery-low/binary',
        ],
      ],
    ],
    'an unsupported sensor (S210) is left out rather than published empty',
  );
  const trv = devices[5].features.find((feature) => feature.type === 'target-temperature');
  assert.equal(trv.read_only, false);
  assert.equal(trv.min, 5);
  assert.equal(trv.max, 30);
});

test('states are read from the info the way Gladys expects them', () => {
  assert.deepEqual(
    statesFromInfo({ device_on: true, brightness: 40, hue: 0, saturation: 100, color_temp: 0 }),
    {
      on: 1,
      brightness: 40,
      color: 0xff0000,
    },
  );
  // In white mode the hue is stale: only the temperature is meaningful.
  assert.deepEqual(
    statesFromInfo({ device_on: false, hue: 30, saturation: 50, color_temp: 2700 }),
    {
      on: 0,
      'color-temperature': 2700,
    },
  );
});

test('a contact reports 1 when closed, as Gladys defines it', () => {
  assert.equal(statesFromSensor({ open: false }).contact, 1);
  assert.equal(statesFromSensor({ open: true }).contact, 0);
  assert.equal(statesFromSensor({ water_leak_status: 'water_leak' }).leak, 1);
  assert.equal(statesFromSensor({ in_alarm: false, water_leak_status: 'water_dry' }).leak, 0);
  assert.equal(statesFromSensor({ detected: true }).motion, 1);
});

test('button events map onto the Gladys click values', () => {
  assert.equal(buttonValueOf('singleClick'), 1);
  assert.equal(buttonValueOf('doubleClick'), 2);
  assert.equal(buttonValueOf('longPress'), 6);
  assert.equal(buttonValueOf('rotation'), null);
});

test('commands become the set_device_info the firmware expects', () => {
  assert.deepEqual(commandParams('on', 1), { device_on: true });
  assert.deepEqual(commandParams('brightness', 0), { device_on: false });
  assert.deepEqual(commandParams('brightness', 140), { device_on: true, brightness: 100 });
  assert.deepEqual(commandParams('color', 0x00ff00), { hue: 120, saturation: 100, color_temp: 0 });
  assert.deepEqual(commandParams('color-temperature', 3000.4), { color_temp: 3000 });
  assert.deepEqual(commandParams('target-temperature', 21.5), {
    target_temp: 21.5,
    frost_protection_on: false,
  });
  assert.equal(commandParams('power', 12), null, 'a read-only feature is never written');
});

test('the energy index only grows, across midnight included', () => {
  let state = accumulateEnergy(undefined, 500, 12);
  assert.equal(state.index, 12, 'the first reading only sets the baseline');
  state = accumulateEnergy(state, 800, 12);
  assert.ok(Math.abs(state.index - 12.3) < 1e-9);
  // Midnight: the daily counter restarts from 0.
  state = accumulateEnergy(state, 100, 12);
  assert.ok(Math.abs(state.index - 12.4) < 1e-9);
});
