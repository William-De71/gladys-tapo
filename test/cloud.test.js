import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TapoCloud, TapoAuthError, decodeAlias, isCamera } from '../src/tapo/cloud.js';
import { normalizeConfig } from '../src/config.js';

/**
 * Replace global fetch with a stub for the duration of one test.
 * @param {Function} handler - Receives (url, options) and returns the JSON body.
 * @returns {object} The call log and a `restore` function.
 * @example
 * const fetchStub = stubFetch(() => ({ error_code: 0, result: {} }));
 */
function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    const body = await handler(url, options, calls.length);
    return { ok: true, status: 200, json: async () => body };
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const config = normalizeConfig({ email: 'me@example.com', password: 'secret' });

test('a UTF-16LE alias with a BOM is decoded', () => {
  // The Tapo app stores names as UTF-16LE; decoding as UTF-8 shows garbage.
  const encoded = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from('Sonnette', 'utf16le'),
  ]).toString('base64');
  assert.equal(decodeAlias(encoded), 'Sonnette');
});

test('a UTF-16LE alias without a BOM is still detected', () => {
  assert.equal(decodeAlias(Buffer.from('Jardin', 'utf16le').toString('base64')), 'Jardin');
});

test('a plain UTF-8 alias is decoded, accents included', () => {
  assert.equal(decodeAlias(Buffer.from('Caméra café', 'utf-8').toString('base64')), 'Caméra café');
});

test('an empty alias yields an empty string', () => {
  assert.equal(decodeAlias(''), '');
});

test('only cameras are kept out of the device list', () => {
  // A Tapo account also holds plugs and bulbs this integration ignores.
  assert.equal(isCamera({ deviceType: 'SMART.IPCAMERA' }), true);
  assert.equal(isCamera({ deviceType: 'SMART.TAPOPLUG' }), false);
  assert.equal(isCamera({}), false);
});

test('a successful login stores the token and reuses it', async () => {
  const fetchStub = stubFetch(() => ({ error_code: 0, result: { token: 'tok-1' } }));
  try {
    const cloud = new TapoCloud();
    assert.equal(await cloud.login(config), 'tok-1');
    // A second call must not re-login: the cloud piles up sessions otherwise.
    assert.equal(await cloud.login(config), 'tok-1');
    assert.equal(fetchStub.calls.length, 1);
    assert.equal(fetchStub.calls[0].body.params.cloudUserName, 'me@example.com');
  } finally {
    fetchStub.restore();
  }
});

test('bad credentials raise a typed error, not a generic one', async () => {
  // The caller shows a "check your password" message only for this case.
  const fetchStub = stubFetch(() => ({ error_code: -20601 }));
  try {
    await assert.rejects(() => new TapoCloud().login(config), TapoAuthError);
  } finally {
    fetchStub.restore();
  }
});

test('an unknown cloud error keeps its code', async () => {
  const fetchStub = stubFetch(() => ({ error_code: -42 }));
  try {
    await assert.rejects(() => new TapoCloud().login(config), /TAPO_CLOUD_ERROR_-42/);
  } finally {
    fetchStub.restore();
  }
});

test('an expired token triggers exactly one re-login', async () => {
  // Tokens can die before their nominal TTL; retrying once beats failing.
  const fetchStub = stubFetch((url, options, callNumber) => {
    const { method } = JSON.parse(options.body);
    if (method === 'login') {
      return { error_code: 0, result: { token: `tok-${callNumber}` } };
    }
    // The first authenticated call is rejected, the one after the re-login works.
    return callNumber === 2
      ? { error_code: -20601 }
      : { error_code: 0, result: { deviceList: [] } };
  });
  try {
    const cloud = new TapoCloud();
    await cloud.getCameras(config);
    const methods = fetchStub.calls.map((call) => call.body.method);
    assert.deepEqual(methods, ['login', 'getDeviceList', 'login', 'getDeviceList']);
  } finally {
    fetchStub.restore();
  }
});

test('the camera list is normalized, non-cameras dropped', async () => {
  const fetchStub = stubFetch((url, options) => {
    if (JSON.parse(options.body).method === 'login') {
      return { error_code: 0, result: { token: 'tok' } };
    }
    return {
      error_code: 0,
      result: {
        deviceList: [
          {
            deviceId: 'ID1',
            deviceType: 'SMART.IPCAMERA',
            deviceModel: 'C210',
            alias: Buffer.from('Jardin', 'utf-8').toString('base64'),
            ip: '192.168.1.20',
            status: 1,
          },
          { deviceId: 'ID2', deviceType: 'SMART.TAPOPLUG', alias: 'UGx1Zw==' },
        ],
      },
    };
  });
  try {
    const cameras = await new TapoCloud().getCameras(config);
    assert.equal(cameras.length, 1);
    assert.deepEqual(cameras[0], {
      cloudDeviceId: 'ID1',
      name: 'Jardin',
      model: 'C210',
      ip: '192.168.1.20',
      online: true,
    });
  } finally {
    fetchStub.restore();
  }
});

test('a camera without a cloud IP falls back to the manual address', async () => {
  // Some firmwares never report the IP; the config field is the only source then.
  const withIps = normalizeConfig({
    email: 'a@b.c',
    password: 'x',
    camera_ips: 'Sonnette|192.168.1.42',
  });
  const fetchStub = stubFetch((url, options) => {
    if (JSON.parse(options.body).method === 'login') {
      return { error_code: 0, result: { token: 'tok' } };
    }
    return {
      error_code: 0,
      result: {
        deviceList: [
          {
            deviceId: 'ID1',
            deviceType: 'SMART.IPCAMERA',
            alias: Buffer.from('Sonnette', 'utf-8').toString('base64'),
          },
        ],
      },
    };
  });
  try {
    const cameras = await new TapoCloud().getCameras(withIps);
    assert.equal(cameras[0].ip, '192.168.1.42');
  } finally {
    fetchStub.restore();
  }
});
