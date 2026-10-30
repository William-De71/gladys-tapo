// A Tapo plug/bulb/hub on localhost, speaking TPAP, KLAP or securePassthrough the way
// the firmware does, so the client is exercised over real HTTP rather than
// against mocks of its own functions. The protocol primitives come from the
// modules under test (cross-checked separately against an independent Python
// reference); what this fake adds is the DEVICE side of each exchange.

import http from 'node:http';
import crypto from 'node:crypto';
import { authHash, handshake1Proof, handshake2Proof, KlapSession } from '../../src/smart/klap.js';
import { loginParams } from '../../src/smart/aes.js';
import {
  GENERATOR,
  TpapCipher,
  credentialFor,
  decodePoint,
  deriveW0W1,
  encodePoint,
  hmac,
  keySchedule,
  masks,
  pointAdd,
  pointMultiply,
  pointNegate,
  randomScalar,
} from '../../src/smart/tpap.js';

/**
 * Read a request body.
 * @param {http.IncomingMessage} request - The request.
 * @returns {Promise<Buffer>} The body.
 * @example
 * await readBody(request);
 */
function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * Answer one SMART request the way a device does, `multipleRequest` and
 * `control_child` included.
 * @param {object} state - The device state and its handlers.
 * @param {object} request - The decrypted request.
 * @returns {object} The answer.
 * @example
 * dispatch(state, { method: 'get_device_info' });
 */
export function dispatch(state, request) {
  state.calls.push(request.method);
  if (request.method === 'multipleRequest') {
    return {
      error_code: 0,
      result: {
        responses: request.params.requests.map((inner) => ({
          method: inner.method,
          ...dispatch(state, inner),
        })),
      },
    };
  }
  if (request.method === 'control_child') {
    const child = state.children.find((entry) => entry.device_id === request.params.device_id);
    if (!child) {
      return { error_code: -1008 };
    }
    const inner = request.params.requestData;
    return { error_code: 0, result: { responseData: dispatch(child.state, inner) } };
  }
  const handler = state.methods[request.method];
  if (!handler) {
    return { error_code: -1 };
  }
  return { error_code: 0, result: handler(request.params || {}) };
}

/**
 * The state of a simulated device.
 * @param {object} [options] - What it is.
 * @param {object} [options.info] - Its `get_device_info`.
 * @param {object} [options.energy] - Its `get_energy_usage`, when it meters.
 * @param {object[]} [options.children] - Sub-devices: `{ device_id, info, logs }`.
 * @returns {object} The state, with a `calls` log.
 * @example
 * deviceState({ info: { device_on: false } });
 */
export function deviceState({ info = {}, energy = null, children = [] } = {}) {
  const state = {
    calls: [],
    info: { ...info },
    energy,
    children: children.map((child) => ({
      device_id: child.device_id,
      state: null,
      entry: { ...child.info, device_id: child.device_id },
      logs: child.logs || [],
    })),
  };
  state.children.forEach((child) => {
    child.state = {
      calls: state.calls,
      methods: {
        set_device_info: (params) => {
          Object.assign(child.entry, params);
          return {};
        },
        get_trigger_logs: () => ({ logs: child.logs, start_id: 0, sum: child.logs.length }),
        ...(child.entry.metered ? { get_energy_usage: () => child.entry.metered } : {}),
      },
    };
  });
  state.methods = {
    get_device_info: () => state.info,
    set_device_info: (params) => {
      Object.assign(state.info, params);
      return {};
    },
    ...(energy ? { get_energy_usage: () => state.energy } : {}),
    ...(children.length > 0
      ? {
          get_child_device_list: () => ({
            child_device_list: state.children.map((child) => child.entry),
            start_index: 0,
            sum: state.children.length,
          }),
        }
      : {}),
  };
  return state;
}

/**
 * Start a KLAP device.
 * @param {object} options - The device.
 * @param {string} options.username - The account it is bound to.
 * @param {string} options.password - Its password.
 * @param {1|2} [options.version] - The KLAP generation.
 * @param {object} options.state - From `deviceState`.
 * @param {boolean} [options.thirdPartyOff] - Answer handshake1 with a 403, like a
 * recent firmware with "Third-Party Compatibility" off.
 * @returns {Promise<{ port: number, close: Function, stats: object }>} Where it listens.
 * @example
 * const device = await startKlapDevice({ username, password, state });
 */
export function startKlapDevice({ username, password, version = 2, state, thirdPartyOff = false }) {
  const hash = authHash(version, username, password);
  let pending = null;
  let session = null;
  const stats = { handshakes: 0 };
  const server = http.createServer(async (request, response) => {
    const body = await readBody(request);
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/app/handshake1') {
      stats.handshakes += 1;
      if (thirdPartyOff) {
        response.writeHead(403);
        response.end();
        return;
      }
      const remoteSeed = crypto.randomBytes(16);
      pending = { localSeed: body, remoteSeed };
      response.writeHead(200, { 'Set-Cookie': 'TP_SESSIONID=FAKE;TIMEOUT=86400' });
      response.end(Buffer.concat([remoteSeed, handshake1Proof(version, body, remoteSeed, hash)]));
      return;
    }
    if (url.pathname === '/app/handshake2') {
      const expected = handshake2Proof(version, pending.localSeed, pending.remoteSeed, hash);
      if (!body.equals(expected) || !String(request.headers.cookie).includes('TP_SESSIONID=FAKE')) {
        response.writeHead(401);
        response.end();
        return;
      }
      session = new KlapSession(pending.localSeed, pending.remoteSeed, hash);
      response.writeHead(200);
      response.end();
      return;
    }
    if (url.pathname === '/app/request') {
      const seq = Number(url.searchParams.get('seq'));
      if (!session) {
        response.writeHead(403);
        response.end();
        return;
      }
      const plaintext = JSON.parse(session.decrypt(body, seq).toString('utf8'));
      const answer = Buffer.from(JSON.stringify(dispatch(state, plaintext)));
      const cipher = crypto.createCipheriv('aes-128-cbc', session.key, session.ivFor(seq));
      const ciphertext = Buffer.concat([cipher.update(answer), cipher.final()]);
      response.writeHead(200);
      response.end(Buffer.concat([Buffer.alloc(32), ciphertext]));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  return listen(server, stats, () => {
    session = null;
  });
}

/**
 * Start a securePassthrough (AES) device. It answers 404 to KLAP, like the
 * firmwares that predate it.
 * @param {object} options - The device.
 * @param {string} options.username - The account it is bound to.
 * @param {string} options.password - Its password.
 * @param {1|2} [options.loginVersion] - Which login it accepts.
 * @param {object} options.state - From `deviceState`.
 * @returns {Promise<{ port: number, close: Function, stats: object }>} Where it listens.
 * @example
 * const device = await startAesDevice({ username, password, state });
 */
export function startAesDevice({ username, password, loginVersion = 2, state }) {
  const expectedLogin = loginParams(loginVersion, { username, password });
  let key = null;
  let iv = null;
  const token = 'TOKEN123';
  const stats = { handshakes: 0, logins: 0 };
  const encrypt = (object) => {
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    return Buffer.concat([cipher.update(JSON.stringify(object)), cipher.final()]).toString(
      'base64',
    );
  };
  const server = http.createServer(async (request, response) => {
    const body = await readBody(request);
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== '/app') {
      response.writeHead(404);
      response.end();
      return;
    }
    const json = JSON.parse(body.toString('utf8'));
    if (json.method === 'handshake') {
      stats.handshakes += 1;
      const keyAndIv = crypto.randomBytes(32);
      key = keyAndIv.subarray(0, 16);
      iv = keyAndIv.subarray(16);
      const encrypted = crypto.publicEncrypt(
        { key: json.params.key, padding: crypto.constants.RSA_PKCS1_PADDING },
        keyAndIv,
      );
      response.writeHead(200, { 'Set-Cookie': 'TP_SESSIONID=AESFAKE;TIMEOUT=1440' });
      response.end(
        JSON.stringify({ error_code: 0, result: { key: encrypted.toString('base64') } }),
      );
      return;
    }
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    const inner = JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(json.params.request, 'base64')),
        decipher.final(),
      ]).toString('utf8'),
    );
    let answer;
    if (inner.method === 'login_device') {
      stats.logins += 1;
      const accepted = Object.entries(expectedLogin).every(
        ([name, value]) => inner.params[name] === value,
      );
      answer = accepted ? { error_code: 0, result: { token } } : { error_code: -1501 };
    } else if (url.searchParams.get('token') !== token) {
      answer = { error_code: 9999 };
    } else {
      answer = dispatch(state, inner);
    }
    response.writeHead(200);
    response.end(JSON.stringify({ error_code: 0, result: { response: encrypt(answer) } }));
  });
  return listen(server, stats, () => {});
}

/**
 * Start a device in TPAP mode: KLAP is turned down with a 403, like a firmware
 * 1.4 device, and the login is the verifier side of SPAKE2+.
 * @param {object} options - The device.
 * @param {string} options.password - The account password it holds.
 * @param {object} options.state - From `deviceState`.
 * @param {object} [options.tpap] - What `discover` announces.
 * @param {object|null} [options.extraCrypt] - How it stores the password.
 * @returns {Promise<{ port: number, close: Function, stats: object, dropSession: Function }>}
 * Where it listens.
 * @example
 * const device = await startTpapDevice({ password, state });
 */
export function startTpapDevice({
  password,
  state,
  tpap = { tls: 0, dac: 0, noc: 0, pake: [2] },
  extraCrypt = { type: 'password_shadow', params: { passwd_id: 2 } },
}) {
  const stats = { klap: 0, discovers: 0, registers: 0, shares: 0, requests: 0 };
  const salt = crypto.randomBytes(16);
  const iterations = 1000;
  let pending = null;
  const sessions = new Map();
  let port = 0;
  const json = (response, body) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const server = http.createServer(async (request, response) => {
    const body = await readBody(request);
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.startsWith('/app')) {
      stats.klap += 1;
      response.writeHead(403);
      response.end();
      return;
    }
    if (url.pathname === '/') {
      const params = JSON.parse(body.toString('utf8')).params || {};
      if (params.sub_method === 'discover') {
        stats.discovers += 1;
        json(response, {
          error_code: 0,
          result: { sub_method: 'discover', tpap_preferred: true, tpap: { ...tpap, port } },
        });
        return;
      }
      if (params.sub_method === 'pake_register') {
        stats.registers += 1;
        const { w0, w1 } = await deriveW0W1(credentialFor(password, extraCrypt), salt, iterations);
        const y = randomScalar();
        const share = pointAdd(pointMultiply(GENERATOR, y), pointMultiply(masks().n, w0));
        const deviceRandom = crypto.randomBytes(32);
        const userRandom = Buffer.from(params.user_random, 'base64');
        pending = {
          w0,
          y,
          l: pointMultiply(GENERATOR, w1),
          share: encodePoint(share),
          context: crypto
            .createHash('sha256')
            .update(Buffer.concat([Buffer.from('PAKE V1'), userRandom, deviceRandom]))
            .digest(),
        };
        json(response, {
          error_code: 0,
          result: {
            sub_method: 'pake_register',
            ...(extraCrypt ? { extra_crypt: extraCrypt } : {}),
            encryption: 'aes_128_ccm',
            cipher_suites: 1,
            iterations,
            dev_random: deviceRandom.toString('base64'),
            dev_salt: salt.toString('base64'),
            dev_share: pending.share.toString('base64'),
          },
        });
        return;
      }
      if (params.sub_method === 'pake_share') {
        stats.shares += 1;
        const login = pending;
        pending = null;
        const proverShare = Buffer.from(params.user_share, 'base64');
        const x = decodePoint(proverShare);
        const unmasked = pointAdd(x, pointNegate(pointMultiply(masks().m, login.w0)));
        const keys = keySchedule({
          context: login.context,
          proverIdentity: Buffer.alloc(0),
          verifierIdentity: Buffer.alloc(0),
          proverShare,
          verifierShare: login.share,
          z: pointMultiply(unmasked, login.y),
          v: pointMultiply(login.l, login.y),
          w0: login.w0,
        });
        if (
          !hmac(keys.proverConfirmKey, login.share).equals(
            Buffer.from(params.user_confirm, 'base64'),
          )
        ) {
          json(response, { error_code: -2203 });
          return;
        }
        const token = crypto.randomBytes(8).toString('hex');
        const startSeq = crypto.randomInt(-(2 ** 31), 2 ** 31 - 1);
        sessions.set(token, { cipher: new TpapCipher(keys.sharedKey, startSeq), next: startSeq });
        json(response, {
          error_code: 0,
          result: {
            dev_confirm: hmac(keys.verifierConfirmKey, proverShare).toString('base64'),
            stok: token,
            start_seq: startSeq,
            expired: 604800,
          },
        });
        return;
      }
    }
    const match = /^\/stok=([^/]+)\/ds$/.exec(url.pathname);
    const session = match && sessions.get(match[1]);
    if (!session) {
      // What a device answers for a session it no longer knows.
      json(response, { error_code: -2402 });
      return;
    }
    stats.requests += 1;
    const seq = body.readInt32BE(0);
    if (seq !== session.next) {
      json(response, { error_code: -1 });
      return;
    }
    session.next = (seq + 1) | 0;
    const plaintext = JSON.parse(session.cipher.decrypt(body, seq).toString('utf8'));
    const answer = Buffer.from(JSON.stringify(dispatch(state, plaintext)));
    // The device encrypts under the sequence number of the request.
    const replier = Object.assign(Object.create(TpapCipher.prototype), session.cipher, {
      seq,
    });
    response.writeHead(200);
    response.end(replier.encrypt(answer).body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve({
        port,
        stats,
        dropSession: () => sessions.clear(),
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/**
 * Listen on an ephemeral port.
 * @param {http.Server} server - The server.
 * @param {object} stats - Counters exposed to the test.
 * @param {Function} dropSession - Forgets the session, to simulate a reboot.
 * @returns {Promise<object>} `{ port, close, stats, dropSession }`.
 * @example
 * await listen(server, stats, () => {});
 */
function listen(server, stats, dropSession) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        stats,
        dropSession,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
