import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SmartManager } from '../src/smart/manager.js';
import { FAMILIES } from '../src/smart/model.js';
import { normalizeConfig } from '../src/config.js';
import { deviceState, startKlapDevice } from './helpers/fakeSmartDevice.js';
import { fakeGladys } from './helpers/fakeGladys.js';

const config = normalizeConfig({ email: 'me@example.com', password: 'S3cret!' });
const ACCOUNT = { username: config.email, password: config.password };

/**
 * A located physical device pointing at a fake device.
 * @param {object} device - The fake device (its port).
 * @param {object} overrides - Family, model…
 * @returns {object} The located entry.
 * @example
 * located(device, { family: 'plug' });
 */
function located(device, overrides) {
  return {
    cloudDeviceId: 'DEV1',
    name: 'Appareil',
    model: 'P110',
    ip: '127.0.0.1',
    ipSource: 'manual',
    httpPort: device.port,
    family: FAMILIES.PLUG,
    ...overrides,
  };
}

/**
 * Describe a device, then make the fake Gladys "hold" what was published.
 * @param {object} gladys - The fake SDK.
 * @param {SmartManager} manager - The manager.
 * @param {object} entry - The located device.
 * @returns {Promise<object[]>} The devices.
 * @example
 * await adopt(gladys, manager, entry);
 */
async function adopt(gladys, manager, entry) {
  const { devices } = await manager.describe([entry], [], config);
  gladys.getDevices = async () => devices;
  return devices;
}

test('a plug is described, polled, and only its changes are published', async () => {
  const state = deviceState({
    info: { device_on: false },
    energy: { current_power: 1500, today_energy: 200 },
  });
  const device = await startKlapDevice({ ...ACCOUNT, state });
  const gladys = fakeGladys();
  const manager = new SmartManager({ gladys });
  try {
    const [plug] = await adopt(gladys, manager, located(device, {}));
    assert.equal(plug.features.length, 3, 'on/off, power and energy');

    await manager.tick();
    const first = new Map(
      gladys.published.states.map((entry) => [
        entry.device_feature_external_id.split(':').pop(),
        entry.state,
      ]),
    );
    assert.equal(first.get('on'), 0);
    assert.equal(first.get('power'), 1.5, 'milliwatts reported in watts');
    assert.equal(first.get('energy'), 0, 'the index starts at the baseline');
    assert.deepEqual(
      gladys.published.transports.map((entry) => entry.transport),
      ['local'],
    );

    gladys.published.states.length = 0;
    await manager.tick();
    assert.equal(gladys.published.states.length, 0, 'nothing moved, nothing published');

    state.energy.today_energy = 450;
    await manager.tick();
    const energy = gladys.published.states.find((entry) =>
      entry.device_feature_external_id.endsWith(':energy'),
    );
    assert.equal(energy.state, 0.25, '250 Wh more on the index');
  } finally {
    await device.close();
  }
});

test('a command reaches the plug and is reported at once', async () => {
  const state = deviceState({ info: { device_on: false } });
  const device = await startKlapDevice({ ...ACCOUNT, state });
  const gladys = fakeGladys();
  const manager = new SmartManager({ gladys });
  try {
    const [plug] = await adopt(gladys, manager, located(device, {}));
    const on = plug.features.find((feature) => feature.external_id.endsWith(':on'));
    await manager.setValue(plug, on, 1);
    assert.equal(state.info.device_on, true);
    assert.deepEqual(gladys.published.states.at(-1), {
      device_feature_external_id: on.external_id,
      state: 1,
    });
  } finally {
    await device.close();
  }
});

test('a bulb takes a color and a white temperature', async () => {
  const state = deviceState({
    info: {
      device_on: true,
      brightness: 50,
      hue: 0,
      saturation: 100,
      color_temp: 0,
      color_temp_range: [2500, 6500],
    },
  });
  const device = await startKlapDevice({ ...ACCOUNT, state });
  const gladys = fakeGladys();
  const manager = new SmartManager({ gladys });
  try {
    const [bulb] = await adopt(
      gladys,
      manager,
      located(device, { family: FAMILIES.LIGHT, model: 'L530' }),
    );
    const feature = (suffix) =>
      bulb.features.find((entry) => entry.external_id.endsWith(`:${suffix}`));
    await manager.setValue(bulb, feature('color'), 0x0000ff);
    assert.equal(state.info.hue, 240);
    assert.equal(state.info.color_temp, 0);
    await manager.setValue(bulb, feature('color-temperature'), 4000);
    assert.equal(state.info.color_temp, 4000);
  } finally {
    await device.close();
  }
});

test('hub sensors share one read, and button presses are not replayed at start', async () => {
  const logs = [{ event: 'singleClick', id: 10, timestamp: 1 }];
  const state = deviceState({
    info: { model: 'H100' },
    children: [
      {
        device_id: 'DOOR',
        info: {
          model: 'T110',
          category: 'subg.trigger.contact-sensor',
          open: false,
          at_low_battery: false,
        },
      },
      {
        device_id: 'BTN',
        info: { model: 'S200B', category: 'subg.trigger.button', at_low_battery: false },
        logs,
      },
    ],
  });
  const device = await startKlapDevice({ ...ACCOUNT, state });
  const gladys = fakeGladys();
  const manager = new SmartManager({ gladys });
  try {
    const devices = await adopt(
      gladys,
      manager,
      located(device, { family: FAMILIES.HUB, model: 'H100' }),
    );
    assert.equal(devices.length, 2);

    await manager.tick();
    const presses = () =>
      gladys.published.states.filter((entry) =>
        entry.device_feature_external_id.endsWith(':button'),
      );
    assert.equal(presses().length, 0, 'the press made before the start is not replayed');
    const contact = gladys.published.states.find((entry) =>
      entry.device_feature_external_id.endsWith(':contact'),
    );
    assert.equal(contact.state, 1, 'closed');

    logs.unshift(
      { event: 'doubleClick', id: 11, timestamp: 2 },
      { event: 'singleClick', id: 12, timestamp: 3 },
    );
    state.children[0].entry.open = true;
    await manager.tick();
    assert.deepEqual(
      presses().map((entry) => entry.state),
      [2, 1],
      'new presses, in order',
    );
    assert.equal(
      gladys.published.states
        .filter((entry) => entry.device_feature_external_id.endsWith(':contact'))
        .at(-1).state,
      0,
      'opened',
    );
    assert.equal(
      state.calls.filter((method) => method === 'get_child_device_list').length,
      3,
      'one list per round (and one at describe)',
    );
  } finally {
    await device.close();
  }
});

test('a device that cannot be read keeps the devices Gladys already has', async () => {
  const gladys = fakeGladys();
  const manager = new SmartManager({ gladys });
  const previous = {
    name: 'Lave-linge',
    external_id: 'ext:ext-dev-tapo:plug:DEV1',
    features: [],
    params: [{ name: 'TAPO_CLOUD_DEVICE_ID', value: 'DEV1' }],
  };
  const { devices, problems } = await manager.describe(
    [
      {
        cloudDeviceId: 'DEV1',
        name: 'Lave-linge',
        model: 'P110',
        ip: '127.0.0.1',
        httpPort: 9,
        family: FAMILIES.PLUG,
      },
    ],
    [previous],
    config,
  );
  assert.deepEqual(devices, [previous], 'a scan never takes away what was already there');
  assert.equal(problems[0].reason, 'unreachable');
});

test('an unreachable device is flagged once, not on every round', async () => {
  const gladys = fakeGladys();
  const manager = new SmartManager({ gladys });
  manager.config = config;
  const plug = {
    name: 'Lave-linge',
    external_id: 'ext:ext-dev-tapo:plug:DEV1',
    features: [{ external_id: 'ext:ext-dev-tapo:plug:DEV1:on' }],
    params: [
      { name: 'TAPO_CLOUD_DEVICE_ID', value: 'DEV1' },
      { name: 'TAPO_IP', value: '127.0.0.1' },
      { name: 'TAPO_HTTP_PORT', value: '9' },
    ],
  };
  gladys.getDevices = async () => [plug];
  await manager.tick();
  await manager.tick();
  assert.deepEqual(gladys.published.transports, [
    { external_id: plug.external_id, transport: 'unreachable' },
  ]);
});

test('an H200 hub is reported as unsupported, not as a device that is off', async () => {
  const manager = new SmartManager({ gladys: fakeGladys() });
  const { devices, problems } = await manager.describe(
    [{ cloudDeviceId: 'HUB2', name: 'Hub', model: 'H200', ip: '127.0.0.1', family: FAMILIES.HUB }],
    [],
    config,
  );
  assert.deepEqual(devices, []);
  assert.equal(problems[0].reason, 'unsupported');
});
