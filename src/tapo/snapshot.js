// -----------------------------------------------------------------------------
// Image capture.
//
// Both capture modes end in the same place: one JPEG frame, encoded as the
// `image/jpg;base64,...` string Gladys expects, under 150 KB.
//
//   RTSP        -> ffmpeg reads the stream directly.
//   proprietary -> a media session decrypts the MPEG-TS and pipes it to ffmpeg's
//                  stdin (see stream/mediaSession.js).
//
// Nothing is written to disk: the frame comes back on ffmpeg's stdout. The
// sandbox mounts the rootfs read-only, and a JPEG in memory is cheaper than a
// temporary file anyway.
// -----------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { logger } from '@gladysassistant/integration-sdk';
import { TapoMediaSession } from './stream/mediaSession.js';
import { buildRtspUrl } from './rtsp.js';
import {
  CAPTURE_MODES,
  IMAGE_MAX_BYTES,
  IMAGE_WIDTH,
  HANDSHAKE_TIMEOUT_MS,
  PROPRIETARY_BYTES_PER_FRAME,
} from './constants.js';

/**
 * Fallback steps, tried in order until the payload fits, as
 * `[width, -qscale:v]` pairs (qscale: 2 = best, 31 = worst).
 *
 * Quality alone is not enough: past `-qscale:v 15` the returns collapse
 * (measured: 8 -> 24 only sheds ~30 %), and a detailed outdoor scene can stay
 * a few hundred bytes above the limit no matter how far the quality drops.
 * Halving the pixel count is the effective lever, so the steps trade resolution
 * once quality has done what it can.
 */
const CAPTURE_STEPS = [
  [IMAGE_WIDTH, 8],
  [IMAGE_WIDTH, 15],
  [1024, 12],
  [1024, 20],
  [800, 15],
];

/**
 * Turn ffmpeg's stderr into one actionable sentence.
 *
 * ffmpeg dumps its whole banner before failing, and the useful line sits at the
 * very end. The two failures that actually happen in the field — wrong camera
 * account, unreachable camera — deserve a plain explanation rather than a raw
 * protocol error.
 * @param {string} stderr - What ffmpeg wrote on stderr.
 * @returns {string} The reason, or an empty string when nothing stands out.
 * @example
 * extractFfmpegReason('... 401 Unauthorized'); // 'the camera account is wrong…'
 */
export function extractFfmpegReason(stderr) {
  const text = String(stderr || '');
  if (/401|[Uu]nauthorized/.test(text)) {
    return 'the camera rejected the credentials — check the camera account (Tapo app > Camera settings > Advanced settings > Camera account), which is NOT your Tapo account';
  }
  if (/404|[Nn]ot [Ff]ound/.test(text)) {
    return 'the camera has no stream at this path — it probably exposes no RTSP stream';
  }
  if (/Connection refused|No route to host|timed out|Connection timed out/i.test(text)) {
    return 'the camera did not answer — check that it is powered on and reachable from Gladys';
  }
  // Fall back to the last meaningful line, which is where ffmpeg states the
  // cause. Everything the startup banner prints has to be filtered out, or the
  // "reason" ends up being the build flags — which say nothing about the failure.
  const lastLine = text
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith('lib') &&
        !line.startsWith('built with') &&
        !line.startsWith('configuration:') &&
        !line.startsWith('ffmpeg version') &&
        !line.startsWith('Copyright'),
    )
    .pop();
  return lastLine ? lastLine.slice(0, 200) : '';
}

/**
 * Run ffmpeg and resolve with the JPEG it writes to stdout.
 * @param {string[]} args - The ffmpeg arguments, without the output target.
 * @param {object} options - The run options.
 * @param {number} options.timeoutMs - Kill ffmpeg after this delay.
 * @param {(stdin: import('node:stream').Writable) => void} [options.onStdin] -
 * Called with ffmpeg's stdin when the input is piped.
 * @returns {Promise<Buffer>} The JPEG bytes.
 * @example
 * await runFfmpeg(['-i', 'rtsp://...'], { timeoutMs: 12000 });
 */
function runFfmpeg(args, { timeoutMs, onStdin }) {
  return new Promise((resolve, reject) => {
    // `-` writes the image to stdout, `image2pipe` is the format that allows it.
    const ffmpeg = spawn('ffmpeg', [...args, '-f', 'image2pipe', '-vcodec', 'mjpeg', '-']);

    /** @type {Buffer[]} */
    const chunks = [];
    let stderr = '';
    let settled = false;

    let timedOut = false;
    const timer = setTimeout(() => {
      // SIGKILL: a stalled ffmpeg reading a dead stream ignores SIGTERM.
      timedOut = true;
      ffmpeg.kill('SIGKILL');
    }, timeoutMs);

    /**
     * Settle once, whatever happens first.
     * @param {Error|null} error - The failure, or null on success.
     * @param {Buffer} [image] - The captured image.
     * @example
     * settle(null, buffer);
     */
    const settle = (error, image) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve(image);
      }
    };

    ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
    ffmpeg.stderr.on('data', (chunk) => {
      // Keep only the tail: ffmpeg's banner is long and the cause is at the end.
      stderr = (stderr + chunk.toString()).slice(-2000);
    });

    ffmpeg.on('error', (e) => {
      settle(
        new Error(e.code === 'ENOENT' ? 'FFMPEG_NOT_FOUND' : `FFMPEG_SPAWN_FAILED:${e.message}`),
      );
    });

    ffmpeg.on('close', (code) => {
      const image = Buffer.concat(chunks);
      // ffmpeg may exit non-zero after a complete frame (the input dies once the
      // frame is out), so trust the bytes over the exit code.
      if (image.length > 0) {
        settle(null, image);
        return;
      }
      // The reason is promoted into the error itself: left in the debug log, it
      // would make a failed capture undiagnosable. A killed ffmpeg never got to
      // explain itself, so the timeout is reported directly instead.
      const reason = timedOut
        ? `the camera did not deliver an image within ${Math.round(timeoutMs / 1000)}s`
        : extractFfmpegReason(stderr);
      logger.debug(`ffmpeg produced no image (code ${code}): ${stderr.slice(-500)}`);
      settle(new Error(reason ? `TAPO_NO_IMAGE_CAPTURED: ${reason}` : 'TAPO_NO_IMAGE_CAPTURED'));
    });

    if (onStdin) {
      // A closed pipe when ffmpeg exits first is expected, not a failure.
      ffmpeg.stdin.on('error', () => {});
      onStdin(ffmpeg.stdin);
    }
  });
}

/**
 * Build the ffmpeg arguments shared by both modes.
 * @param {string} input - The input URL, or '-' for stdin.
 * @param {number} quality - The `-qscale:v` value.
 * @param {boolean} isRtsp - True to force the RTSP transport flags.
 * @returns {string[]} The arguments.
 * @example
 * buildArgs('rtsp://camera/stream1', 8, true);
 */
function buildArgs(input, quality, isRtsp, width = IMAGE_WIDTH) {
  // `-loglevel error` silences the startup banner (version, build flags, codec
  // list): it would otherwise fill the captured stderr and push the actual error
  // out of it, leaving the failure unexplainable.
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (isRtsp) {
    // TCP avoids the band of green pixels UDP packet loss produces.
    args.push('-rtsp_transport', 'tcp');
  }
  args.push(
    '-i',
    input,
    // Drop the audio track: a snapshot has no use for it.
    '-an',
    '-frames:v',
    '1',
    '-qscale:v',
    String(quality),
    '-vf',
    `scale=${width}:-1`,
  );
  return args;
}

/**
 * Capture one frame from an RTSP camera.
 * @param {object} camera - The resolved camera.
 * @param {object} config - The normalized configuration.
 * @param {number} quality - The JPEG quality step.
 * @returns {Promise<Buffer>} The JPEG bytes.
 * @example
 * await captureRtsp(camera, config, 8);
 */
function captureRtsp(camera, config, quality, width) {
  const url = buildRtspUrl(camera, config);
  return runFfmpeg(buildArgs(url, quality, true, width), {
    timeoutMs: config.capture_timeout * 1000,
  });
}

/**
 * Capture one frame from a camera that has no RTSP stream, through the
 * proprietary protocol.
 * @param {object} camera - The resolved camera.
 * @param {object} config - The normalized configuration.
 * @param {number} quality - The JPEG quality step.
 * @returns {Promise<Buffer>} The JPEG bytes.
 * @example
 * await captureProprietary(camera, config, 8);
 */
async function captureProprietary(camera, config, quality, width) {
  const budgetMs = config.capture_timeout * 1000;
  const session = new TapoMediaSession({
    ip: camera.ip,
    // The stream authenticates with the TP-Link CLOUD password, not the camera
    // account — a counter-intuitive but load-bearing detail of the protocol.
    password: config.password,
    quality: config.stream_quality,
  });

  try {
    const capture = runFfmpeg(buildArgs('-', quality, false, width), {
      // ffmpeg gets the WHOLE budget, counted from now. The handshake happens
      // inside that window and eats part of it, so giving each step the full
      // budget separately would let a capture run for twice the configured time.
      timeoutMs: budgetMs,
      onStdin: (stdin) => {
        // The stream is ENDLESS: the camera keeps sending until told to stop, so
        // nothing would ever close ffmpeg's input on its own and ffmpeg would sit
        // on its frame until the timeout killed it — the exact symptom of a
        // capture that "receives video but produces no image".
        //
        // So: feed it enough data to hold a full picture, then close the input.
        // The EOF is what makes ffmpeg flush the frame it already decoded.
        let fed = 0;
        let ended = false;
        session.on('packet', (packet) => {
          // `writable` guards the race between ffmpeg exiting on its own and the
          // camera still pushing packets: writing to a closed pipe throws.
          if (ended || !stdin.writable) {
            return;
          }
          stdin.write(packet);
          fed += packet.length;
          if (fed >= PROPRIETARY_BYTES_PER_FRAME) {
            ended = true;
            stdin.end();
            session.close();
          }
        });
        // A camera that stops early still gets its frame flushed.
        session.on('close', () => {
          if (!ended) {
            ended = true;
            stdin.end();
          }
        });
      },
    });

    // `capture` is already running, so its rejection must always be consumed:
    // if the handshake below throws first, an unawaited ffmpeg failure would
    // surface as an unhandled rejection instead of this function's error.
    capture.catch(() => {});

    // Start the session AFTER wiring ffmpeg, so no packet is dropped. The
    // handshake is bounded separately and generously: a battery camera waking
    // from deep sleep answers slowly, and failing here would waste the round.
    await session.start(Math.min(budgetMs, HANDSHAKE_TIMEOUT_MS));
    return await capture;
  } finally {
    session.close();
  }
}

/**
 * Capture one image of a camera and return it in the format Gladys expects.
 *
 * The quality is lowered and the capture retried when a frame exceeds the 150 KB
 * limit: publishing it would be rejected, and a slightly softer image beats no
 * image at all.
 * @param {object} camera - The resolved camera (ip, captureMode, model).
 * @param {object} config - The normalized configuration.
 * @returns {Promise<string>} The `image/jpg;base64,...` string.
 * @example
 * const image = await captureImage(camera, config);
 */
export async function captureImage(camera, config) {
  if (!camera.ip) {
    throw new Error('TAPO_CAMERA_IP_UNKNOWN');
  }

  let lastImage = null;
  for (const [width, quality] of CAPTURE_STEPS) {
    const image =
      camera.captureMode === CAPTURE_MODES.RTSP
        ? await captureRtsp(camera, config, quality, width)
        : await captureProprietary(camera, config, quality, width);
    lastImage = image;

    // base64 inflates the payload by ~4/3, and Gladys checks the encoded size.
    if (Buffer.byteLength(image.toString('base64')) <= IMAGE_MAX_BYTES) {
      return `image/jpg;base64,${image.toString('base64')}`;
    }
    logger.debug(
      `The image of "${camera.name}" is too big at ${width}px/q${quality}, retrying smaller`,
    );
  }

  // Every step overshot: the camera resolution is unusually high. Report it
  // rather than publishing an image Gladys would refuse.
  logger.warn(`Unable to capture an image of "${camera.name}" under the size limit`);
  throw new Error(`TAPO_IMAGE_TOO_LARGE:${lastImage ? lastImage.length : 0}`);
}
