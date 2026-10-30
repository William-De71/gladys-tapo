// -----------------------------------------------------------------------------
// Client of one Tapo plug, bulb, switch or hub ("SMART" protocol).
//
// It owns the transport (TPAP, KLAP or the older securePassthrough, picked from
// what the device announced, or found by trying), and exposes the protocol's three
// shapes of call:
//   - one method                 `{ method, params }`;
//   - several methods at once    `multipleRequest`, sent in batches;
//   - a method of a sub-device   `control_child` (a socket of a power strip,
//                                a sensor paired to a hub).
//
// Like the camera client, it runs one request at a time (the KLAP sequence
// number must reach the device in order) and leaves a device alone for a while
// after a failure, so a device that is off costs one timeout per pause rather
// than one per round, and refused credentials are not retried in a burst.
// -----------------------------------------------------------------------------

import crypto from 'node:crypto';
import { logger } from '@gladysassistant/integration-sdk';
import { KlapTransport } from './klap.js';
import { AesTransport } from './aes.js';
import { TpapTransport } from './tpap.js';
import { LOCAL_API_BACKOFF_MS } from '../tapo/constants.js';

/** Methods per `multipleRequest`: firmwares refuse long batches. */
const BATCH_SIZE = 5;

/** Children per page of `get_child_device_list`. */
const CHILD_PAGE_GUARD = 20;

/**
 * Identifies this integration to the devices, like an app install does. Stable
 * for the life of the process.
 */
const TERMINAL_UUID = crypto.randomBytes(16).toString('base64');

/**
 * A failure the device reported with an error code.
 * @example
 * throw new SmartError('get_device_info', -1008);
 */
export class SmartError extends Error {
  /**
   * @param {string} method - The method that failed.
   * @param {number} code - The device's error code.
   */
  constructor(method, code) {
    super(`TAPO_SMART_METHOD_FAILED:${method}:${code}`);
    this.name = 'SmartError';
    this.method = method;
    this.code = code;
  }
}

/**
 * Tell whether an error says the device could not be reached at all.
 * @param {Error} error - The failure.
 * @returns {boolean} True for a timeout or a refused/unroutable connection.
 * @example
 * isUnreachable(new Error('TAPO_SMART_TIMEOUT'));
 */
function isUnreachable(error) {
  return /TIMEOUT|ECONN|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|CONNECTION_RESET/.test(
    `${error?.message || ''} ${error?.code || ''}`,
  );
}

/**
 * Client of one device.
 * @example
 * const client = new SmartClient({ ip: '192.168.1.30', username, password });
 * const info = await client.request('get_device_info');
 */
export class SmartClient {
  /**
   * @param {object} options - The connection.
   * @param {string} options.ip - The device address.
   * @param {string} options.username - The Tapo account email.
   * @param {string} options.password - The Tapo account password.
   * @param {string|null} [options.encryptType] - 'TPAP', 'KLAP' or 'AES', when known.
   * @param {number|null} [options.loginVersion] - From the discovery reply.
   * @param {number|null} [options.httpPort] - From the discovery reply.
   * @param {number} [options.timeoutMs] - Deadline of each HTTP exchange.
   */
  constructor({
    ip,
    username,
    password,
    encryptType = null,
    loginVersion = null,
    httpPort = null,
    timeoutMs = 5000,
  }) {
    this.ip = ip;
    this.options = {
      ip,
      port: httpPort || 80,
      username,
      password,
      loginVersion,
      timeoutMs,
    };
    this.encryptType = encryptType ? String(encryptType).toUpperCase() : null;
    /** @type {TpapTransport|KlapTransport|AesTransport|null} */
    this.transport = null;
    this.queue = Promise.resolve();
    this.blockedUntil = 0;
    this.blockedReason = '';
  }

  /**
   * Run a task after the ones already queued.
   * @param {() => Promise<unknown>} task - The task.
   * @returns {Promise<unknown>} Its result.
   * @example
   * await client.enqueue(() => client.send({}));
   */
  enqueue(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * The transport, built on first use.
   *
   * KLAP is tried first when nothing was announced: it is what most firmwares
   * speak, a device that does not answers its handshake with a 404 — the
   * signal to fall back to securePassthrough — and one in TPAP mode with a
   * 403, the signal to try TPAP.
   * @returns {TpapTransport|KlapTransport|AesTransport} The transport.
   * @example
   * client.getTransport();
   */
  getTransport() {
    if (!this.transport) {
      this.transport =
        this.encryptType === 'AES'
          ? new AesTransport(this.options)
          : this.encryptType === 'TPAP'
            ? new TpapTransport(this.options)
            : new KlapTransport(this.options);
    }
    return this.transport;
  }

  /**
   * Switch to another protocol and send the request through it.
   * @param {string} encryptType - 'TPAP', 'KLAP' or 'AES'.
   * @param {object} request - The JSON request.
   * @returns {Promise<object>} The answer.
   * @example
   * await client.switchTo('TPAP', { method: 'get_device_info' });
   */
  switchTo(encryptType, request) {
    logger.debug(`Tapo ${this.ip}: switching to ${encryptType}`);
    this.encryptType = encryptType;
    this.transport = null;
    return this.getTransport().send(request);
  }

  /**
   * Send one raw request through the transport, falling back to another
   * protocol once when the device turns this one down.
   * @param {object} request - The JSON request.
   * @returns {Promise<object>} The answer.
   * @example
   * await client.send({ method: 'get_device_info' });
   */
  async send(request) {
    const transport = this.getTransport();
    try {
      return await transport.send(request);
    } catch (e) {
      if (!this.encryptType && transport instanceof KlapTransport && e.status === 404) {
        return this.switchTo('AES', request);
      }
      if (transport instanceof KlapTransport && e.thirdPartyRefused) {
        // A device in TPAP mode, whatever it announced when last scanned (a
        // firmware update or the Third-Party Compatibility switch changes
        // it). One that does not announce TPAP either really refuses
        // third-party apps: the KLAP error says so.
        const announced = this.encryptType;
        try {
          return await this.switchTo('TPAP', request);
        } catch (tpapError) {
          if (tpapError.notTpap) {
            this.encryptType = announced;
            this.transport = transport;
            throw e;
          }
          throw tpapError;
        }
      }
      if (transport instanceof TpapTransport && e.notTpap) {
        // Announced TPAP when scanned, no longer in TPAP mode.
        return this.switchTo('KLAP', request);
      }
      if (e.retryable) {
        // A session the device dropped: one fresh handshake.
        transport.reset();
        return transport.send(request);
      }
      throw e;
    }
  }

  /**
   * Send a request, with the queue and the backoff around it.
   * @param {object} request - The JSON request.
   * @returns {Promise<object>} The answer.
   * @example
   * await client.call({ method: 'get_device_info' });
   */
  call(request) {
    return this.enqueue(async () => {
      if (Date.now() < this.blockedUntil) {
        throw new Error(`TAPO_SMART_BACKOFF:${this.blockedReason}`);
      }
      try {
        return await this.send({
          ...request,
          request_time_milis: Date.now(),
          terminal_uuid: TERMINAL_UUID,
        });
      } catch (e) {
        const pause = e.authFailed
          ? LOCAL_API_BACKOFF_MS.REFUSED
          : isUnreachable(e)
            ? LOCAL_API_BACKOFF_MS.UNREACHABLE
            : 0;
        if (pause > 0) {
          this.blockedUntil = Date.now() + pause;
          this.blockedReason = e.message;
          this.transport?.reset();
        }
        throw e;
      }
    });
  }

  /**
   * Call one method and return its result.
   * @param {string} method - The method.
   * @param {object} [params] - Its parameters.
   * @returns {Promise<object>} The `result`.
   * @example
   * await client.request('set_device_info', { device_on: true });
   */
  async request(method, params) {
    const answer = await this.call(params ? { method, params } : { method });
    if (answer.error_code !== 0) {
      throw new SmartError(method, answer.error_code);
    }
    return answer.result ?? {};
  }

  /**
   * Call several methods, in batches, and return their results by method.
   *
   * A method the device refuses (an unsupported one, typically) does not fail
   * the others: its entry holds a `SmartError`, for the caller to tell
   * "unsupported" from "unreachable".
   * @param {Array<{ method: string, params?: object }>} requests - The calls.
   * @returns {Promise<Record<string, object|SmartError>>} The results.
   * @example
   * await client.multiple([{ method: 'get_device_info' }, { method: 'get_energy_usage' }]);
   */
  async multiple(requests) {
    /** @type {Record<string, object|SmartError>} */
    const results = {};
    for (let index = 0; index < requests.length; index += BATCH_SIZE) {
      const batch = requests.slice(index, index + BATCH_SIZE);
      const answer = await this.call({ method: 'multipleRequest', params: { requests: batch } });
      if (answer.error_code !== 0) {
        throw new SmartError('multipleRequest', answer.error_code);
      }
      (answer.result?.responses || []).forEach((response) => {
        results[response.method] =
          response.error_code === 0
            ? (response.result ?? {})
            : new SmartError(response.method, response.error_code);
      });
    }
    return results;
  }

  /**
   * Call one method of a sub-device (a strip socket, a hub sensor).
   * @param {string} childId - The child's `device_id`.
   * @param {string} method - The method.
   * @param {object} [params] - Its parameters.
   * @returns {Promise<object>} The `result`.
   * @example
   * await client.childRequest(id, 'set_device_info', { device_on: false });
   */
  async childRequest(childId, method, params) {
    const result = await this.request('control_child', {
      device_id: childId,
      requestData: params ? { method, params } : { method },
    });
    const data = result?.responseData;
    if (data && data.error_code !== undefined && data.error_code !== 0) {
      throw new SmartError(method, data.error_code);
    }
    return data?.result ?? {};
  }

  /**
   * List every sub-device, following the pages the device splits them into.
   * @returns {Promise<object[]>} The children.
   * @example
   * await client.getChildren();
   */
  async getChildren() {
    const children = [];
    for (let page = 0; page < CHILD_PAGE_GUARD; page += 1) {
      const result = await this.request('get_child_device_list', { start_index: children.length });
      const list = Array.isArray(result.child_device_list) ? result.child_device_list : [];
      children.push(...list);
      const total = Number(result.sum);
      if (list.length === 0 || !Number.isFinite(total) || children.length >= total) {
        break;
      }
    }
    return children;
  }

  /**
   * Forget the session and the backoff; used when the account changed.
   * @example
   * client.reset();
   */
  reset() {
    this.transport?.reset();
    this.blockedUntil = 0;
  }
}
