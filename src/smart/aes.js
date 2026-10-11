// -----------------------------------------------------------------------------
// The older local protocol of the Tapo plugs, bulbs and hubs ("AES" in a
// discovery reply, "securePassthrough" on the wire), still served by many
// first-generation P100/P110/L510/H100 firmwares. HTTP, port 80:
//
//   1. handshake: POST /app with an RSA public key. The device answers a
//      session key and IV, encrypted with that key, and sets a session cookie;
//   2. login: a `login_device` request wrapped in `securePassthrough` (the JSON
//      encrypted with AES-128-CBC, base64) carrying the account email hashed
//      with SHA-1 and the password — in clear for login version 1, SHA-1 for
//      version 2 — both base64. The answer holds a token;
//   3. every later request: the same envelope, to /app?token=….
//
// Protocol as documented by the python-kasa project; independent implementation.
// -----------------------------------------------------------------------------

import crypto from 'node:crypto';
import { post } from './http.js';

/** Headers the firmware expects from the Tapo app. */
const APP_HEADERS = {
  'Content-Type': 'application/json',
  requestByApp: 'true',
  Accept: 'application/json',
};

/** Error codes meaning the login itself was refused. */
const LOGIN_REFUSED_CODES = [-1501, -1012];

/** The Tapo app's built-in account, which unbound devices answer to. */
const DEFAULT_CREDENTIALS = {
  username: Buffer.from('dGVzdEB0cC1saW5rLm5ldA==', 'base64').toString(),
  password: Buffer.from('dGVzdA==', 'base64').toString(),
};

/**
 * RSA key pair announced in the handshake. 1024 bits, as the firmware expects
 * (a larger key is refused); generated once per process.
 * @type {{ publicKey: string, privateKey: crypto.KeyObject }|null}
 */
let keyPair = null;

/**
 * The key pair, generated on first use.
 * @returns {{ publicKey: string, privateKey: crypto.KeyObject }} The pair.
 * @example
 * handshakeKeys();
 */
function handshakeKeys() {
  if (!keyPair) {
    const generated = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
    // The base64 on ONE line, not wrapped at 64 columns as a standard PEM
    // export would be: the firmware expects the exact body the Tapo app sends
    // (314 bytes for a 1024-bit key), and python-kasa builds it the same way.
    const der = generated.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    keyPair = {
      publicKey: `-----BEGIN PUBLIC KEY-----\n${der}\n-----END PUBLIC KEY-----\n`,
      privateKey: generated.privateKey,
    };
  }
  return keyPair;
}

/**
 * Decrypt the session key the device sent, RSA with PKCS#1 v1.5 padding.
 *
 * Some Node builds refuse PKCS#1 v1.5 for private decryption (a mitigation of
 * the Marvin timing attack, which cannot apply here: the integration decrypts
 * one key per handshake, offline of any oracle). The padding is then removed
 * by hand from a raw decryption.
 * @param {crypto.KeyObject} privateKey - Our private key.
 * @param {Buffer} encrypted - What the device sent.
 * @returns {Buffer} The 32 bytes: key, then IV.
 * @example
 * decryptSessionKey(key, buffer);
 */
export function decryptSessionKey(privateKey, encrypted) {
  try {
    return crypto.privateDecrypt(
      { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      encrypted,
    );
  } catch {
    const raw = crypto.privateDecrypt(
      { key: privateKey, padding: crypto.constants.RSA_NO_PADDING },
      encrypted,
    );
    // 0x00 0x02, random non-zero padding, 0x00, then the message.
    if (raw[0] !== 0x00 || raw[1] !== 0x02) {
      throw new Error('TAPO_AES_BAD_HANDSHAKE_KEY');
    }
    const separator = raw.indexOf(0x00, 2);
    if (separator < 10) {
      throw new Error('TAPO_AES_BAD_HANDSHAKE_KEY');
    }
    return raw.subarray(separator + 1);
  }
}

/**
 * Hash the credentials the way `login_device` expects them.
 * @param {number} loginVersion - 1 or 2.
 * @param {{ username: string, password: string }} credentials - The account.
 * @returns {object} The login params.
 * @example
 * loginParams(2, { username: 'me@example.com', password: 'secret' });
 */
export function loginParams(loginVersion, { username, password }) {
  const sha1Hex = (value) => crypto.createHash('sha1').update(value, 'utf8').digest('hex');
  const b64 = (value) => Buffer.from(value, 'utf8').toString('base64');
  return loginVersion === 2
    ? { username: b64(sha1Hex(username)), password2: b64(sha1Hex(password)) }
    : { username: b64(sha1Hex(username)), password: b64(password) };
}

/**
 * A securePassthrough connection to one device.
 * @example
 * const transport = new AesTransport({ ip, username, password, loginVersion: 2 });
 * await transport.send({ method: 'get_device_info' });
 */
export class AesTransport {
  /**
   * @param {object} options - The connection.
   * @param {string} options.ip - The device address.
   * @param {number} [options.port] - The HTTP port, 80 by default.
   * @param {string} options.username - The Tapo account email.
   * @param {string} options.password - The Tapo account password.
   * @param {number|null} [options.loginVersion] - 1 or 2; both are tried when unknown.
   * @param {number} [options.timeoutMs] - Deadline of each HTTP exchange.
   */
  constructor({ ip, port = 80, username, password, loginVersion = null, timeoutMs = 5000 }) {
    this.ip = ip;
    this.port = port;
    this.credentials = { username, password };
    this.loginVersion = loginVersion;
    this.timeoutMs = timeoutMs;
    this.key = null;
    this.iv = null;
    this.cookies = null;
    this.token = null;
  }

  /**
   * Encrypt a request for the envelope.
   * @param {object} request - The JSON request.
   * @returns {string} The base64 ciphertext.
   * @example
   * transport.encrypt({ method: 'get_device_info' });
   */
  encrypt(request) {
    const cipher = crypto.createCipheriv('aes-128-cbc', this.key, this.iv);
    return Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(request), 'utf8')),
      cipher.final(),
    ]).toString('base64');
  }

  /**
   * Decrypt an answer out of the envelope.
   * @param {string} response - The base64 ciphertext.
   * @returns {object} The JSON answer.
   * @example
   * transport.decrypt(text);
   */
  decrypt(response) {
    const decipher = crypto.createDecipheriv('aes-128-cbc', this.key, this.iv);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(response, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8'));
  }

  /**
   * POST a JSON body to the app endpoint.
   * @param {string} path - `/app`, with the token once logged in.
   * @param {object} body - The JSON body.
   * @returns {Promise<object>} The parsed JSON answer.
   * @example
   * await transport.postJson('/app', { method: 'handshake' });
   */
  async postJson(path, body) {
    const answer = await post({
      host: this.ip,
      port: this.port,
      path,
      body: JSON.stringify(body),
      headers: APP_HEADERS,
      cookies: this.cookies,
      timeoutMs: this.timeoutMs,
    });
    if (answer.status !== 200) {
      throw Object.assign(new Error(`TAPO_AES_HTTP_${answer.status}`), { status: answer.status });
    }
    return { json: JSON.parse(answer.body.toString('utf8')), cookies: answer.cookies };
  }

  /**
   * Exchange the session key.
   * @returns {Promise<void>} Resolves once the session key is known.
   * @example
   * await transport.handshake();
   */
  async handshake() {
    this.token = null;
    this.cookies = null;
    const keys = handshakeKeys();
    const { json, cookies } = await this.postJson('/app', {
      method: 'handshake',
      params: { key: keys.publicKey },
    });
    if (json.error_code !== 0 || !json.result?.key) {
      throw new Error(`TAPO_AES_HANDSHAKE_FAILED:${json.error_code}`);
    }
    const sessionCookie = cookies.TP_SESSIONID || cookies.SESSIONID;
    this.cookies = sessionCookie ? { TP_SESSIONID: sessionCookie } : null;
    const keyAndIv = decryptSessionKey(keys.privateKey, Buffer.from(json.result.key, 'base64'));
    this.key = keyAndIv.subarray(0, 16);
    this.iv = keyAndIv.subarray(16, 32);
  }

  /**
   * Send one request through the envelope, without logging in.
   * @param {object} request - The JSON request.
   * @returns {Promise<object>} The decrypted answer.
   * @example
   * await transport.passthrough({ method: 'get_device_info' });
   */
  async passthrough(request) {
    const path = this.token ? `/app?token=${this.token}` : '/app';
    const { json } = await this.postJson(path, {
      method: 'securePassthrough',
      params: { request: this.encrypt(request) },
    });
    if (json.error_code !== 0) {
      throw Object.assign(new Error(`TAPO_SMART_ERROR:${json.error_code}`), {
        code: json.error_code,
      });
    }
    const response = json.result?.response;
    if (typeof response !== 'string') {
      throw new Error('TAPO_AES_NO_RESPONSE');
    }
    try {
      return this.decrypt(response);
    } catch {
      // Some firmwares answer in clear inside the envelope.
      return JSON.parse(response);
    }
  }

  /**
   * Log in, with the account then the built-in one, in each login version
   * that is not ruled out.
   * @returns {Promise<void>} Resolves once a token was obtained.
   * @example
   * await transport.login();
   */
  async login() {
    const versions = this.loginVersion ? [this.loginVersion] : [2, 1];
    const attempts = versions.flatMap((version) => [
      { version, credentials: this.credentials },
      { version, credentials: DEFAULT_CREDENTIALS },
    ]);
    let lastError = null;
    for (const attempt of attempts) {
      await this.handshake();
      const answer = await this.passthrough({
        method: 'login_device',
        params: loginParams(attempt.version, attempt.credentials),
        request_time_milis: Date.now(),
      });
      if (answer.error_code === 0 && answer.result?.token) {
        this.token = answer.result.token;
        this.loginVersion = attempt.version;
        return;
      }
      lastError = answer.error_code;
      if (!LOGIN_REFUSED_CODES.includes(answer.error_code)) {
        break;
      }
    }
    throw Object.assign(new Error(`TAPO_SMART_BAD_CREDENTIALS:${lastError}`), {
      authFailed: LOGIN_REFUSED_CODES.includes(lastError),
    });
  }

  /**
   * Send one request, logging in first when needed.
   * @param {object} request - The JSON request.
   * @returns {Promise<object>} The answer (`{ error_code, result }`).
   * @example
   * await transport.send({ method: 'get_device_info' });
   */
  async send(request) {
    if (!this.token) {
      await this.login();
    }
    try {
      return await this.passthrough(request);
    } catch (e) {
      // 9999 is the device saying the session timed out.
      if (e.code === 9999 || e.code === -1012) {
        this.token = null;
        throw Object.assign(e, { retryable: true });
      }
      throw e;
    }
  }

  /**
   * Forget the session; the next request handshakes again.
   * @example
   * transport.reset();
   */
  reset() {
    this.token = null;
  }
}
