// -----------------------------------------------------------------------------
// KLAP: the local protocol of the recent Tapo plugs, bulbs, switches and hubs.
//
// Two handshakes, then encrypted requests (HTTP, port 80):
//
//   1. POST /app/handshake1 with 16 random bytes (the local seed). The device
//      answers its own 16 random bytes (the remote seed) followed by a 32-byte
//      hash that proves it knows the account: comparing it with the hash
//      computed locally tells, before anything else is sent, whether the
//      credentials are right — and which hashing generation the firmware uses.
//      The answer also sets the session cookie.
//   2. POST /app/handshake2 with a hash proving WE know the account.
//   3. Every request: POST /app/request?seq=N, AES-128-CBC with a key and an IV
//      derived from both seeds and the account hash; the last four bytes of the
//      IV are a sequence number incremented on every request, and the body is
//      prefixed with a SHA-256 signature.
//
// Two hashing generations exist ("login version" in a discovery reply):
//   v1: account = md5(md5(email) + md5(password)); proofs sha256(seed + account)
//   v2: account = sha256(sha1(email) + sha1(password)); proofs over both seeds
// The handshake answer is checked against both, so a device whose version is
// not known in advance (no discovery reply) still connects at the first try.
//
// Protocol as documented by the python-kasa project, which captured it from the
// Tapo app; this is an independent implementation.
// -----------------------------------------------------------------------------

import crypto from 'node:crypto';
import { post } from './http.js';

/**
 * Credentials some devices answer with instead of the account's: a device that
 * was never bound to a cloud account, or one that "forgets" it intermittently
 * (a known firmware quirk). Trying them costs nothing — the check is local.
 */
const FALLBACK_CREDENTIALS = [
  // The Tapo app's built-in test account, stored base64 like python-kasa does.
  {
    username: Buffer.from('dGVzdEB0cC1saW5rLm5ldA==', 'base64').toString(),
    password: Buffer.from('dGVzdA==', 'base64').toString(),
  },
  // A device fresh out of its box.
  { username: '', password: '' },
];

/** Margin before the session lifetime the device announced, in ms. */
const SESSION_MARGIN_MS = 20 * 60 * 1000;

/** Session lifetime when the device does not announce one. */
const DEFAULT_SESSION_MS = 24 * 60 * 60 * 1000;

/**
 * A hash digest, as a Buffer.
 * @param {string} algorithm - 'md5', 'sha1' or 'sha256'.
 * @param {...Buffer} parts - What to hash, concatenated.
 * @returns {Buffer} The digest.
 * @example
 * digest('sha256', a, b);
 */
function digest(algorithm, ...parts) {
  const hash = crypto.createHash(algorithm);
  parts.forEach((part) => hash.update(part));
  return hash.digest();
}

/**
 * The account hash of each generation.
 * @param {1|2} version - The KLAP generation.
 * @param {string} username - The account email.
 * @param {string} password - The account password.
 * @returns {Buffer} The account hash.
 * @example
 * authHash(2, 'me@example.com', 'secret');
 */
export function authHash(version, username, password) {
  const user = Buffer.from(username, 'utf8');
  const pass = Buffer.from(password, 'utf8');
  return version === 1
    ? digest('md5', digest('md5', user), digest('md5', pass))
    : digest('sha256', digest('sha1', user), digest('sha1', pass));
}

/**
 * The proof the device sends back in handshake1.
 * @param {1|2} version - The KLAP generation.
 * @param {Buffer} localSeed - Our seed.
 * @param {Buffer} remoteSeed - The device's seed.
 * @param {Buffer} hash - The account hash.
 * @returns {Buffer} The expected proof.
 * @example
 * handshake1Proof(2, local, remote, hash);
 */
export function handshake1Proof(version, localSeed, remoteSeed, hash) {
  return version === 1
    ? digest('sha256', localSeed, hash)
    : digest('sha256', localSeed, remoteSeed, hash);
}

/**
 * The proof we send in handshake2.
 * @param {1|2} version - The KLAP generation.
 * @param {Buffer} localSeed - Our seed.
 * @param {Buffer} remoteSeed - The device's seed.
 * @param {Buffer} hash - The account hash.
 * @returns {Buffer} The proof.
 * @example
 * handshake2Proof(2, local, remote, hash);
 */
export function handshake2Proof(version, localSeed, remoteSeed, hash) {
  return version === 1
    ? digest('sha256', remoteSeed, hash)
    : digest('sha256', remoteSeed, localSeed, hash);
}

/**
 * The encryption state of one KLAP session: key, IV prefix, signature key and
 * the sequence number, which the device checks and which must only grow.
 * @example
 * const session = new KlapSession(local, remote, hash);
 * const { body, seq } = session.encrypt(Buffer.from('{}'));
 */
export class KlapSession {
  /**
   * @param {Buffer} localSeed - Our seed.
   * @param {Buffer} remoteSeed - The device's seed.
   * @param {Buffer} hash - The account hash that matched.
   */
  constructor(localSeed, remoteSeed, hash) {
    const seeds = Buffer.concat([localSeed, remoteSeed, hash]);
    this.key = digest('sha256', Buffer.from('lsk'), seeds).subarray(0, 16);
    const fullIv = digest('sha256', Buffer.from('iv'), seeds);
    this.ivPrefix = fullIv.subarray(0, 12);
    this.seq = fullIv.readInt32BE(28);
    this.signatureKey = digest('sha256', Buffer.from('ldk'), seeds).subarray(0, 28);
  }

  /**
   * The IV of one request: the prefix and the sequence number.
   * @param {number} seq - The sequence number.
   * @returns {Buffer} The 16-byte IV.
   * @example
   * session.ivFor(42);
   */
  ivFor(seq) {
    const tail = Buffer.alloc(4);
    tail.writeInt32BE(seq, 0);
    return Buffer.concat([this.ivPrefix, tail]);
  }

  /**
   * Encrypt one request, moving the sequence on.
   * @param {Buffer} plaintext - The JSON request.
   * @returns {{ body: Buffer, seq: number }} What to send, and its sequence.
   * @example
   * session.encrypt(Buffer.from('{"method":"get_device_info"}'));
   */
  encrypt(plaintext) {
    // A signed 32-bit counter: it wraps rather than overflowing, as the device
    // expects.
    this.seq = (this.seq + 1) | 0;
    const cipher = crypto.createCipheriv('aes-128-cbc', this.key, this.ivFor(this.seq));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const seqBytes = Buffer.alloc(4);
    seqBytes.writeInt32BE(this.seq, 0);
    const signature = digest('sha256', this.signatureKey, seqBytes, ciphertext);
    return { body: Buffer.concat([signature, ciphertext]), seq: this.seq };
  }

  /**
   * Decrypt one answer: it uses the IV of the request it answers.
   * @param {Buffer} body - The answer: a 32-byte signature, then the ciphertext.
   * @param {number} seq - The sequence of the request.
   * @returns {Buffer} The JSON answer.
   * @example
   * session.decrypt(answer, seq);
   */
  decrypt(body, seq) {
    const decipher = crypto.createDecipheriv('aes-128-cbc', this.key, this.ivFor(seq));
    return Buffer.concat([decipher.update(body.subarray(32)), decipher.final()]);
  }
}

/**
 * A KLAP connection to one device.
 * @example
 * const transport = new KlapTransport({ ip: '192.168.1.30', username, password });
 * const answer = await transport.send({ method: 'get_device_info' });
 */
export class KlapTransport {
  /**
   * @param {object} options - The connection.
   * @param {string} options.ip - The device address.
   * @param {number} [options.port] - The HTTP port, 80 by default.
   * @param {string} options.username - The Tapo account email.
   * @param {string} options.password - The Tapo account password.
   * @param {number} [options.timeoutMs] - Deadline of each HTTP exchange.
   */
  constructor({ ip, port = 80, username, password, timeoutMs = 5000 }) {
    this.ip = ip;
    this.port = port;
    this.timeoutMs = timeoutMs;
    /** The account first, then the fallbacks, each in both generations. */
    this.candidates = [{ username, password }, ...FALLBACK_CREDENTIALS].flatMap((credentials) =>
      [2, 1].map((version) => ({
        version,
        hash: authHash(version, credentials.username, credentials.password),
      })),
    );
    /** @type {KlapSession|null} */
    this.session = null;
    /** @type {Record<string, string>|null} */
    this.cookies = null;
    this.expiresAt = 0;
    /** The generation the device proved, for the logs. @type {number|null} */
    this.version = null;
  }

  /**
   * Run both handshakes and open a session.
   * @returns {Promise<void>} Resolves once the session is usable.
   * @example
   * await transport.handshake();
   */
  async handshake() {
    this.session = null;
    const localSeed = crypto.randomBytes(16);
    const first = await post({
      host: this.ip,
      port: this.port,
      path: '/app/handshake1',
      body: localSeed,
      timeoutMs: this.timeoutMs,
    });
    if (first.status !== 200) {
      // 404 is how a device that does not speak KLAP answers: the caller tries
      // the older protocol on that signal.
      throw Object.assign(new Error(`TAPO_KLAP_HANDSHAKE1_HTTP_${first.status}`), {
        status: first.status,
      });
    }
    if (first.body.length !== 48) {
      throw new Error(`TAPO_KLAP_HANDSHAKE1_BAD_LENGTH:${first.body.length}`);
    }
    const remoteSeed = first.body.subarray(0, 16);
    const proof = first.body.subarray(16);

    const match = this.candidates.find((candidate) =>
      handshake1Proof(candidate.version, localSeed, remoteSeed, candidate.hash).equals(proof),
    );
    if (!match) {
      // The device holds another account: nothing sent so far can count as a
      // failed login on its side, so this costs no lockout.
      throw Object.assign(new Error('TAPO_SMART_BAD_CREDENTIALS'), { authFailed: true });
    }

    const sessionCookie = first.cookies.TP_SESSIONID;
    this.cookies = sessionCookie ? { TP_SESSIONID: sessionCookie } : null;
    const timeoutSeconds = Number(first.cookies.TIMEOUT);
    const lifetime =
      Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
        ? timeoutSeconds * 1000
        : DEFAULT_SESSION_MS;
    this.expiresAt = Date.now() + Math.max(60 * 1000, lifetime - SESSION_MARGIN_MS);

    const second = await post({
      host: this.ip,
      port: this.port,
      path: '/app/handshake2',
      body: handshake2Proof(match.version, localSeed, remoteSeed, match.hash),
      cookies: this.cookies,
      timeoutMs: this.timeoutMs,
    });
    if (second.status !== 200) {
      throw new Error(`TAPO_KLAP_HANDSHAKE2_HTTP_${second.status}`);
    }
    this.version = match.version;
    this.session = new KlapSession(localSeed, remoteSeed, match.hash);
  }

  /**
   * Send one request and return the parsed answer.
   * @param {object} request - The JSON request (`{ method, params }`).
   * @returns {Promise<object>} The answer (`{ error_code, result }`).
   * @example
   * await transport.send({ method: 'get_device_info' });
   */
  async send(request) {
    if (!this.session || Date.now() >= this.expiresAt) {
      await this.handshake();
    }
    const { body, seq } = this.session.encrypt(Buffer.from(JSON.stringify(request), 'utf8'));
    const answer = await post({
      host: this.ip,
      port: this.port,
      path: `/app/request?seq=${seq}`,
      body,
      cookies: this.cookies,
      timeoutMs: this.timeoutMs,
    });
    if (answer.status === 403) {
      // The device dropped the session: one fresh handshake, then give up.
      this.session = null;
      throw Object.assign(new Error('TAPO_SMART_SESSION_EXPIRED'), { retryable: true });
    }
    if (answer.status !== 200) {
      throw new Error(`TAPO_KLAP_HTTP_${answer.status}`);
    }
    return JSON.parse(this.session.decrypt(answer.body, seq).toString('utf8'));
  }

  /**
   * Forget the session; the next request handshakes again.
   * @example
   * transport.reset();
   */
  reset() {
    this.session = null;
  }
}
