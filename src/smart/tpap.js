// -----------------------------------------------------------------------------
// TPAP: the local protocol of the Tapo plugs, bulbs, switches and hubs on
// firmware 1.4 and later when "Third-Party Compatibility" is off — and, on
// some lights (L530 1.4.1), even when it is on: they then turn KLAP down with
// a 403 at handshake1. JSON over HTTP, port 80 unless the device says
// otherwise:
//
//   1. discover: POST / `{ method: 'login', params: { sub_method: 'discover' } }`.
//      A device in TPAP mode answers a `tpap` object (port, TLS, which
//      passcodes it takes); one that is not answers an error code or a 404.
//   2. pake_register: our random, the `admin` user (MD5), the account
//      password as passcode. The device answers its random, a PBKDF2 salt and
//      iteration count, how it stores the password (`extra_crypt`), and its
//      SPAKE2+ share.
//   3. pake_share: our SPAKE2+ share (RFC 9383, P-256, SHA-256, HKDF, HMAC)
//      and the confirmation that we know the password. The device answers its
//      own confirmation, which is checked, a session token and a start
//      sequence number.
//   4. every request: POST /stok=<token>/ds, AES-128-CCM with a key and a
//      nonce derived from the SPAKE2+ shared key; the body starts with the
//      sequence number, which grows by one per request and which the answer
//      repeats.
//
// Protocol as documented by the `tapo` project (MIT), which captured it from
// the Tapo app; this is an independent implementation. Node exposes no
// elliptic-curve point arithmetic, so the few operations SPAKE2+ needs on
// P-256 are written here with BigInt and checked against the RFC 9383 test
// vector.
// -----------------------------------------------------------------------------

import crypto from 'node:crypto';
import { post } from './http.js';

/** The only cipher suite the Tapo app offers: P-256, SHA-256, HMAC-SHA256. */
const CIPHER_SUITE = 1;
const ENCRYPTION = 'aes_128_ccm';

/** Upper bound on the PBKDF2 iterations a device may ask for. */
const MAX_ITERATIONS = 100000;

/** Session lifetime when the device does not announce one. */
const DEFAULT_SESSION_MS = 24 * 60 * 60 * 1000;

/** Margin before the session lifetime the device announced, in ms. */
const SESSION_MARGIN_MS = 20 * 60 * 1000;

/** Error codes of the login. */
const ERROR_CODES = {
  /** Too many failed logins: the device refuses every login for a while. */
  LOCKED: -2101,
  /** A plug or a bulb refusing the password. */
  WRONG_PASSWORD: -2203,
  /** A camera refusing the password (the code of an expired session elsewhere). */
  WRONG_PASSWORD_CAMERA: -40401,
};

// --- P-256 -------------------------------------------------------------------

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
export const GENERATOR = {
  x: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
  y: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
};

/** The points `M` and `N` RFC 9383 assigns to P-256, compressed. */
const M_HEX = '02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f';
const N_HEX = '03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49';

/**
 * `value` modulo `modulus`, always positive.
 * @param {bigint} value - The value.
 * @param {bigint} [modulus] - The modulus, the field prime by default.
 * @returns {bigint} The residue.
 * @example
 * mod(-1n);
 */
function mod(value, modulus = P) {
  const residue = value % modulus;
  return residue >= 0n ? residue : residue + modulus;
}

/**
 * `base` to the power `exponent`, modulo the field prime.
 * @param {bigint} base - The base.
 * @param {bigint} exponent - The exponent.
 * @returns {bigint} The power.
 * @example
 * powMod(2n, 10n);
 */
function powMod(base, exponent) {
  let result = 1n;
  let square = mod(base);
  let rest = exponent;
  while (rest > 0n) {
    if (rest & 1n) {
      result = (result * square) % P;
    }
    square = (square * square) % P;
    rest >>= 1n;
  }
  return result;
}

/**
 * Big-endian bytes as an unsigned BigInt.
 * @param {Buffer} bytes - The bytes.
 * @returns {bigint} The number.
 * @example
 * toBigInt(Buffer.from([1, 0]));
 */
function toBigInt(bytes) {
  return bytes.length === 0 ? 0n : BigInt(`0x${bytes.toString('hex')}`);
}

/**
 * An unsigned BigInt as 32 big-endian bytes.
 * @param {bigint} value - The number, below 2^256.
 * @returns {Buffer} The bytes.
 * @example
 * toBytes32(5n);
 */
function toBytes32(value) {
  return Buffer.from(value.toString(16).padStart(64, '0'), 'hex');
}

/**
 * The right-hand side of the curve equation, x³ - 3x + b.
 * @param {bigint} x - The abscissa.
 * @returns {bigint} y².
 * @example
 * curveRhs(GENERATOR.x);
 */
function curveRhs(x) {
  return mod(x * x * x - 3n * x + B);
}

/**
 * Double a point in Jacobian coordinates (a = -3). `null` is the identity.
 * @param {{ x: bigint, y: bigint, z: bigint }|null} point - The point.
 * @returns {{ x: bigint, y: bigint, z: bigint }|null} Twice the point.
 * @example
 * jacobianDouble({ x, y, z: 1n });
 */
function jacobianDouble(point) {
  if (!point || point.y === 0n) {
    return null;
  }
  const delta = mod(point.z * point.z);
  const gamma = mod(point.y * point.y);
  const beta = mod(point.x * gamma);
  const alpha = mod(3n * (point.x - delta) * (point.x + delta));
  const x = mod(alpha * alpha - 8n * beta);
  const z = mod((point.y + point.z) ** 2n - gamma - delta);
  const y = mod(alpha * (4n * beta - x) - 8n * gamma * gamma);
  return { x, y, z };
}

/**
 * Add two points in Jacobian coordinates. `null` is the identity.
 * @param {{ x: bigint, y: bigint, z: bigint }|null} first - A point.
 * @param {{ x: bigint, y: bigint, z: bigint }|null} second - Another point.
 * @returns {{ x: bigint, y: bigint, z: bigint }|null} Their sum.
 * @example
 * jacobianAdd(a, b);
 */
function jacobianAdd(first, second) {
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }
  const z1z1 = mod(first.z * first.z);
  const z2z2 = mod(second.z * second.z);
  const u1 = mod(first.x * z2z2);
  const u2 = mod(second.x * z1z1);
  const s1 = mod(first.y * second.z * z2z2);
  const s2 = mod(second.y * first.z * z1z1);
  if (u1 === u2) {
    return s1 === s2 ? jacobianDouble(first) : null;
  }
  const h = mod(u2 - u1);
  const r = mod(s2 - s1);
  const hh = mod(h * h);
  const hhh = mod(h * hh);
  const u1hh = mod(u1 * hh);
  const x = mod(r * r - hhh - 2n * u1hh);
  const y = mod(r * (u1hh - x) - s1 * hhh);
  const z = mod(h * first.z * second.z);
  return { x, y, z };
}

/**
 * A point of the curve, in affine coordinates. `null` is the identity.
 * @typedef {{ x: bigint, y: bigint }|null} Point
 */

/**
 * The Jacobian form of an affine point.
 * @param {Point} point - The point.
 * @returns {{ x: bigint, y: bigint, z: bigint }|null} Its Jacobian form.
 * @example
 * toJacobian(GENERATOR);
 */
function toJacobian(point) {
  return point ? { x: point.x, y: point.y, z: 1n } : null;
}

/**
 * The affine form of a Jacobian point.
 * @param {{ x: bigint, y: bigint, z: bigint }|null} point - The point.
 * @returns {Point} Its affine form.
 * @example
 * toAffine({ x, y, z });
 */
function toAffine(point) {
  if (!point || point.z === 0n) {
    return null;
  }
  const zInverse = powMod(point.z, P - 2n);
  const zInverse2 = mod(zInverse * zInverse);
  return { x: mod(point.x * zInverse2), y: mod(point.y * zInverse2 * zInverse) };
}

/**
 * Add two points.
 * @param {Point} first - A point.
 * @param {Point} second - Another point.
 * @returns {Point} Their sum.
 * @example
 * pointAdd(a, b);
 */
export function pointAdd(first, second) {
  return toAffine(jacobianAdd(toJacobian(first), toJacobian(second)));
}

/**
 * The opposite of a point.
 * @param {Point} point - The point.
 * @returns {Point} Its opposite.
 * @example
 * pointNegate(GENERATOR);
 */
export function pointNegate(point) {
  return point ? { x: point.x, y: mod(-point.y) } : null;
}

/**
 * Multiply a point by a scalar. A Montgomery ladder: the same operations
 * whatever the bits of the scalar.
 * @param {Point} point - The point.
 * @param {bigint} scalar - The scalar.
 * @returns {Point} The product.
 * @example
 * pointMultiply(GENERATOR, 5n);
 */
export function pointMultiply(point, scalar) {
  const k = mod(scalar, ORDER);
  let low = null;
  let high = toJacobian(point);
  for (let bit = 255; bit >= 0; bit -= 1) {
    if ((k >> BigInt(bit)) & 1n) {
      low = jacobianAdd(low, high);
      high = jacobianDouble(high);
    } else {
      high = jacobianAdd(low, high);
      low = jacobianDouble(low);
    }
  }
  return toAffine(low);
}

/**
 * Decode a SEC1 point, compressed or not. `null` when the bytes encode the
 * identity or no point of the curve.
 * @param {Buffer} bytes - The encoding.
 * @returns {Point} The point.
 * @example
 * decodePoint(Buffer.from(M_HEX, 'hex'));
 */
export function decodePoint(bytes) {
  if (bytes.length === 65 && bytes[0] === 0x04) {
    const x = toBigInt(bytes.subarray(1, 33));
    const y = toBigInt(bytes.subarray(33));
    if (x >= P || y >= P || mod(y * y) !== curveRhs(x)) {
      return null;
    }
    return { x, y };
  }
  if (bytes.length === 33 && (bytes[0] === 0x02 || bytes[0] === 0x03)) {
    const x = toBigInt(bytes.subarray(1));
    if (x >= P) {
      return null;
    }
    const rhs = curveRhs(x);
    // p ≡ 3 (mod 4): the square root is a single power.
    const root = powMod(rhs, (P + 1n) / 4n);
    if (mod(root * root) !== rhs) {
      return null;
    }
    const odd = bytes[0] === 0x03;
    return { x, y: (root & 1n) === (odd ? 1n : 0n) ? root : mod(-root) };
  }
  return null;
}

/**
 * Encode a point uncompressed (65 bytes).
 * @param {Point} point - The point, not the identity.
 * @returns {Buffer} The encoding.
 * @example
 * encodePoint(GENERATOR);
 */
export function encodePoint(point) {
  return Buffer.concat([Buffer.from([0x04]), toBytes32(point.x), toBytes32(point.y)]);
}

// --- SPAKE2+ -----------------------------------------------------------------

/** `M` and `N`, decoded once. @type {{ m: Point, n: Point }|null} */
let maskPoints = null;

/**
 * The points `M` and `N`.
 * @returns {{ m: Point, n: Point }} The masks of the prover and verifier shares.
 * @example
 * const { m, n } = masks();
 */
export function masks() {
  if (!maskPoints) {
    maskPoints = {
      m: decodePoint(Buffer.from(M_HEX, 'hex')),
      n: decodePoint(Buffer.from(N_HEX, 'hex')),
    };
  }
  return maskPoints;
}

/**
 * Big-endian bytes, at most 64 of them, reduced modulo the group order.
 * @param {Buffer} bytes - The bytes.
 * @returns {bigint} The scalar.
 * @example
 * scalarFromWide(Buffer.alloc(40, 0xff));
 */
export function scalarFromWide(bytes) {
  return mod(toBigInt(bytes), ORDER);
}

/**
 * `w0` and `w1`: both halves of the PBKDF2 output, reduced modulo the order.
 * @param {string} credential - What stands in for the password.
 * @param {Buffer} salt - The device's salt.
 * @param {number} iterations - The device's iteration count.
 * @returns {Promise<{ w0: bigint, w1: bigint }>} The two scalars.
 * @example
 * await deriveW0W1('f3bb…', salt, 3000);
 */
export async function deriveW0W1(credential, salt, iterations) {
  // Asynchronous: thousands of iterations would hold the event loop.
  const key = await new Promise((resolve, reject) =>
    crypto.pbkdf2(Buffer.from(credential, 'utf8'), salt, iterations, 80, 'sha256', (e, out) =>
      e ? reject(e) : resolve(out),
    ),
  );
  return { w0: scalarFromWide(key.subarray(0, 40)), w1: scalarFromWide(key.subarray(40)) };
}

/**
 * The items one after the other, each behind its length as 8 little-endian
 * bytes.
 * @param {Buffer[]} items - The items.
 * @returns {Buffer} The transcript.
 * @example
 * transcript([a, b]);
 */
function transcript(items) {
  return Buffer.concat(
    items.flatMap((item) => {
      const length = Buffer.alloc(8);
      length.writeBigUInt64LE(BigInt(item.length));
      return [length, item];
    }),
  );
}

/**
 * HKDF-SHA256.
 * @param {Buffer} key - The input key.
 * @param {Buffer|string} salt - The salt.
 * @param {Buffer|string} info - The info.
 * @param {number} length - The output length.
 * @returns {Buffer} The derived bytes.
 * @example
 * hkdf(key, '', 'SharedKey', 32);
 */
function hkdf(key, salt, info, length) {
  return Buffer.from(crypto.hkdfSync('sha256', key, salt, info, length));
}

/**
 * The keys both sides derive from the transcript of one exchange.
 * @param {object} options - The transcript.
 * @param {Buffer} options.context - The protocol context.
 * @param {Buffer} options.proverIdentity - Empty for TPAP.
 * @param {Buffer} options.verifierIdentity - Empty for TPAP.
 * @param {Buffer} options.proverShare - X, uncompressed.
 * @param {Buffer} options.verifierShare - Y, uncompressed.
 * @param {Point} options.z - The shared point Z.
 * @param {Point} options.v - The shared point V.
 * @param {bigint} options.w0 - First password scalar.
 * @returns {{ proverConfirmKey: Buffer, verifierConfirmKey: Buffer, sharedKey: Buffer }}
 * The confirmation keys and the shared key.
 * @example
 * keySchedule({ context, proverIdentity, verifierIdentity, proverShare, verifierShare, z, v, w0 });
 */
export function keySchedule({
  context,
  proverIdentity,
  verifierIdentity,
  proverShare,
  verifierShare,
  z,
  v,
  w0,
}) {
  const { m, n } = masks();
  const mainKey = crypto
    .createHash('sha256')
    .update(
      transcript([
        context,
        proverIdentity,
        verifierIdentity,
        encodePoint(m),
        encodePoint(n),
        proverShare,
        verifierShare,
        encodePoint(z),
        encodePoint(v),
        // Always 32 bytes, however small w0 is.
        toBytes32(w0),
      ]),
    )
    .digest();
  const confirmKeys = hkdf(mainKey, Buffer.alloc(0), 'ConfirmationKeys', 64);
  return {
    proverConfirmKey: confirmKeys.subarray(0, 32),
    verifierConfirmKey: confirmKeys.subarray(32),
    sharedKey: hkdf(mainKey, Buffer.alloc(0), 'SharedKey', 32),
  };
}

/**
 * HMAC-SHA256, the confirmation of one side.
 * @param {Buffer} key - The confirmation key.
 * @param {Buffer} data - The other side's share.
 * @returns {Buffer} The tag.
 * @example
 * hmac(key, share);
 */
export function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

/**
 * The prover side of SPAKE2+, once the verifier's share is known.
 * @param {object} options - The inputs.
 * @param {bigint} options.w0 - First password scalar.
 * @param {bigint} options.w1 - Second password scalar.
 * @param {bigint} options.x - Our ephemeral secret.
 * @param {Buffer} options.context - The protocol context.
 * @param {Buffer} [options.proverIdentity] - Empty for TPAP.
 * @param {Buffer} [options.verifierIdentity] - Empty for TPAP.
 * @param {Buffer} options.verifierShare - The device's share, SEC1.
 * @returns {{ share: Buffer, confirm: Buffer, sharedKey: Buffer, verifierConfirmKey: Buffer, verify: (confirm: Buffer) => boolean }}
 * Our share and confirmation, the shared key, and the check of the device's
 * confirmation.
 * @example
 * prove({ w0, w1, x, context, verifierShare });
 */
export function prove({
  w0,
  w1,
  x,
  context,
  proverIdentity = Buffer.alloc(0),
  verifierIdentity = Buffer.alloc(0),
  verifierShare,
}) {
  const { m, n } = masks();
  const share = pointAdd(pointMultiply(GENERATOR, x), pointMultiply(m, w0));
  const theirs = decodePoint(verifierShare);
  if (!theirs) {
    throw new Error('TAPO_TPAP_BAD_DEVICE_SHARE');
  }
  const unmasked = pointAdd(theirs, pointNegate(pointMultiply(n, w0)));
  const z = pointMultiply(unmasked, x);
  const v = pointMultiply(unmasked, w1);
  if (!z || !v) {
    // A share built to cancel the password out: the key would not be secret.
    throw new Error('TAPO_TPAP_BAD_DEVICE_SHARE');
  }
  const shareBytes = encodePoint(share);
  const theirBytes = encodePoint(theirs);
  const keys = keySchedule({
    context,
    proverIdentity,
    verifierIdentity,
    proverShare: shareBytes,
    verifierShare: theirBytes,
    z,
    v,
    w0,
  });
  return {
    share: shareBytes,
    confirm: hmac(keys.proverConfirmKey, theirBytes),
    sharedKey: keys.sharedKey,
    verifierConfirmKey: keys.verifierConfirmKey,
    verify: (confirm) => {
      const expected = hmac(keys.verifierConfirmKey, shareBytes);
      return confirm.length === expected.length && crypto.timingSafeEqual(confirm, expected);
    },
  };
}

/**
 * A random scalar in [1, order - 1].
 * @returns {bigint} The scalar.
 * @example
 * randomScalar();
 */
export function randomScalar() {
  for (;;) {
    // 16 extra bytes make the bias of the reduction negligible.
    const candidate = scalarFromWide(crypto.randomBytes(48));
    if (candidate !== 0n) {
      return candidate;
    }
  }
}

/**
 * What stands in for the password, as the device's `extra_crypt` says it
 * stores it. A plug or a bulb names `password_shadow` id 2: the SHA-1 of the
 * password, in hex.
 * @param {string} password - The account password.
 * @param {object|null|undefined} extraCrypt - From `pake_register`.
 * @returns {string} The credential.
 * @example
 * credentialFor('secret', { type: 'password_shadow', params: { passwd_id: 2 } });
 */
export function credentialFor(password, extraCrypt) {
  if (extraCrypt?.type === 'password_shadow' && Number(extraCrypt?.params?.passwd_id) === 2) {
    return crypto.createHash('sha1').update(password, 'utf8').digest('hex');
  }
  throw Object.assign(
    new Error(`TAPO_TPAP_UNSUPPORTED_PASSWORD:${JSON.stringify(extraCrypt ?? null)}`),
    { unsupportedProtocol: true },
  );
}

// --- Session cipher -----------------------------------------------------------

/**
 * The encryption of one TPAP session: AES-128-CCM, 16-byte tag, a 12-byte
 * nonce whose last four bytes are the sequence number.
 * @example
 * const cipher = new TpapCipher(sharedKey, startSeq);
 * const { body, seq } = cipher.encrypt(Buffer.from('{}'));
 */
export class TpapCipher {
  /**
   * @param {Buffer} sharedKey - The SPAKE2+ shared key.
   * @param {number} startSeq - The first sequence number, from `pake_share`.
   */
  constructor(sharedKey, startSeq) {
    this.key = hkdf(sharedKey, 'tp-kdf-salt-aes128-key', 'tp-kdf-info-aes128-key', 16);
    this.nonceBase = hkdf(sharedKey, 'tp-kdf-salt-aes128-iv', 'tp-kdf-info-aes128-iv', 12);
    this.seq = startSeq | 0;
  }

  /**
   * The nonce of one sequence number.
   * @param {number} seq - The sequence number.
   * @returns {Buffer} The 12-byte nonce.
   * @example
   * cipher.nonceFor(42);
   */
  nonceFor(seq) {
    const nonce = Buffer.alloc(12);
    this.nonceBase.copy(nonce, 0, 0, 8);
    nonce.writeInt32BE(seq, 8);
    return nonce;
  }

  /**
   * Encrypt one request under the next sequence number.
   * @param {Buffer} plaintext - The JSON request.
   * @returns {{ body: Buffer, seq: number }} The sequence number, ciphertext
   * and tag; and the sequence number alone.
   * @example
   * cipher.encrypt(Buffer.from('{"method":"get_device_info"}'));
   */
  encrypt(plaintext) {
    const seq = this.seq;
    // A signed 32-bit counter: it wraps rather than overflowing.
    this.seq = (this.seq + 1) | 0;
    const cipher = crypto.createCipheriv('aes-128-ccm', this.key, this.nonceFor(seq), {
      authTagLength: 16,
    });
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const seqBytes = Buffer.alloc(4);
    seqBytes.writeInt32BE(seq, 0);
    return { body: Buffer.concat([seqBytes, ciphertext, cipher.getAuthTag()]), seq };
  }

  /**
   * Decrypt the answer to the request sent under `seq`.
   * @param {Buffer} body - The sequence number, ciphertext and tag.
   * @param {number} seq - The sequence number of the request.
   * @returns {Buffer} The JSON answer.
   * @example
   * cipher.decrypt(answer, seq);
   */
  decrypt(body, seq) {
    if (body.length < 20) {
      throw new Error(`TAPO_TPAP_SHORT_ANSWER:${body.length}`);
    }
    if (body.readInt32BE(0) !== seq) {
      throw new Error('TAPO_TPAP_WRONG_SEQUENCE');
    }
    const decipher = crypto.createDecipheriv('aes-128-ccm', this.key, this.nonceFor(seq), {
      authTagLength: 16,
    });
    decipher.setAuthTag(body.subarray(body.length - 16));
    return Buffer.concat([decipher.update(body.subarray(4, body.length - 16)), decipher.final()]);
  }
}

// --- Transport ----------------------------------------------------------------

/**
 * Read how a device takes TPAP logins from its `tpap` announcement.
 * @param {object} tpap - The `tpap` object of a discover answer or scan reply.
 * @returns {{ port: number, tls: number, pake: number[] }} How to log in.
 * @example
 * readTpapInfo({ tls: 0, pake: [2], port: 80 });
 */
export function readTpapInfo(tpap) {
  const port = Number(tpap?.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !Array.isArray(tpap?.pake)) {
    throw Object.assign(new Error(`TAPO_TPAP_UNREADABLE:${JSON.stringify(tpap)}`), {
      unsupportedProtocol: true,
    });
  }
  return { port, tls: Number(tpap.tls) || 0, pake: tpap.pake.map(Number) };
}

/**
 * A TPAP connection to one device.
 * @example
 * const transport = new TpapTransport({ ip: '192.168.1.30', password });
 * const answer = await transport.send({ method: 'get_device_info' });
 */
export class TpapTransport {
  /**
   * @param {object} options - The connection.
   * @param {string} options.ip - The device address.
   * @param {number} [options.port] - The HTTP port the discover goes to, 80
   * by default.
   * @param {string} options.password - The Tapo account password.
   * @param {number} [options.timeoutMs] - Deadline of each HTTP exchange.
   */
  constructor({ ip, port = 80, password, timeoutMs = 5000 }) {
    this.ip = ip;
    this.httpPort = port;
    this.password = password;
    this.timeoutMs = timeoutMs;
    /** How the device takes logins, from its discover answer. */
    this.info = null;
    /** @type {TpapCipher|null} */
    this.cipher = null;
    this.token = null;
    this.expiresAt = 0;
  }

  /**
   * POST a JSON login message and return its parsed answer.
   * @param {number} port - The port.
   * @param {boolean} secure - Over TLS.
   * @param {object} body - The message.
   * @returns {Promise<{ status: number, json: object|null }>} The answer.
   * @example
   * await transport.postJson(80, false, { method: 'login' });
   */
  async postJson(port, secure, body) {
    const answer = await post({
      host: this.ip,
      port,
      secure,
      path: '/',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      timeoutMs: this.timeoutMs,
    });
    let json = null;
    try {
      json = JSON.parse(answer.body.toString('utf8'));
    } catch {
      // Not JSON: left to the caller, which knows what the status means.
    }
    return { status: answer.status, json };
  }

  /**
   * Ask the device whether it is in TPAP mode.
   * @returns {Promise<{ port: number, tls: number, pake: number[] }|null>} How
   * to log in, or null for a device that is not in TPAP mode.
   * @example
   * await transport.discover();
   */
  async discover() {
    const { status, json } = await this.postJson(this.httpPort, false, {
      method: 'login',
      params: { sub_method: 'discover' },
    });
    if (status !== 200 || !json) {
      return null;
    }
    if (json.error_code === ERROR_CODES.LOCKED) {
      throw Object.assign(new Error('TAPO_TPAP_LOCKED'), { authFailed: true });
    }
    const tpap = json.error_code === 0 ? json.result?.tpap : null;
    return tpap && typeof tpap === 'object' ? readTpapInfo(tpap) : null;
  }

  /**
   * One step of the login.
   * @param {string} subMethod - `pake_register` or `pake_share`.
   * @param {object} params - Its parameters.
   * @returns {Promise<object>} Its result.
   * @example
   * await transport.login('pake_register', params);
   */
  async login(subMethod, params) {
    const { status, json } = await this.postJson(this.info.port, this.info.tls === 1, {
      method: 'login',
      params: { sub_method: subMethod, ...params },
    });
    if (status !== 200 || !json) {
      throw new Error(`TAPO_TPAP_${subMethod.toUpperCase()}_HTTP_${status}`);
    }
    if (json.error_code === ERROR_CODES.LOCKED) {
      throw Object.assign(new Error('TAPO_TPAP_LOCKED'), { authFailed: true });
    }
    if (
      subMethod === 'pake_share' &&
      (json.error_code === ERROR_CODES.WRONG_PASSWORD ||
        json.error_code === ERROR_CODES.WRONG_PASSWORD_CAMERA)
    ) {
      throw Object.assign(new Error('TAPO_SMART_BAD_CREDENTIALS'), { authFailed: true });
    }
    if (json.error_code !== 0 || !json.result) {
      throw new Error(`TAPO_TPAP_${subMethod.toUpperCase()}_FAILED:${json.error_code}`);
    }
    return json.result;
  }

  /**
   * Log in and open a session.
   * @returns {Promise<void>} Resolves once the session is usable.
   * @example
   * await transport.handshake();
   */
  async handshake() {
    this.cipher = null;
    if (!this.info) {
      this.info = await this.discover();
      if (!this.info) {
        throw Object.assign(new Error('TAPO_TPAP_NOT_ANNOUNCED'), { notTpap: true });
      }
    }
    // The Tapo app logs in with the device's default passcode whenever it
    // takes one, which is not documented: only the account password is
    // supported, and only over plain HTTP or TLS without verification.
    if (!this.info.pake.includes(2) || this.info.pake.includes(0) || this.info.tls > 1) {
      throw Object.assign(new Error(`TAPO_TPAP_UNSUPPORTED:${JSON.stringify(this.info)}`), {
        unsupportedProtocol: true,
      });
    }

    const userRandom = crypto.randomBytes(32);
    const registration = await this.login('pake_register', {
      // Always the `admin` user, never the account email.
      username: crypto.createHash('md5').update('admin').digest('hex'),
      user_random: userRandom.toString('base64'),
      cipher_suites: [CIPHER_SUITE],
      encryption: [ENCRYPTION],
      passcode_type: 'userpw',
    });
    const iterations = Number(registration.iterations);
    const deviceRandom = Buffer.from(String(registration.dev_random || ''), 'base64');
    if (
      registration.cipher_suites !== CIPHER_SUITE ||
      registration.encryption !== ENCRYPTION ||
      !Number.isInteger(iterations) ||
      iterations < 1 ||
      iterations > MAX_ITERATIONS ||
      deviceRandom.length !== 32
    ) {
      throw Object.assign(
        new Error(
          `TAPO_TPAP_UNSUPPORTED_REGISTRATION:${registration.cipher_suites}:${registration.encryption}:${registration.iterations}`,
        ),
        { unsupportedProtocol: true },
      );
    }

    const credential = credentialFor(this.password, registration.extra_crypt);
    const { w0, w1 } = await deriveW0W1(
      credential,
      Buffer.from(String(registration.dev_salt || ''), 'base64'),
      iterations,
    );
    const proof = prove({
      w0,
      w1,
      x: randomScalar(),
      context: crypto
        .createHash('sha256')
        .update(Buffer.concat([Buffer.from('PAKE V1'), userRandom, deviceRandom]))
        .digest(),
      verifierShare: Buffer.from(String(registration.dev_share || ''), 'base64'),
    });

    const shared = await this.login('pake_share', {
      user_share: proof.share.toString('base64'),
      user_confirm: proof.confirm.toString('base64'),
    });
    if (!proof.verify(Buffer.from(String(shared.dev_confirm || ''), 'base64'))) {
      // The device does not hold the same password: nothing it sends could be
      // trusted.
      throw Object.assign(new Error('TAPO_TPAP_DEVICE_CONFIRM_MISMATCH'), { authFailed: true });
    }
    if (!shared.stok || !Number.isInteger(Number(shared.start_seq))) {
      throw new Error('TAPO_TPAP_NO_SESSION');
    }
    const lifetimeSeconds = Number(shared.expired);
    const lifetime =
      Number.isFinite(lifetimeSeconds) && lifetimeSeconds > 0
        ? lifetimeSeconds * 1000
        : DEFAULT_SESSION_MS;
    this.expiresAt = Date.now() + Math.max(60 * 1000, lifetime - SESSION_MARGIN_MS);
    this.token = String(shared.stok);
    this.cipher = new TpapCipher(proof.sharedKey, Number(shared.start_seq));
  }

  /**
   * Send one request and return the parsed answer.
   * @param {object} request - The JSON request (`{ method, params }`).
   * @returns {Promise<object>} The answer (`{ error_code, result }`).
   * @example
   * await transport.send({ method: 'get_device_info' });
   */
  async send(request) {
    if (!this.cipher || Date.now() >= this.expiresAt) {
      await this.handshake();
    }
    const { body, seq } = this.cipher.encrypt(Buffer.from(JSON.stringify(request), 'utf8'));
    const answer = await post({
      host: this.ip,
      port: this.info.port,
      secure: this.info.tls === 1,
      path: `/stok=${this.token}/ds`,
      body,
      headers: { 'Content-Type': 'application/octet-stream' },
      timeoutMs: this.timeoutMs,
    });
    if (answer.status === 401 || answer.status === 403) {
      this.cipher = null;
      throw Object.assign(new Error('TAPO_SMART_SESSION_EXPIRED'), { retryable: true });
    }
    if (answer.status !== 200) {
      throw new Error(`TAPO_TPAP_HTTP_${answer.status}`);
    }
    let plaintext;
    try {
      plaintext = this.cipher.decrypt(answer.body, seq);
    } catch (e) {
      // A device that no longer knows the session answers an error code in
      // plain JSON, whichever code that is.
      let code = null;
      try {
        code = JSON.parse(answer.body.toString('utf8')).error_code;
      } catch {
        // Not JSON either: a real decryption failure.
      }
      if (Number.isInteger(code) && code !== 0) {
        this.cipher = null;
        throw Object.assign(new Error('TAPO_SMART_SESSION_EXPIRED'), { retryable: true });
      }
      throw new Error(`TAPO_TPAP_UNDECRYPTABLE:${e.message}`, { cause: e });
    }
    return JSON.parse(plaintext.toString('utf8'));
  }

  /**
   * Forget the session; the next request logs in again. How the device takes
   * logins is kept.
   * @example
   * transport.reset();
   */
  reset() {
    this.cipher = null;
  }
}
