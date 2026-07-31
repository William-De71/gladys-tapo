// -----------------------------------------------------------------------------
// Media session over the proprietary Tapo protocol (TCP port 8800).
//
// A Node.js port of pytapo's `media_stream/session.py`, reduced to what a
// snapshot needs. Used for the cameras that expose no RTSP stream (typically the
// battery doorbells): it is the only way to get an image out of them locally.
//
// The protocol looks like HTTP but is not: an HTTP-like handshake over a raw
// socket, then an endless multipart body whose parts carry AES-encrypted
// MPEG-TS. The session is therefore a small state machine over the byte stream:
//
//   auth ---------> digest challenge, answered with an Authorization header
//   keyexchange --> Key-Exchange header, from which the AES key is derived
//   streaming ----> multipart parts, decrypted and emitted as 'packet'
//
// Emits 'packet' (188-byte aligned MPEG-TS), 'error' and 'close'.
// -----------------------------------------------------------------------------

import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { logger } from '@gladysassistant/integration-sdk';
import { AesHelper, pwdDigest } from './aesHelper.js';
import {
  STREAM_PORT,
  CLIENT_BOUNDARY,
  DEVICE_BOUNDARY,
  SUPER_SECRET_KEY,
  ENCRYPTION_METHODS,
  STREAM_USERNAME,
  STREAM_WINDOW_SIZE,
  TS_PACKET_SIZE,
  TS_SYNC_BYTE,
} from '../constants.js';

const CRLF = '\r\n';
const HEADER_SEPARATOR = '\r\n\r\n';

/**
 * Parse a block of HTTP-like headers into an object.
 * @param {string} block - The raw headers block.
 * @returns {Record<string, string>} The parsed headers, keys kept as-is.
 * @example
 * parseHeaders('Content-Type: application/json\r\nContent-Length: 2');
 */
function parseHeaders(block) {
  /** @type {Record<string, string>} */
  const headers = {};
  block
    .trim()
    .split(CRLF)
    .forEach((line) => {
      const index = line.indexOf(':');
      if (index === -1) {
        return;
      }
      headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    });
  return headers;
}

/**
 * Parse a `WWW-Authenticate` digest challenge into key/value pairs.
 * @param {string} value - The header value.
 * @returns {Record<string, string>} The challenge fields.
 * @example
 * parseAuthChallenge('Digest realm="x", nonce="y"');
 */
export function parseAuthChallenge(value) {
  /** @type {Record<string, string>} */
  const result = {};
  const data = value.startsWith('Digest') ? value.slice(value.indexOf(' ') + 1) : value;
  data.split(',').forEach((part) => {
    const index = part.indexOf('=');
    if (index === -1) {
      return;
    }
    const key = part.slice(0, index).trim().replace(/"/g, '');
    result[key] = part
      .slice(index + 1)
      .trim()
      .replace(/"/g, '');
  });
  return result;
}

/**
 * One media session to a camera. Short-lived by design: open it, take the frames
 * you need, close it.
 * @example
 * const session = new TapoMediaSession({ ip: '192.168.1.20', password: 'x' });
 * session.on('packet', (packet) => ffmpeg.stdin.write(packet));
 * await session.start();
 */
export class TapoMediaSession extends EventEmitter {
  /**
   * @param {object} options - The session options.
   * @param {string} options.ip - The local IP of the camera.
   * @param {string} options.password - The cloud (or camera) password.
   * @param {string} [options.username] - The digest username, 'admin' by default.
   * @param {string} [options.encryptionMethod] - 'md5' or 'sha256'.
   * @param {number} [options.port] - The stream port.
   * @param {number} [options.windowSize] - The acknowledgement window.
   * @param {string} [options.quality] - 'HD' or 'SD'.
   */
  constructor({
    ip,
    password = '',
    username = STREAM_USERNAME,
    encryptionMethod = ENCRYPTION_METHODS.MD5,
    port = STREAM_PORT,
    windowSize = STREAM_WINDOW_SIZE,
    quality = 'HD',
  }) {
    super();
    this.ip = ip;
    this.password = password;
    this.username = username;
    this.encryptionMethod = encryptionMethod;
    this.port = port;
    this.windowSize = windowSize;
    this.quality = quality;

    /** @type {import('node:net').Socket|null} */
    this.socket = null;
    /** @type {AesHelper|null} */
    this.aes = null;
    this.started = false;
    /** @type {number|null} */
    this.sessionId = null;
    this.deviceBoundary = DEVICE_BOUNDARY;

    // Incremental read state: TCP delivers arbitrary chunks, so every parsing
    // step must cope with a partial message.
    this.buffer = Buffer.alloc(0);
    /** @type {'auth'|'keyexchange'|'streaming'} */
    this.phase = 'auth';
    this.tsBuffer = Buffer.alloc(0);
    this.firstPacketLogged = false;
    /** @type {((value?: unknown) => void)|null} */
    this.resolveStart = null;
    /** @type {((reason: Error) => void)|null} */
    this.rejectStart = null;
  }

  /**
   * Connect and run the handshake. Resolves once the camera has accepted the
   * stream request, so the caller knows frames are on their way.
   * @param {number} [timeoutMs] - Give up if the handshake stalls.
   * @returns {Promise<void>} Resolves when the stream starts.
   * @example
   * await session.start(10000);
   */
  start(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.close();
        reject(new Error('TAPO_STREAM_TIMEOUT'));
      }, timeoutMs);

      // Whichever settles first wins; the timer must never outlive the promise.
      this.resolveStart = () => {
        clearTimeout(timer);
        resolve();
      };
      this.rejectStart = (error) => {
        clearTimeout(timer);
        reject(error);
      };

      this.socket = net.createConnection({ host: this.ip, port: this.port }, () => {
        logger.debug(`Tapo media session connected to ${this.ip}:${this.port}`);
        // Step 1: an unauthenticated request, only to collect the challenge.
        // Content-Length -1 is what the firmware expects for an endless body.
        this.sendRequest('POST /stream HTTP/1.1', {
          'Content-Type': `multipart/mixed;boundary=${CLIENT_BOUNDARY}`,
          Connection: 'keep-alive',
          'Content-Length': '-1',
        });
      });

      this.socket.on('data', (chunk) => this.onData(chunk));
      this.socket.on('error', (e) => this.onError(e));
      this.socket.on('close', () => {
        this.started = false;
        this.emit('close');
      });
    });
  }

  /**
   * Send a request line and headers, with no body.
   * @param {string} requestLine - The first line.
   * @param {Record<string, string>} headers - The headers.
   * @example
   * session.sendRequest('POST /stream HTTP/1.1', {});
   */
  sendRequest(requestLine, headers) {
    let payload = `${requestLine}${CRLF}`;
    Object.keys(headers).forEach((key) => {
      payload += `${key}: ${headers[key]}${CRLF}`;
    });
    payload += CRLF;
    this.write(payload);
  }

  /**
   * Send a request line, headers and a binary body.
   * @param {string} requestLine - The first line, usually a boundary.
   * @param {Record<string, string>} headers - The headers.
   * @param {Buffer} body - The body bytes.
   * @example
   * session.sendRequestWithBody('--client-stream-boundary--', headers, body);
   */
  sendRequestWithBody(requestLine, headers, body) {
    let head = `${requestLine}${CRLF}`;
    Object.keys(headers).forEach((key) => {
      head += `${key}: ${headers[key]}${CRLF}`;
    });
    head += CRLF;
    this.write(Buffer.concat([Buffer.from(head), body, Buffer.from(CRLF)]));
  }

  /**
   * Write to the socket, tolerating a session that closed underneath.
   *
   * The socket is torn down as soon as the capture has what it needs, while an
   * acknowledgement may still be in flight — writing to a destroyed socket
   * raises asynchronously and would take the whole process down.
   * @param {string|Buffer} data - The bytes to send.
   * @example
   * session.write('POST /stream HTTP/1.1\r\n\r\n');
   */
  write(data) {
    if (!this.socket || this.socket.destroyed) {
      return;
    }
    try {
      this.socket.write(data);
    } catch (e) {
      logger.debug(`Tapo media session: write on a closed socket ignored (${e.message})`);
    }
  }

  /**
   * Report an error, failing `start()` when the handshake never completed.
   * @param {Error} e - The error.
   * @example
   * session.onError(new Error('boom'));
   */
  onError(e) {
    logger.debug(`Tapo media session error: ${e.message}`);
    if (this.rejectStart && !this.started) {
      this.rejectStart(e);
      this.rejectStart = null;
      this.resolveStart = null;
    }
    this.emit('error', e);
  }

  /**
   * Accumulate bytes and drive the state machine until no step can progress.
   * @param {Buffer} chunk - The incoming bytes.
   * @example
   * session.onData(buffer);
   */
  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let progressed = true;
    while (progressed) {
      if (this.phase === 'auth') {
        progressed = this.handleAuthResponse();
      } else if (this.phase === 'keyexchange') {
        progressed = this.handleKeyExchangeResponse();
      } else {
        progressed = this.handleStreamChunk();
      }
    }
  }

  /**
   * Answer the digest challenge.
   * @returns {boolean} True when a full response was consumed.
   * @example
   * session.handleAuthResponse();
   */
  handleAuthResponse() {
    const sepIndex = this.buffer.indexOf(HEADER_SEPARATOR);
    if (sepIndex === -1) {
      return false;
    }
    const headBlock = this.buffer.subarray(0, sepIndex).toString();
    this.buffer = this.buffer.subarray(sepIndex + HEADER_SEPARATOR.length);

    const lines = headBlock.split(CRLF);
    const headers = parseHeaders(lines.slice(1).join(CRLF));

    if (!headers['WWW-Authenticate']) {
      this.onError(new Error('TAPO_STREAM_NO_AUTH_CHALLENGE'));
      return false;
    }

    const challenge = parseAuthChallenge(headers['WWW-Authenticate']);

    // `encrypt_type=3` means the camera wants the password hashed with SHA256;
    // the digest itself stays MD5. Detecting it is what makes recent firmwares
    // work without asking the user anything.
    if (challenge.encrypt_type === '3') {
      this.encryptionMethod = ENCRYPTION_METHODS.SHA256;
    }
    logger.debug(
      `Tapo media session: authenticating as "${this.username}" (${this.encryptionMethod})`,
    );

    const hashedPassword = pwdDigest(Buffer.from(this.password), this.encryptionMethod).toString();
    const cnonce = crypto.randomBytes(24).toString('hex');
    const nc = '00000001';
    const qop = 'auth';

    // Standard HTTP digest, except that the "password" is already a hash.
    const ha1 = crypto
      .createHash('md5')
      .update(`${this.username}:${challenge.realm}:${hashedPassword}`)
      .digest('hex');
    const ha2 = crypto.createHash('md5').update('POST:/stream').digest('hex');
    const response = crypto
      .createHash('md5')
      .update(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
      .digest('hex');

    const authorization =
      `Digest username="${this.username}",realm="${challenge.realm}",uri="/stream",algorithm=MD5,` +
      `nonce="${challenge.nonce}",nc=${nc},cnonce="${cnonce}",qop=${qop},` +
      `response="${response}",opaque="${challenge.opaque || ''}"`;

    this.phase = 'keyexchange';
    this.sendRequest('POST /stream HTTP/1.1', {
      'Content-Type': `multipart/mixed;boundary=${CLIENT_BOUNDARY}`,
      Connection: 'keep-alive',
      'Content-Length': '-1',
      Authorization: authorization,
    });
    return true;
  }

  /**
   * Derive the AES key from the Key-Exchange header and ask for the stream.
   * @returns {boolean} True when a full response was consumed.
   * @example
   * session.handleKeyExchangeResponse();
   */
  handleKeyExchangeResponse() {
    const sepIndex = this.buffer.indexOf(HEADER_SEPARATOR);
    if (sepIndex === -1) {
      return false;
    }
    const headBlock = this.buffer.subarray(0, sepIndex).toString();
    this.buffer = this.buffer.subarray(sepIndex + HEADER_SEPARATOR.length);

    const lines = headBlock.split(CRLF);
    const statusCode = parseInt(lines[0].split(' ')[1], 10);
    if (statusCode !== 200) {
      // 401 here is the signature of a model that blocks local access (C610):
      // the credentials are right, the camera simply refuses.
      this.onError(new Error(`TAPO_STREAM_HTTP_${statusCode}`));
      return false;
    }

    const headers = parseHeaders(lines.slice(1).join(CRLF));
    if (!headers['Key-Exchange']) {
      this.onError(new Error('TAPO_STREAM_KEY_EXCHANGE_MISSING'));
      return false;
    }

    // The camera may announce its own boundary; fall back to the documented one.
    if (headers['Content-Type']) {
      headers['Content-Type'].split(';').forEach((part) => {
        const trimmed = part.trim();
        if (trimmed.startsWith('boundary=')) {
          this.deviceBoundary = trimmed.slice('boundary='.length);
        }
      });
    }

    try {
      this.aes = AesHelper.fromKeyExchange(
        Buffer.from(headers['Key-Exchange']),
        Buffer.from(this.password),
        Buffer.from(SUPER_SECRET_KEY),
        this.encryptionMethod,
      );
    } catch (e) {
      this.onError(e);
      return false;
    }

    this.phase = 'streaming';
    this.started = true;
    this.sendStreamRequest();

    if (this.resolveStart) {
      this.resolveStart();
      this.resolveStart = null;
      this.rejectStart = null;
    }
    return true;
  }

  /**
   * Send the encrypted JSON request that starts the preview stream.
   * @example
   * session.sendStreamRequest();
   */
  sendStreamRequest() {
    const payload = {
      type: 'request',
      seq: Math.floor(Math.random() * (0x7fff - 1000) + 1000),
      params: {
        preview: {
          audio: ['default'],
          channels: [0],
          resolutions: [this.quality],
        },
        method: 'get',
      },
    };
    const data = this.aes.encrypt(Buffer.from(JSON.stringify(payload)));
    this.sendRequestWithBody(
      `--${CLIENT_BOUNDARY}`,
      {
        'Content-Type': 'application/json',
        'X-If-Encrypt': '1',
        'X-Data-Window-Size': String(this.windowSize),
        'Content-Length': String(data.length),
      },
      data,
    );
  }

  /**
   * Consume one multipart part and forward its decrypted MPEG-TS.
   * @returns {boolean} True when a full part was consumed.
   * @example
   * session.handleStreamChunk();
   */
  handleStreamChunk() {
    const boundary = Buffer.from(this.deviceBoundary);
    const boundaryIndex = this.buffer.indexOf(boundary);
    if (boundaryIndex === -1) {
      return false;
    }
    const afterBoundary = this.buffer.subarray(boundaryIndex + boundary.length);

    const sepIndex = afterBoundary.indexOf(HEADER_SEPARATOR);
    if (sepIndex === -1) {
      return false; // The header block is not complete yet.
    }
    const headers = parseHeaders(afterBoundary.subarray(0, sepIndex).toString());
    const length = parseInt(headers['Content-Length'], 10);
    if (Number.isNaN(length)) {
      // Malformed part: step past it, otherwise the loop would spin forever on
      // the same boundary.
      this.buffer = afterBoundary.subarray(sepIndex + HEADER_SEPARATOR.length);
      return true;
    }

    const bodyStart = sepIndex + HEADER_SEPARATOR.length;
    if (afterBoundary.length < bodyStart + length) {
      return false; // Wait for the whole body.
    }

    const body = afterBoundary.subarray(bodyStart, bodyStart + length);
    this.buffer = afterBoundary.subarray(bodyStart + length);

    const sessionId =
      headers['X-Session-Id'] !== undefined ? parseInt(headers['X-Session-Id'], 10) : null;
    const seq =
      headers['X-Data-Sequence'] !== undefined ? parseInt(headers['X-Data-Sequence'], 10) : null;
    if (sessionId !== null) {
      this.sessionId = sessionId;
    }

    let plaintext;
    if (headers['X-If-Encrypt'] === '1') {
      try {
        plaintext = this.aes.decrypt(body);
      } catch {
        this.onError(new Error('TAPO_STREAM_DECRYPT_FAILED'));
        return true;
      }
    } else {
      plaintext = body;
    }

    if (headers['Content-Type'] === 'video/mp2t') {
      if (!this.firstPacketLogged) {
        this.firstPacketLogged = true;
        logger.debug('Tapo media session: receiving the video stream');
      }
      this.forwardTsPackets(plaintext);
    } else if (headers['Content-Type'] === 'application/json') {
      // The camera reports its stream status as JSON; useful when diagnosing.
      logger.debug(
        `Tapo media session: message from the camera: ${plaintext.toString().slice(0, 300)}`,
      );
    }

    // The camera stops sending unless the client acknowledges each window.
    if (seq !== null && this.windowSize > 0 && seq % this.windowSize === 0) {
      this.sendAck(seq);
    }
    return true;
  }

  /**
   * Re-align the MPEG-TS byte stream and emit whole 188-byte packets. ffmpeg
   * needs aligned packets: a part boundary can fall mid-packet.
   * @param {Buffer} data - The decrypted payload.
   * @example
   * session.forwardTsPackets(buffer);
   */
  forwardTsPackets(data) {
    this.tsBuffer = Buffer.concat([this.tsBuffer, data]);

    // Drop leading bytes until a sync byte starts the buffer.
    while (this.tsBuffer.length >= TS_PACKET_SIZE && this.tsBuffer[0] !== TS_SYNC_BYTE) {
      const position = this.tsBuffer.indexOf(TS_SYNC_BYTE, 1);
      if (position === -1) {
        this.tsBuffer = Buffer.alloc(0);
        break;
      }
      this.tsBuffer = this.tsBuffer.subarray(position);
    }

    while (this.tsBuffer.length >= TS_PACKET_SIZE) {
      this.emit('packet', this.tsBuffer.subarray(0, TS_PACKET_SIZE));
      this.tsBuffer = this.tsBuffer.subarray(TS_PACKET_SIZE);
    }
  }

  /**
   * Acknowledge the received window so the camera keeps streaming.
   * @param {number} seq - The current data sequence number.
   * @example
   * session.sendAck(500);
   */
  sendAck(seq) {
    const data = Buffer.from(
      JSON.stringify({ type: 'notification', params: { event_type: 'stream_sequence' } }),
    );
    this.sendRequestWithBody(
      `--${CLIENT_BOUNDARY}`,
      {
        'X-Session-Id': String(this.sessionId),
        'X-Data-Received': String(this.windowSize * Math.floor(seq / this.windowSize)),
        'Content-Length': String(data.length),
      },
      data,
    );
  }

  /**
   * Close the session and its socket. Safe to call twice.
   * @example
   * session.close();
   */
  close() {
    this.started = false;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}
