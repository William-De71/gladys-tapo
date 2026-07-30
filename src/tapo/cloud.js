// -----------------------------------------------------------------------------
// TP-Link cloud client.
//
// The cloud is used for what only it can do: list the cameras of the account and
// resolve their local IP. The images themselves never travel through it — they
// are captured on the local network (see rtsp.js and stream/).
//
// The API is a JSON-RPC-like endpoint: one POST per method, and an `error_code`
// in the body that stays 200 at the HTTP level. A non-zero `error_code` is
// therefore the only reliable failure signal.
// -----------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { logger } from '@gladysassistant/integration-sdk';
import { CLOUD_APP_TYPE, CAMERA_DEVICE_TYPE_PATTERNS } from './constants.js';

/** The cloud token expires; refresh it a little before the hour it lasts. */
const TOKEN_TTL_MS = 50 * 60 * 1000;

/** A cloud call that hangs must not hold the whole integration. */
const REQUEST_TIMEOUT_MS = 15 * 1000;

/**
 * Error codes the cloud returns for bad credentials. Anything else is treated as
 * a transient failure, worth retrying later.
 */
const INVALID_CREDENTIALS_CODES = [-20601, -20200];

/**
 * Decode a TP-Link cloud alias. The cloud stores camera names base64-encoded,
 * and the encoding of the decoded bytes varies: UTF-16LE (with or without BOM)
 * for names typed in the app, UTF-8 for others. Getting this wrong shows the
 * user a name full of replacement characters.
 * @param {string} alias - The base64 encoded alias.
 * @returns {string} The decoded name, or the raw alias when undecodable.
 * @example
 * decodeAlias('Q2FtZXJh'); // 'Camera'
 */
export function decodeAlias(alias) {
  if (!alias) {
    return '';
  }
  try {
    const bytes = Buffer.from(alias, 'base64');
    // UTF-16LE with a byte order mark.
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      return bytes.subarray(2).toString('utf16le').replace(/\0/g, '').trim();
    }
    // UTF-16LE without a BOM: ASCII characters produce one null byte each, so a
    // high proportion of null bytes gives the encoding away.
    if (bytes.length >= 4 && bytes.length % 2 === 0) {
      const nullCount = bytes.reduce((total, byte) => total + (byte === 0 ? 1 : 0), 0);
      if (nullCount >= bytes.length / 3) {
        return bytes.toString('utf16le').replace(/\0/g, '').trim();
      }
    }
    // UTF-8, unless it decodes to mostly replacement characters.
    const utf8 = bytes.toString('utf-8').trim();
    const badCount = (utf8.match(/�/g) || []).length;
    if (badCount > 0 && badCount >= utf8.length / 3) {
      return alias.trim();
    }
    return utf8;
  } catch {
    return alias;
  }
}

/**
 * Tell whether a cloud device is a camera. The account may also hold plugs and
 * bulbs, which this integration ignores.
 * @param {object} cloudDevice - The raw cloud device.
 * @returns {boolean} True when the device is a camera.
 * @example
 * isCamera({ deviceType: 'SMART.IPCAMERA' }); // true
 */
export function isCamera(cloudDevice) {
  const deviceType = String(cloudDevice.deviceType || '').toUpperCase();
  return CAMERA_DEVICE_TYPE_PATTERNS.some((pattern) => deviceType.includes(pattern));
}

/** Raised when the Tapo credentials are rejected, so the caller can say so. */
export class TapoAuthError extends Error {
  /**
   * @param {string} message - The reason of the rejection.
   * @example
   * throw new TapoAuthError('TAPO_LOGIN_FAILED');
   */
  constructor(message) {
    super(message);
    this.name = 'TapoAuthError';
  }
}

/**
 * Client of the TP-Link cloud API. It owns the token and renews it on demand, so
 * callers only ever deal with the camera list.
 * @example
 * const cloud = new TapoCloud();
 * const cameras = await cloud.getCameras(config);
 */
export class TapoCloud {
  /** Create a client with no session yet. */
  constructor() {
    /** @type {string|null} */
    this.token = null;
    this.tokenIssuedAt = 0;
    /**
     * The terminal UUID identifies this "app install" to the cloud. Keeping it
     * stable for the process lifetime avoids piling up sessions on the account.
     */
    this.terminalUUID = randomUUID();
  }

  /**
   * POST one method to the cloud and return its `result`.
   * @param {string} url - The cloud endpoint.
   * @param {object} body - The JSON body (`method` and optional `params`).
   * @returns {Promise<object>} The `result` field of the response.
   * @example
   * await cloud.request('https://eu-wap.tplinkcloud.com', { method: 'getDeviceList' });
   */
  async request(url, body) {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      // Network error or timeout: no `error_code` to inspect.
      throw new Error(`TAPO_CLOUD_UNREACHABLE:${e.message}`, { cause: e });
    }
    if (!response.ok) {
      throw new Error(`TAPO_CLOUD_HTTP_${response.status}`);
    }
    const data = await response.json();
    if (data.error_code !== 0) {
      if (INVALID_CREDENTIALS_CODES.includes(data.error_code)) {
        throw new TapoAuthError('TAPO_INVALID_CREDENTIALS');
      }
      throw new Error(`TAPO_CLOUD_ERROR_${data.error_code}`);
    }
    return data.result || {};
  }

  /**
   * Log in and remember the token. A still-valid token is reused, so callers can
   * call this freely.
   * @param {object} config - The normalized configuration.
   * @param {boolean} [force] - Log in again even if the token looks fresh.
   * @returns {Promise<string>} The cloud token.
   * @example
   * await cloud.login(config);
   */
  async login(config, force = false) {
    const fresh = this.token && Date.now() - this.tokenIssuedAt < TOKEN_TTL_MS;
    if (fresh && !force) {
      return this.token;
    }
    logger.debug(`Logging in to the TP-Link cloud on ${config.cloud_url}...`);
    const result = await this.request(config.cloud_url, {
      method: 'login',
      params: {
        appType: CLOUD_APP_TYPE,
        cloudUserName: config.email,
        cloudPassword: config.password,
        terminalUUID: this.terminalUUID,
      },
    });
    if (!result.token) {
      throw new TapoAuthError('TAPO_LOGIN_NO_TOKEN');
    }
    this.token = result.token;
    this.tokenIssuedAt = Date.now();
    logger.info('Connected to the TP-Link cloud');
    return this.token;
  }

  /**
   * Call an authenticated method, renewing the token once if the cloud rejects
   * it (a token can expire earlier than its nominal TTL).
   * @param {object} config - The normalized configuration.
   * @param {object} body - The JSON body.
   * @returns {Promise<object>} The `result` field of the response.
   * @example
   * await cloud.authenticatedRequest(config, { method: 'getDeviceList' });
   */
  async authenticatedRequest(config, body) {
    await this.login(config);
    try {
      return await this.request(`${config.cloud_url}?token=${this.token}`, body);
    } catch (e) {
      if (!(e instanceof TapoAuthError)) {
        throw e;
      }
      logger.debug('The cloud token was rejected, logging in again');
      this.token = null;
      await this.login(config, true);
      return this.request(`${config.cloud_url}?token=${this.token}`, body);
    }
  }

  /**
   * List the cameras of the account, with their decoded name and local IP when
   * the cloud reports one.
   * @param {object} config - The normalized configuration.
   * @returns {Promise<object[]>} The cameras, in a normalized shape.
   * @example
   * const cameras = await cloud.getCameras(config);
   */
  async getCameras(config) {
    const result = await this.authenticatedRequest(config, { method: 'getDeviceList' });
    if (!Array.isArray(result.deviceList)) {
      logger.warn('The TP-Link cloud returned no device list');
      return [];
    }
    const cameras = result.deviceList.filter(isCamera).map((cloudDevice) => {
      const name = decodeAlias(cloudDevice.alias) || cloudDevice.deviceName || 'Tapo Camera';
      return {
        cloudDeviceId: cloudDevice.deviceId,
        name,
        model: cloudDevice.deviceModel || '',
        // `ip` is only present on some firmwares; `parseCameraIps` fills the gap.
        ip: cloudDevice.ip || config.camera_ips[name.toLowerCase()] || '',
        // Reachability as the cloud sees it, useful to explain a failed capture.
        online: cloudDevice.status === 1 || cloudDevice.status === undefined,
      };
    });
    logger.info(`${cameras.length} Tapo camera(s) found in the cloud`);
    return cameras;
  }
}
