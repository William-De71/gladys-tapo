import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { AesHelper, pwdDigest, md5 } from '../src/tapo/stream/aesHelper.js';
import { SUPER_SECRET_KEY } from '../src/tapo/constants.js';

test('the password digest is the uppercase hex of the hash', () => {
  // The camera derives its key from this exact representation: lowercase hex
  // would produce a different key and silently fail to decrypt.
  const digest = pwdDigest(Buffer.from('secret'), 'md5').toString();
  assert.equal(digest, crypto.createHash('md5').update('secret').digest('hex').toUpperCase());
  assert.match(digest, /^[0-9A-F]+$/);
});

test('sha256 is supported, and an unknown method is rejected', () => {
  // A recent firmware advertises encrypt_type=3 and needs sha256.
  assert.equal(pwdDigest(Buffer.from('x'), 'sha256').length, 64);
  assert.throws(() => pwdDigest(Buffer.from('x'), 'sha1'), /TAPO_UNKNOWN_HASH_METHOD/);
});

test('the key and iv follow the protocol recipe', () => {
  const nonce = Buffer.from('abcdef');
  const username = Buffer.from('admin');
  const password = Buffer.from('pwd');
  const aes = new AesHelper({ username, nonce, cloudPassword: password, encryptionMethod: 'md5' });

  const expectedKey = md5(Buffer.concat([nonce, Buffer.from(':'), pwdDigest(password, 'md5')]));
  const expectedIv = md5(Buffer.concat([username, Buffer.from(':'), nonce]));
  assert.deepEqual(aes.key, expectedKey);
  assert.deepEqual(aes.iv, expectedIv);
  // AES-128 needs exactly 16 bytes for both.
  assert.equal(aes.key.length, 16);
  assert.equal(aes.iv.length, 16);
});

test('the username "none" switches to the hardcoded firmware key', () => {
  // Media encryption off: the password plays no part, the firmware key does.
  const nonce = Buffer.from('abcdef');
  const aes = new AesHelper({
    username: Buffer.from('none'),
    nonce,
    cloudPassword: Buffer.from('ignored'),
    encryptionMethod: 'md5',
  });
  const expected = md5(Buffer.concat([nonce, Buffer.from(':'), Buffer.from(SUPER_SECRET_KEY)]));
  assert.deepEqual(aes.key, expected);
});

test('a missing nonce is refused instead of deriving a wrong key', () => {
  assert.throws(
    () =>
      new AesHelper({
        username: Buffer.from('admin'),
        nonce: Buffer.alloc(0),
        cloudPassword: Buffer.from('p'),
        encryptionMethod: 'md5',
      }),
    /TAPO_NONCE_MISSING/,
  );
});

test('encrypt and decrypt round-trip a payload', () => {
  const aes = new AesHelper({
    username: Buffer.from('admin'),
    nonce: Buffer.from('12345678'),
    cloudPassword: Buffer.from('pwd'),
    encryptionMethod: 'md5',
  });
  const plaintext = Buffer.from(JSON.stringify({ type: 'request', seq: 1234 }));
  assert.deepEqual(aes.decrypt(aes.encrypt(plaintext)), plaintext);
});

test('the helper is built from the Key-Exchange header', () => {
  const header = Buffer.from('nonce="abcdef" username="admin"');
  const aes = AesHelper.fromKeyExchange(header, Buffer.from('pwd'), Buffer.from(''), 'md5');
  const direct = new AesHelper({
    username: Buffer.from('admin'),
    nonce: Buffer.from('abcdef'),
    cloudPassword: Buffer.from('pwd'),
    encryptionMethod: 'md5',
  });
  assert.deepEqual(aes.key, direct.key);
  assert.deepEqual(aes.iv, direct.iv);
});

test('a Key-Exchange header without a nonce is rejected', () => {
  assert.throws(
    () =>
      AesHelper.fromKeyExchange(
        Buffer.from('username="admin"'),
        Buffer.from('p'),
        Buffer.from(''),
        'md5',
      ),
    /TAPO_NONCE_MISSING/,
  );
});
