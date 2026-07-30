import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TapoMediaSession, parseAuthChallenge } from '../src/tapo/stream/mediaSession.js';
import { AesHelper } from '../src/tapo/stream/aesHelper.js';
import { TS_PACKET_SIZE, TS_SYNC_BYTE, DEVICE_BOUNDARY } from '../src/tapo/constants.js';

/**
 * Build a session wired to a fake socket, so the state machine can be driven
 * without a camera.
 * @returns {object} The session and what it wrote.
 * @example
 * const { session, written } = buildSession();
 */
function buildSession() {
  const session = new TapoMediaSession({ ip: '127.0.0.1', password: 'pwd' });
  const written = [];
  session.socket = {
    write: (data) => written.push(Buffer.isBuffer(data) ? data.toString() : data),
    destroy: () => {},
  };
  return { session, written };
}

test('the digest challenge is parsed into its fields', () => {
  const challenge = parseAuthChallenge('Digest realm="AXIS", nonce="abc", encrypt_type="3"');
  assert.equal(challenge.realm, 'AXIS');
  assert.equal(challenge.nonce, 'abc');
  assert.equal(challenge.encrypt_type, '3');
});

test('the challenge is answered with an Authorization header', () => {
  const { session, written } = buildSession();
  session.onData(
    Buffer.from(
      'HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Digest realm="R", nonce="N"\r\n\r\n',
    ),
  );
  assert.equal(session.phase, 'keyexchange');
  const request = written.join('');
  assert.match(request, /Authorization: Digest username="admin"/);
  assert.match(request, /qop=auth/);
  assert.match(request, /uri="\/stream"/);
});

test('encrypt_type=3 switches the password hashing to sha256', () => {
  // Recent firmwares only accept sha256; guessing md5 gets a 401 forever.
  const { session } = buildSession();
  session.onData(
    Buffer.from(
      'HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Digest realm="R", nonce="N", encrypt_type="3"\r\n\r\n',
    ),
  );
  assert.equal(session.encryptionMethod, 'sha256');
});

test('a response split across TCP chunks is still parsed', () => {
  // TCP delivers arbitrary slices: a header cut in half must not be lost.
  const { session } = buildSession();
  const response =
    'HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Digest realm="R", nonce="N"\r\n\r\n';
  session.onData(Buffer.from(response.slice(0, 30)));
  assert.equal(session.phase, 'auth', 'nothing consumed while incomplete');
  session.onData(Buffer.from(response.slice(30)));
  assert.equal(session.phase, 'keyexchange');
});

test('a missing challenge is reported instead of hanging', () => {
  const { session } = buildSession();
  const errors = [];
  session.on('error', (e) => errors.push(e.message));
  session.onData(Buffer.from('HTTP/1.1 401 Unauthorized\r\nServer: x\r\n\r\n'));
  assert.deepEqual(errors, ['TAPO_STREAM_NO_AUTH_CHALLENGE']);
});

test('a non-200 key exchange surfaces the HTTP status', () => {
  // A 401 here is the signature of a model that blocks local access (C610).
  const { session } = buildSession();
  const errors = [];
  session.on('error', (e) => errors.push(e.message));
  session.phase = 'keyexchange';
  session.onData(Buffer.from('HTTP/1.1 401 Unauthorized\r\nServer: x\r\n\r\n'));
  assert.deepEqual(errors, ['TAPO_STREAM_HTTP_401']);
});

test('the key exchange sets up AES and requests the stream', () => {
  const { session, written } = buildSession();
  session.phase = 'keyexchange';
  session.onData(
    Buffer.from(
      'HTTP/1.1 200 OK\r\nKey-Exchange: nonce="abcdef" username="admin"\r\nContent-Type: multipart/mixed;boundary=--custom--\r\n\r\n',
    ),
  );
  assert.equal(session.phase, 'streaming');
  assert.ok(session.aes, 'the AES helper must be ready');
  // The camera may name its own boundary; using the default would desync parsing.
  assert.equal(session.deviceBoundary, '--custom--');
  assert.match(written.join(''), /X-Data-Window-Size: 50/);
});

test('the MPEG-TS stream is re-aligned to whole 188-byte packets', () => {
  const { session } = buildSession();
  const packets = [];
  session.on('packet', (packet) => packets.push(packet));

  // Leading garbage before the first sync byte, then two whole packets.
  const first = Buffer.alloc(TS_PACKET_SIZE, 1);
  first[0] = TS_SYNC_BYTE;
  const second = Buffer.alloc(TS_PACKET_SIZE, 2);
  second[0] = TS_SYNC_BYTE;
  session.forwardTsPackets(Buffer.concat([Buffer.from([0x00, 0x11]), first, second]));

  assert.equal(packets.length, 2);
  assert.ok(
    packets.every((packet) => packet.length === TS_PACKET_SIZE && packet[0] === TS_SYNC_BYTE),
  );
});

test('a partial packet is kept until the rest arrives', () => {
  const { session } = buildSession();
  const packets = [];
  session.on('packet', (packet) => packets.push(packet));

  const packet = Buffer.alloc(TS_PACKET_SIZE, 7);
  packet[0] = TS_SYNC_BYTE;
  session.forwardTsPackets(packet.subarray(0, 100));
  assert.equal(packets.length, 0, 'an incomplete packet must not be emitted');
  session.forwardTsPackets(packet.subarray(100));
  assert.equal(packets.length, 1);
  assert.deepEqual(packets[0], packet);
});

test('an encrypted video part is decrypted and forwarded', () => {
  const { session } = buildSession();
  session.phase = 'streaming';
  session.deviceBoundary = DEVICE_BOUNDARY;
  session.aes = new AesHelper({
    username: Buffer.from('admin'),
    nonce: Buffer.from('abcdef'),
    cloudPassword: Buffer.from('pwd'),
    encryptionMethod: 'md5',
  });

  const packet = Buffer.alloc(TS_PACKET_SIZE, 3);
  packet[0] = TS_SYNC_BYTE;
  const body = session.aes.encrypt(packet);

  const packets = [];
  session.on('packet', (received) => packets.push(received));
  session.onData(
    Buffer.concat([
      Buffer.from(
        `${DEVICE_BOUNDARY}\r\nContent-Type: video/mp2t\r\nX-If-Encrypt: 1\r\nX-Session-Id: 1\r\nContent-Length: ${body.length}\r\n\r\n`,
      ),
      body,
    ]),
  );

  assert.equal(packets.length, 1);
  assert.deepEqual(packets[0], packet);
});

test('a part with no Content-Length is skipped without spinning', () => {
  // Guards the parsing loop: a malformed part must not become an infinite loop.
  const { session } = buildSession();
  session.phase = 'streaming';
  session.deviceBoundary = DEVICE_BOUNDARY;
  session.onData(Buffer.from(`${DEVICE_BOUNDARY}\r\nContent-Type: video/mp2t\r\n\r\n`));
  assert.equal(session.buffer.length, 0);
});

test('the handshake timeout rejects and closes the session', async () => {
  const session = new TapoMediaSession({ ip: '192.0.2.1', password: 'p' });
  // 192.0.2.0/24 is the documentation range: the connection never completes.
  await assert.rejects(() => session.start(100), /TAPO_STREAM_TIMEOUT/);
  assert.equal(session.socket, null);
});
