import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasSelectorBase, selectableName } from '../src/deviceName.js';
import { buildSmartDevices, FAMILIES } from '../src/smart/model.js';
import { buildDevice } from '../src/devices.js';
import { fakeGladys } from './helpers/fakeGladys.js';

const gladys = fakeGladys();
const b64 = (text) => Buffer.from(text).toString('base64');

test('a name keeps its selector base when the core slugify keeps anything of it', () => {
  assert.equal(hasSelectorBase('Salon'), true);
  assert.equal(hasSelectorBase('Entrée'), true);
  assert.equal(hasSelectorBase('Küche'), true);
  assert.equal(hasSelectorBase('Σαλόνι 2'), true);
  assert.equal(hasSelectorBase('Σαλόνι'), false);
  assert.equal(hasSelectorBase('Кухня'), false);
  assert.equal(hasSelectorBase('客厅'), false);
  assert.equal(hasSelectorBase('🚪'), false);
  assert.equal(hasSelectorBase('/ _ ·'), false);
  assert.equal(hasSelectorBase(''), false);
  assert.equal(hasSelectorBase(undefined), false);
});

test('a name the core cannot slugify gets the model as an ASCII tail (issue #8)', () => {
  assert.equal(selectableName('Salon', 'T310'), 'Salon');
  assert.equal(selectableName('Σαλόνι', 'T310'), 'Σαλόνι (T310)');
  assert.equal(selectableName('Σαλόνι', ''), 'Σαλόνι (Tapo)');
  assert.equal(selectableName('Σαλόνι', '客厅'), 'Σαλόνι (Tapo)');
  assert.equal(selectableName('  ', 'T310'), 'T310');
});

test('hub sensors, plugs and cameras named without Latin letters stay addable', () => {
  const hub = {
    cloudDeviceId: 'HUB1',
    family: FAMILIES.HUB,
    model: 'H110',
    ip: '10.0.0.2',
    protocol: 'klap',
  };
  const sensors = buildSmartDevices(gladys, hub, {
    children: [
      {
        device_id: 'A',
        model: 'T310',
        category: 'subg.trigger.temp-hmdt-sensor',
        nickname: b64('Σαλόνι'),
      },
      {
        device_id: 'B',
        model: 'T310',
        category: 'subg.trigger.temp-hmdt-sensor',
        nickname: b64('Κουζίνα'),
      },
    ],
  });
  assert.deepEqual(
    sensors.map((device) => device.name),
    ['Σαλόνι (T310)', 'Κουζίνα (T310)'],
  );
  // Feature names already carry an English suffix: left as they were.
  assert.equal(sensors[0].features[0].name, 'Σαλόνι - Temperature');

  const plug = {
    cloudDeviceId: 'P1',
    family: FAMILIES.PLUG,
    model: 'P110',
    name: 'Кухня',
    ip: '10.0.0.3',
  };
  assert.equal(buildSmartDevices(gladys, plug, { info: {} })[0].name, 'Кухня (P110)');

  const camera = { cloudDeviceId: 'C1', name: '🚪', model: 'C200', ip: '10.0.0.4' };
  assert.equal(buildDevice(gladys, camera).name, '🚪 (C200)');
});
