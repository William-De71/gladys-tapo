// -----------------------------------------------------------------------------
// The handlers of src/app.js, driven by the fake Gladys of the SDK: the real
// GladysIntegration with an in-memory Gladys, so the payloads are checked the
// way the core checks them. The TP-Link cloud is a fake client; no device
// answers, nothing touches a real network.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { createApp } from '../src/app.js';

/** A TP-Link cloud listing the given devices. */
class FakeCloud {
  constructor(devices = []) {
    this.devices = devices;
    this.token = null;
    this.calls = 0;
  }

  async getDevices() {
    this.calls += 1;
    return this.devices;
  }
}

const settle = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A connected fake Gladys running the integration.
 * @param {object} t - The test context: the app stops when the test ends.
 * @param {object} [options] - `config`, cloud `devices`.
 * @returns {Promise<object>} `{ gladys, cloud, app }`.
 */
async function start(t, { config = {}, devices = [] } = {}) {
  const gladys = createFakeGladys({ selector: 'ext-tapo', config });
  const cloud = new FakeCloud(devices);
  const app = createApp(gladys, { cloud });
  t.after(() => app.shutdown());
  await gladys.connect();
  await settle();
  return { gladys, cloud, app };
}

test('without a Tapo account, the integration asks for one in four languages', async (t) => {
  const { gladys, cloud } = await start(t);
  assert.equal(cloud.calls, 0, 'the cloud is not called without credentials');
  const status = gladys.fake.connectionStatus;
  assert.equal(status.connected, false);
  assert.deepEqual(Object.keys(status.message).sort(), ['de', 'en', 'es', 'fr']);
});

test('an account with no device says so, and publishes an empty discovery', async (t) => {
  const { gladys, cloud } = await start(t, {
    config: { email: 'user@example.com', password: 'secret' },
  });
  assert.equal(cloud.calls, 1);
  assert.deepEqual(gladys.fake.discoveredDevices, []);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /No device found/);
});

test('every configuration action of the manifest is wired', async (t) => {
  const { gladys } = await start(t);
  for (const key of [
    'test_connection',
    'set_device_address',
    'set_camera_account',
    'refresh_images',
  ]) {
    const ack = await gladys.fake.action(key, {});
    assert.doesNotMatch(String(ack.error), /not implemented/, key);
  }
});
