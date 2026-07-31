// -----------------------------------------------------------------------------
// Local HTTPS API of a Tapo camera (port 443).
//
// Why this exists: the cameras refuse the TP-Link cloud `passthrough` — every
// request answers `-20571` ("device offline") even while the camera is happily
// streaming on the LAN. Battery level and detection events are therefore only
// reachable locally, the way the Tapo app itself does it.
//
// The protocol is a port of pytapo's "secure" login (encrypt_type 3), which the
// recent firmwares mandate:
//
//   1. POST /            -> the camera answers -40401 with a nonce and a
//                           `device_confirm` proving it knows the password;
//   2. verify device_confirm, derive a digest, POST /  again -> a `stok` token;
//   3. every later request goes to /stok=<stok>/ds, AES-128-CBC encrypted inside
//      a `securePassthrough` envelope, signed with a per-request `Tapo_tag`.
//
// The camera serves a self-signed certificate, so TLS verification is disabled
// on purpose: identity is proven by the password digest, not by the cert.
// -----------------------------------------------------------------------------

import crypto from 'node:crypto';
import tls from 'node:tls';
import { logger } from '@gladysassistant/integration-sdk';
import { LOCAL_API_PORT, LOCAL_API_TIMEOUT_MS } from './constants.js';

/**
 * Uppercase hex digest, the representation the firmware compares against.
 * @param {string} algorithm - 'md5' or 'sha256'.
 * @param {string|Buffer} data - What to hash.
 * @returns {string} The uppercase hex digest.
 * @example
 * hashUpper('sha256', 'secret');
 */
function hashUpper(algorithm, data) {
  return crypto.createHash(algorithm).update(data, 'utf8').digest('hex').toUpperCase();
}

/**
 * Extract the JSON body out of what the camera sends back.
 *
 * The firmware is not a conformant HTTP server: before its actual response it
 * echoes the request back with the CRLFs mangled into NUL bytes, which makes
 * Node's parser bail out with "Expected HTTP/, RTSP/ or ICE/" — even the lenient
 * one. The body is also chunk-encoded, with the chunk sizes interleaved.
 *
 * Rather than fight that, the JSON is taken directly: the answer is a single
 * object, so the span between the first `{` and the last `}` is it. Chunk size
 * markers sit outside that span or between the chunks; `JSON.parse` rejects the
 * result if anything was actually corrupted, so a wrong guess never passes
 * silently.
 * @param {Buffer} raw - Everything the camera sent.
 * @returns {object} The parsed answer.
 * @example
 * parseCameraResponse(buffer);
 */
export function parseCameraResponse(raw) {
  const text = raw.toString('utf8');

  // The echoed request carries its OWN JSON body, so the first `{` in the buffer
  // belongs to the echo, not to the answer. The real response begins at the LAST
  // HTTP status line; anything before it is the firmware talking to itself.
  const statusIndex = text.lastIndexOf('HTTP/1.');
  const searchFrom = statusIndex === -1 ? 0 : statusIndex;

  const start = text.indexOf('{', searchFrom);
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error(`TAPO_LOCAL_BAD_JSON:${text.slice(searchFrom, searchFrom + 120)}`);
  }

  const candidate = text.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    // Chunked transfer splices size markers between the chunks; dropping the
    // lines that are only a hex length puts the JSON back together.
    const rejoined = candidate
      .split(/\r\n/)
      .filter((line) => !/^[0-9a-fA-F]+$/.test(line.trim()))
      .join('');
    try {
      return JSON.parse(rejoined);
    } catch {
      throw new Error(`TAPO_LOCAL_BAD_JSON:${candidate.slice(0, 120)}`);
    }
  }
}

/**
 * POST a JSON body to the camera and return the parsed answer.
 *
 * A raw TLS socket is used rather than `https.request`: the firmware's malformed
 * preamble (see `parseCameraResponse`) makes Node's HTTP parser reject the whole
 * exchange, and the response has to be read as bytes.
 * @param {string} ip - The camera address.
 * @param {string} path - The path, '/' or '/stok=.../ds'.
 * @param {object|string} body - The JSON body, or an already-serialized string
 * when the exact bytes matter (the secure envelope is signed, so it must be sent
 * byte-for-byte as it was hashed).
 * @param {object} [headers] - Extra headers (the secure envelope needs some).
 * @returns {Promise<object>} The parsed JSON answer.
 * @example
 * await post('192.168.1.20', '/', { method: 'login', params: {} });
 */
function post(ip, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    let raw = Buffer.alloc(0);
    let settled = false;

    /**
     * Settle once, and always release the socket.
     * @param {Error|null} error - The failure, or null on success.
     * @param {object} [value] - The parsed answer.
     * @example
     * settle(null, answer);
     */
    const settle = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };

    // The camera serves a self-signed certificate; the password digest is what
    // authenticates the peer here, not the certificate chain.
    const socket = tls.connect(
      { host: ip, port: LOCAL_API_PORT, rejectUnauthorized: false },
      () => {
        // These headers are not decoration: the firmware answers `200 OK` with
        // an EMPTY body unless the request looks like it comes from the Tapo
        // app — `requestByApp` and the app User-Agent in particular. Measured on
        // a C610: without them the camera echoes the request back and returns
        // nothing at all.
        const head =
          `POST ${path} HTTP/1.1\r\n` +
          `Host: ${ip}\r\n` +
          `Referer: https://${ip}\r\n` +
          `Accept: application/json\r\n` +
          `User-Agent: Tapo CameraClient Android\r\n` +
          `requestByApp: true\r\n` +
          `Content-Type: application/json; charset=UTF-8\r\n` +
          `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
          Object.entries(headers)
            .map(([key, value]) => `${key}: ${value}\r\n`)
            .join('') +
          // Closing tells the firmware to flush and hang up, so the response is
          // complete by the time the socket ends.
          `Connection: close\r\n\r\n`;
        socket.write(head + payload);
      },
    );

    const timer = setTimeout(() => settle(new Error('TAPO_LOCAL_TIMEOUT')), LOCAL_API_TIMEOUT_MS);

    socket.on('data', (chunk) => {
      raw = Buffer.concat([raw, chunk]);
    });
    socket.on('end', () => {
      try {
        settle(null, parseCameraResponse(raw));
      } catch (e) {
        settle(e);
      }
    });
    socket.on('error', (e) => settle(e));
  });
}

/**
 * Client of the local API of ONE camera. It owns the session (token, AES keys,
 * sequence number) and re-authenticates on its own when the camera drops it.
 * @example
 * const api = new TapoLocalApi('192.168.1.20', 'cloud-password');
 * const battery = await api.getBatteryLevel();
 */
export class TapoLocalApi {
  /**
   * @param {string} ip - The camera address.
   * @param {string} password - The password the camera authenticates against
   * (the TP-Link cloud one for a camera with no camera account).
   * @param {string} [username] - The login user, 'admin' by default.
   */
  constructor(ip, password, username = 'admin') {
    this.ip = ip;
    this.password = password;
    this.username = username;

    /** @type {string|null} */
    this.stok = null;
    /** @type {Buffer|null} */
    this.lsk = null;
    /** @type {Buffer|null} */
    this.ivb = null;
    this.seq = 0;
    /** In-flight login, so concurrent callers share one session. */
    this.loginPromise = null;
    /** The hashing the camera proved it uses, discovered during the login. */
    this.hashMethod = 'sha256';
  }

  /**
   * The password, hashed the way the camera expects.
   * @returns {string} The uppercase hex digest.
   * @example
   * api.hashedPassword();
   */
  hashedPassword() {
    return hashUpper(this.hashMethod, this.password);
  }

  /**
   * Derive one of the two AES tokens from the nonces.
   * @param {string} type - 'lsk' (key) or 'ivb' (iv).
   * @param {string} nonce - The nonce the camera sent.
   * @returns {Buffer} The 16-byte token.
   * @example
   * api.encryptionToken('lsk', nonce);
   */
  encryptionToken(type, nonce) {
    const hashedKey = hashUpper('sha256', this.cnonce + this.hashedPassword() + nonce);
    return crypto
      .createHash('sha256')
      .update(type + this.cnonce + nonce + hashedKey, 'utf8')
      .digest()
      .subarray(0, 16);
  }

  /**
   * Log in and open a session.
   *
   * The first request is EXPECTED to fail with `-40401`: that answer carries the
   * nonce and the `device_confirm` the second request is built on.
   * @returns {Promise<void>} Resolves once the session is usable.
   * @example
   * await api.login();
   */
  async login() {
    this.cnonce = crypto.randomBytes(8).toString('hex').toUpperCase();

    const first = await post(this.ip, '/', {
      method: 'login',
      params: { cnonce: this.cnonce, encrypt_type: '3', username: this.username },
    });

    const data = first?.result?.data || {};
    const { nonce, device_confirm: deviceConfirm } = data;
    if (!nonce || !deviceConfirm) {
      throw new Error(`TAPO_LOCAL_NO_NONCE:${first?.error_code ?? '?'}`);
    }

    // `device_confirm` proves the camera knows the password AND tells which
    // hashing it uses: recompute it both ways and keep the one that matches.
    const candidates = ['sha256', 'md5'];
    const matched = candidates.find((algorithm) => {
      const hashed = hashUpper(algorithm, this.password);
      const expected = hashUpper('sha256', this.cnonce + hashed + nonce);
      return deviceConfirm === expected + nonce + this.cnonce;
    });
    if (!matched) {
      // The camera answered, but not with a digest derived from this password.
      throw new Error('TAPO_LOCAL_BAD_PASSWORD');
    }
    this.hashMethod = matched;

    const digest = hashUpper('sha256', this.hashedPassword() + this.cnonce + nonce);
    const second = await post(this.ip, '/', {
      method: 'login',
      params: {
        cnonce: this.cnonce,
        encrypt_type: '3',
        digest_passwd: digest + this.cnonce + nonce,
        username: this.username,
      },
    });

    const stok = second?.result?.stok;
    if (!stok) {
      throw new Error(`TAPO_LOCAL_LOGIN_FAILED:${second?.error_code ?? '?'}`);
    }

    this.stok = stok;
    this.lsk = this.encryptionToken('lsk', nonce);
    this.ivb = this.encryptionToken('ivb', nonce);
    this.seq = Number(second?.result?.start_seq ?? 0);
    logger.debug(`Tapo local API: session opened on ${this.ip} (${this.hashMethod})`);
  }

  /**
   * Send one authenticated request through the encrypted envelope.
   * @param {object} body - The request (`{ method, params }`).
   * @returns {Promise<object>} The decrypted answer.
   * @example
   * await api.secureRequest({ method: 'get', params: { battery: {} } });
   */
  async secureRequest(body) {
    if (!this.stok) {
      // Serialised on purpose: two concurrent calls would each open a session,
      // and the camera only accepts a few before answering -40413.
      if (!this.loginPromise) {
        this.loginPromise = this.login().finally(() => {
          this.loginPromise = null;
        });
      }
      await this.loginPromise;
    }

    const plaintext = JSON.stringify(body);
    const cipher = crypto.createCipheriv('aes-128-cbc', this.lsk, this.ivb);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString(
      'base64',
    );

    // The tag binds the request to the session AND to its sequence number, so a
    // replayed or reordered request is rejected by the camera.
    //
    // It is computed over the SERIALIZED OUTER envelope — not the ciphertext
    // alone — and the body sent must be byte-for-byte the string that was
    // hashed, or the camera answers -40401.
    this.seq += 1;
    const envelope = { method: 'securePassthrough', params: { request: encrypted } };
    const serialized = JSON.stringify(envelope);
    const tag = hashUpper(
      'sha256',
      hashUpper('sha256', this.hashedPassword() + this.cnonce) + serialized + String(this.seq),
    );

    const answer = await post(this.ip, `/stok=${this.stok}/ds`, serialized, {
      Seq: String(this.seq),
      Tapo_tag: tag,
    });

    const response = answer?.result?.response;
    if (typeof response !== 'string') {
      // A dropped session shows up as a missing response: log in again once.
      throw new Error(`TAPO_LOCAL_NO_RESPONSE:${answer?.error_code ?? '?'}`);
    }

    const decipher = crypto.createDecipheriv('aes-128-cbc', this.lsk, this.ivb);
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(response, 'base64')),
      decipher.final(),
    ]).toString('utf8');

    return JSON.parse(decrypted);
  }

  /**
   * Send a request, renewing the session once if the camera dropped it.
   * @param {object} body - The request.
   * @returns {Promise<object>} The answer.
   * @example
   * await api.request({ method: 'get', params: {} });
   */
  async request(body) {
    try {
      return await this.secureRequest(body);
    } catch (e) {
      if (e.message === 'TAPO_LOCAL_BAD_PASSWORD') {
        throw e;
      }
      logger.debug(`Tapo local API: session lost on ${this.ip}, logging in again`);
      this.stok = null;
      return this.secureRequest(body);
    }
  }

  /**
   * Read the battery level.
   *
   * The field name varies across firmwares, so several shapes are accepted
   * rather than assuming one — an unknown shape returns null instead of a wrong
   * percentage.
   * @returns {Promise<number|null>} The percentage, or null when unavailable.
   * @example
   * const level = await api.getBatteryLevel();
   */
  /**
   * Call one camera method through the only envelope the firmware accepts.
   * @param {string} method - The method name.
   * @param {object} params - Its parameters.
   * @returns {Promise<object>} The `result` of that method.
   * @example
   * await api.callMethod('getBatteryStatus', { battery: { name: 'status' } });
   */
  async callMethod(method, params) {
    // The firmware only answers `multipleRequest`: a bare method comes back
    // `-40210` (unsupported), and — worse — some come back `200 OK` with an
    // EMPTY body, which looks like a transport bug rather than a rejection.
    // Measured on a C610: only this wrapper ever returns data.
    const answer = await this.request({
      method: 'multipleRequest',
      params: { requests: [{ method, params }] },
    });
    const responses = answer?.result?.responses || answer?.responses;
    const first = Array.isArray(responses) ? responses[0] : null;
    if (first && first.error_code !== undefined && first.error_code !== 0) {
      throw new Error(`TAPO_LOCAL_METHOD_FAILED:${method}:${first.error_code}`);
    }
    return first?.result ?? {};
  }

  /**
   * Read the battery level.
   *
   * The field name varies across firmwares, so several shapes are accepted
   * rather than assuming one — an unknown shape returns null instead of a wrong
   * percentage.
   * @returns {Promise<number|null>} The percentage, or null when unavailable.
   * @example
   * const level = await api.getBatteryLevel();
   */
  async getBatteryLevel() {
    const result = await this.callMethod('getBatteryStatus', { battery: { name: 'status' } });
    const status = result?.battery?.status ?? result?.battery ?? result;
    const level = status?.battery_percent ?? status?.percent ?? status?.battery_level;
    return Number.isFinite(Number(level)) ? Number(level) : null;
  }

  /**
   * List the detections recorded over a time window.
   * @param {number} startTime - Window start, in seconds since the epoch.
   * @param {number} endTime - Window end, in seconds since the epoch.
   * @returns {Promise<object[]>} The detections, newest last.
   * @example
   * await api.getDetections(start, end);
   */
  async getDetections(startTime, endTime) {
    const result = await this.callMethod('searchDetectionList', {
      playback: {
        search_detection_list: {
          start_index: 0,
          channel: 0,
          start_time: startTime,
          end_time: endTime,
          end_index: 999,
        },
      },
    });
    const list = result?.playback?.search_detection_list;
    return Array.isArray(list) ? list : [];
  }

  /**
   * Close the session so the camera frees it.
   * @example
   * api.close();
   */
  async close() {
    // Dropping the token locally is NOT enough: the camera keeps the session
    // open on its side and only accepts a handful at a time. Opening a new one
    // per poll without logging out exhausts them, and every later login is
    // rejected with -40413 until they expire on their own.
    if (this.stok) {
      await this.secureRequest({ method: 'logout', params: {} }).catch(() => {});
    }
    this.stok = null;
    this.lsk = null;
    this.ivb = null;
    this.seq = 0;
  }
}
