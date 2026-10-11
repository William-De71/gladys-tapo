// -----------------------------------------------------------------------------
// Minimal HTTP client for the Tapo plugs, bulbs, switches and hubs (port 80).
//
// These devices speak plain HTTP — unlike the cameras, whose firmware mangles
// its answers enough to need a raw socket (see tapo/localApi.js). What they
// need is narrow: a POST with a binary or JSON body, the session cookie the
// handshake sets, and a hard deadline, since a device that is off must never
// hold a polling round.
// -----------------------------------------------------------------------------

import http from 'node:http';

/** Largest answer accepted; the real ones are a few kilobytes. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * Read the cookies a response sets, as `{ name: value }`.
 * @param {string[]|undefined} setCookie - The `set-cookie` header lines.
 * @returns {Record<string, string>} The cookies.
 * @example
 * parseCookies(['TP_SESSIONID=ABC;TIMEOUT=1440']);
 */
export function parseCookies(setCookie) {
  /** @type {Record<string, string>} */
  const cookies = {};
  (setCookie || []).forEach((line) => {
    // Some firmwares put several pairs on one line, separated by `;`, with no
    // attribute among them (`TP_SESSIONID=…;TIMEOUT=86400`): every pair counts.
    String(line)
      .split(';')
      .forEach((part) => {
        const index = part.indexOf('=');
        if (index <= 0) {
          return;
        }
        const name = part.slice(0, index).trim();
        if (/^(path|expires|domain|max-age|samesite)$/i.test(name)) {
          return;
        }
        cookies[name] = part.slice(index + 1).trim();
      });
  });
  return cookies;
}

/**
 * POST a body and collect the answer.
 * @param {object} options - The request.
 * @param {string} options.host - The device address.
 * @param {number} options.port - The port.
 * @param {string} options.path - The path, query included.
 * @param {Buffer|string} options.body - The body.
 * @param {Record<string, string>} [options.headers] - Extra headers.
 * @param {Record<string, string>} [options.cookies] - Cookies to send.
 * @param {number} options.timeoutMs - The overall deadline.
 * @returns {Promise<{ status: number, body: Buffer, cookies: Record<string, string> }>}
 * The answer.
 * @example
 * await post({ host: '192.168.1.30', port: 80, path: '/app', body: '{}', timeoutMs: 5000 });
 */
export function post({ host, port, path, body, headers = {}, cookies, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    const cookieHeader = cookies
      ? Object.entries(cookies)
          .map(([name, value]) => `${name}=${value}`)
          .join('; ')
      : '';
    let settled = false;
    const chunks = [];
    let size = 0;

    /**
     * Settle once.
     * @param {Error|null} error - The failure, or null.
     * @param {object} [value] - The answer.
     * @example
     * settle(null, answer);
     */
    const settle = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      if (error) {
        request.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };

    const deadline = setTimeout(() => settle(new Error('TAPO_SMART_TIMEOUT')), timeoutMs);

    const request = http.request(
      {
        host,
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Length': payload.length,
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          ...headers,
        },
      },
      (response) => {
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            settle(new Error('TAPO_SMART_RESPONSE_TOO_LARGE'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', (e) => settle(e));
        response.on('aborted', () => settle(new Error('TAPO_SMART_CONNECTION_RESET')));
        response.on('end', () =>
          settle(null, {
            status: response.statusCode,
            body: Buffer.concat(chunks),
            cookies: parseCookies(response.headers['set-cookie']),
          }),
        );
      },
    );
    request.on('error', (e) => settle(e));
    request.end(payload);
  });
}
