// -----------------------------------------------------------------------------
// AES-128-CBC key derivation of the Tapo media stream.
//
// A Node.js port of pytapo's `media_stream/crypto.py`. The camera derives the key
// and the IV from the Key-Exchange header it sends, so both sides must agree on
// the exact same recipe — every concatenation and hash below is protocol, not a
// design choice.
//
// Built on Node's crypto module only: no extra dependency, and MD5 here is what
// the firmware mandates, not a security decision of ours.
// -----------------------------------------------------------------------------

import crypto from 'node:crypto';
import { SUPER_SECRET_KEY, ENCRYPTION_METHODS } from '../constants.js';

/**
 * Hash a password the way the Tapo media stream expects it: the digest is the
 * UPPERCASE hex representation of the hash, taken as bytes.
 * @param {Buffer} toHash - The bytes to hash (the cloud or camera password).
 * @param {string} encryptionMethod - 'md5' or 'sha256'.
 * @returns {Buffer} The uppercase hex digest, as bytes.
 * @example
 * pwdDigest(Buffer.from('secret'), 'md5');
 */
export function pwdDigest(toHash, encryptionMethod) {
  if (
    encryptionMethod !== ENCRYPTION_METHODS.MD5 &&
    encryptionMethod !== ENCRYPTION_METHODS.SHA256
  ) {
    throw new Error(`TAPO_UNKNOWN_HASH_METHOD:${encryptionMethod}`);
  }
  return Buffer.from(
    crypto.createHash(encryptionMethod).update(toHash).digest('hex').toUpperCase(),
  );
}

/**
 * MD5 digest returning raw bytes (the key and IV are raw 16-byte digests).
 * @param {Buffer} data - The bytes to hash.
 * @returns {Buffer} The 16-byte digest.
 * @example
 * md5(Buffer.from('hello'));
 */
export function md5(data) {
  return crypto.createHash('md5').update(data).digest();
}

/**
 * Parse a `key="value" key2="value2"` header into a plain object.
 * @param {string} raw - The raw header value.
 * @returns {Record<string, string>} The parsed pairs.
 * @example
 * parseKeyValueHeader('username="admin" nonce="ab12"');
 */
function parseKeyValueHeader(raw) {
  /** @type {Record<string, string>} */
  const parsed = {};
  raw.split(' ').forEach((part) => {
    const eqIndex = part.indexOf('=');
    if (eqIndex === -1) {
      return;
    }
    const key = part.slice(0, eqIndex).trim().replace(/"/g, '');
    const value = part
      .slice(eqIndex + 1)
      .trim()
      .replace(/"/g, '');
    parsed[key] = value;
  });
  return parsed;
}

/**
 * Encryption helper of one media session: holds the derived key and IV, and
 * encrypts or decrypts the multipart bodies exchanged with the camera.
 * @example
 * const aes = new AesHelper({ username, nonce, cloudPassword, encryptionMethod });
 */
export class AesHelper {
  /**
   * @param {object} options - The key derivation inputs.
   * @param {Buffer} options.username - The username from the Key-Exchange header.
   * @param {Buffer} options.nonce - The nonce from the Key-Exchange header.
   * @param {Buffer} options.cloudPassword - The cloud or camera password.
   * @param {string} options.encryptionMethod - 'md5' or 'sha256'.
   * @param {Buffer} [options.superSecretKey] - Firmware key, used when media
   * encryption is off.
   */
  constructor({ username, nonce, cloudPassword, encryptionMethod, superSecretKey }) {
    if (!nonce || nonce.length === 0) {
      throw new Error('TAPO_NONCE_MISSING');
    }
    this.nonce = nonce;

    if (username.equals(Buffer.from('none'))) {
      // Media encryption is off: the camera uses the hardcoded firmware key
      // instead of the account password.
      const secret =
        superSecretKey && superSecretKey.length > 0
          ? superSecretKey
          : Buffer.from(SUPER_SECRET_KEY);
      this.key = md5(Buffer.concat([nonce, Buffer.from(':'), secret]));
    } else {
      const hashedPassword = pwdDigest(cloudPassword, encryptionMethod);
      this.key = md5(Buffer.concat([nonce, Buffer.from(':'), hashedPassword]));
    }

    this.iv = md5(Buffer.concat([username, Buffer.from(':'), nonce]));
  }

  /**
   * Build a helper from the raw Key-Exchange header value.
   * @param {Buffer} keyExchange - The header value.
   * @param {Buffer} cloudPassword - The cloud or camera password.
   * @param {Buffer} superSecretKey - The firmware key (may be empty).
   * @param {string} encryptionMethod - 'md5' or 'sha256'.
   * @returns {AesHelper} The configured helper.
   * @example
   * AesHelper.fromKeyExchange(header, Buffer.from('pwd'), Buffer.from(''), 'md5');
   */
  static fromKeyExchange(keyExchange, cloudPassword, superSecretKey, encryptionMethod) {
    const parsed = parseKeyValueHeader(keyExchange.toString());
    if (parsed.nonce === undefined) {
      throw new Error('TAPO_NONCE_MISSING');
    }
    return new AesHelper({
      username: Buffer.from(parsed.username || ''),
      nonce: Buffer.from(parsed.nonce),
      cloudPassword,
      encryptionMethod,
      superSecretKey,
    });
  }

  /**
   * Decrypt one body. A fresh decipher is created every time: the protocol reuses
   * the same IV for each block rather than chaining them, like pytapo does.
   * @param {Buffer} data - The ciphertext.
   * @returns {Buffer} The plaintext.
   * @example
   * aes.decrypt(ciphertext);
   */
  decrypt(data) {
    const decipher = crypto.createDecipheriv('aes-128-cbc', this.key, this.iv);
    decipher.setAutoPadding(true);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  }

  /**
   * Encrypt one body.
   * @param {Buffer} data - The plaintext.
   * @returns {Buffer} The ciphertext.
   * @example
   * aes.encrypt(Buffer.from('{}'));
   */
  encrypt(data) {
    const cipher = crypto.createCipheriv('aes-128-cbc', this.key, this.iv);
    cipher.setAutoPadding(true);
    return Buffer.concat([cipher.update(data), cipher.final()]);
  }
}
