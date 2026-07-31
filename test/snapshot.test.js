import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureImage, extractFfmpegReason } from '../src/tapo/snapshot.js';
import { normalizeConfig } from '../src/config.js';
import { CAPTURE_MODES, IMAGE_MAX_BYTES } from '../src/tapo/constants.js';

const config = normalizeConfig({
  email: 'a@b.c',
  password: 'x',
  rtsp_username: 'user',
  rtsp_password: 'pass',
  capture_timeout: 5,
});

test('a camera with no known IP fails before spawning ffmpeg', async () => {
  await assert.rejects(
    () => captureImage({ name: 'X', ip: '', captureMode: CAPTURE_MODES.RTSP }, config),
    /TAPO_CAMERA_IP_UNKNOWN/,
  );
});

test('an unreachable RTSP camera reports that no image came out', async () => {
  // 192.0.2.0/24 is the documentation range: nothing answers there.
  const camera = { name: 'Ghost', ip: '192.0.2.1', captureMode: CAPTURE_MODES.RTSP };
  await assert.rejects(
    () => captureImage(camera, { ...config, capture_timeout: 5 }),
    // Either ffmpeg is missing from the test machine, or it produced nothing.
    /TAPO_NO_IMAGE_CAPTURED|FFMPEG_NOT_FOUND/,
  );
});

test('the size limit is the base64 length, not the raw JPEG length', () => {
  // base64 inflates by ~4/3: checking the raw length would let images through
  // that Gladys then rejects.
  const raw = Buffer.alloc(80 * 1024);
  assert.ok(raw.length < IMAGE_MAX_BYTES, 'the raw buffer is under the limit');
  assert.ok(
    Buffer.byteLength(raw.toString('base64')) > IMAGE_MAX_BYTES,
    'but its base64 form is over it, which is what Gladys measures',
  );
});

test('the limit stays under what the HTTP layer actually accepts', () => {
  // Gladys mounts express.json() with no `limit`, so the 100 KB Express default
  // rejects the request with PayloadTooLargeError long before the documented
  // 150 KB application check runs. Publishing was failing for exactly this.
  const EXPRESS_DEFAULT_LIMIT = 100 * 1024;
  assert.ok(
    IMAGE_MAX_BYTES < EXPRESS_DEFAULT_LIMIT,
    `IMAGE_MAX_BYTES must stay under the ${EXPRESS_DEFAULT_LIMIT} byte HTTP limit`,
  );
  // And leave room for the JSON envelope wrapped around the image.
  assert.ok(
    EXPRESS_DEFAULT_LIMIT - IMAGE_MAX_BYTES >= 1024,
    'too tight a margin for the JSON envelope',
  );
});

test('a 401 is explained as a camera account problem', () => {
  // The failure users actually hit: the camera account is not the Tapo account.
  const reason = extractFfmpegReason('method DESCRIBE failed: 401 (Unauthorized)');
  assert.match(reason, /camera account/);
});

test('an unreachable camera is told apart from a credentials problem', () => {
  assert.match(extractFfmpegReason('Connection refused'), /did not answer/);
  assert.match(extractFfmpegReason('Connection timed out'), /did not answer/);
});

test('a 404 points at a camera without an RTSP stream', () => {
  assert.match(extractFfmpegReason('method DESCRIBE failed: 404 Not Found'), /no RTSP stream/);
});

test('an unknown error falls back to the last meaningful line', () => {
  // The ffmpeg banner must never be what the user reads.
  const stderr = 'ffmpeg version 8.1.2\n  libavutil 60\n  built with gcc\nSomething odd happened';
  assert.equal(extractFfmpegReason(stderr), 'Something odd happened');
});

test('an empty stderr yields no reason rather than a misleading one', () => {
  assert.equal(extractFfmpegReason(''), '');
});

test('the ffmpeg banner is never mistaken for the reason', () => {
  // What the user actually saw: the build flags reported as the cause.
  const banner = [
    'ffmpeg version 8.1.2 Copyright (c) 2000-2026 the FFmpeg developers',
    '  built with gcc 15',
    '  configuration: --prefix=/usr --disable-librtmp --enable-gpl',
    '  libavutil 60. 13.100',
  ].join('\n');
  assert.equal(extractFfmpegReason(banner), '');
});

test('the banner is suppressed at the source', async () => {
  // Filtering it out is a safety net; not printing it is the real fix, since a
  // long banner pushes the actual error out of the captured stderr.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/tapo/snapshot.js', import.meta.url), 'utf-8');
  assert.match(source, /-hide_banner/);
  assert.match(source, /'-loglevel',\s*'error'/);
});

test('the fallback steps trade resolution, not just quality', async () => {
  // Quality alone plateaus: measured, going from qscale 8 to 24 only sheds ~30 %,
  // which leaves a detailed scene a few hundred bytes above the limit forever.
  // Shrinking the frame is what actually gets under it.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/tapo/snapshot.js', import.meta.url), 'utf-8');
  const steps = /const CAPTURE_STEPS = \[([\s\S]*?)\];/.exec(source);
  assert.ok(steps, 'CAPTURE_STEPS must be declared');

  const widths = [...steps[1].matchAll(/\[\s*(IMAGE_WIDTH|\d+)\s*,/g)].map((m) => m[1]);
  assert.ok(widths.length >= 3, 'at least three fallback steps');
  // The last step must be narrower than the first, or the retries are pointless.
  assert.notEqual(widths[widths.length - 1], widths[0], 'the last step must shrink the frame');
});
