// -----------------------------------------------------------------------------
// Every Tapo-specific constant, in one place.
//
// The values under "media stream protocol" come from TP-Link's proprietary
// protocol on TCP port 8800 (the same one pytapo and go2rtc implement). They are
// not configurable: they are what the firmware expects.
// -----------------------------------------------------------------------------

/**
 * The `type` part of the external ids, as in
 * `ext:<selector>:<type>:<platformId>`. The SDK builds them; this is the only
 * piece the integration chooses.
 */
export const EXTERNAL_ID_TYPE = 'camera';

// --- TP-Link cloud -----------------------------------------------------------

/** Cloud endpoints, per region (the `region` config key). */
export const CLOUD_ENDPOINTS = {
  default: 'https://wap.tplinkcloud.com',
  europe: 'https://eu-wap.tplinkcloud.com',
  america: 'https://use1-wap.tplinkcloud.com',
  asia: 'https://aps1-wap.tplinkcloud.com',
};

/** App type sent at login; the cloud rejects an unknown one. */
export const CLOUD_APP_TYPE = 'Tapo_Android';

/** Cloud `deviceType` values considered as a camera. */
export const CAMERA_DEVICE_TYPE_PATTERNS = ['IPCAMERA'];

/**
 * How often Gladys polls a camera. One of the frequencies the core accepts.
 *
 * This is the CEILING, not the capture rate: `onPoll` is also what reads the
 * battery and the missed events, and those must keep running even when capturing
 * is paused. The interval between two captures is decided per camera by
 * `image_refresh_interval` / `battery_image_refresh_interval`, which the poll
 * honours through a per-device timestamp.
 */
export const POLL_FREQUENCY_MS = 60 * 1000;

/** HTTPS port of the local camera API (battery, detections). */
export const LOCAL_API_PORT = 443;

/**
 * How far back the first detection search reaches, in seconds.
 *
 * Only used the very first time a camera is looked at; afterwards the window
 * starts where the previous round stopped. Cameras keep days of detections, so
 * asking for everything would return hundreds of entries for nothing.
 */
export const LOCAL_EVENT_WINDOW_SECONDS = 5 * 60;

/** A local request that hangs must not hold the event loop. */
export const LOCAL_API_TIMEOUT_MS = 10 * 1000;

// --- ONVIF (events pushed by the camera) --------------------------------------

/**
 * Port the Tapo cameras serve ONVIF on.
 *
 * Not the ONVIF default (80): TP-Link moved it, and the standard port is closed
 * on these cameras.
 */
export const ONVIF_PORT = 2020;

/**
 * How long the camera may hold a `PullMessages` request open waiting for an
 * event, in seconds.
 *
 * This is what makes the events near-instant: the request stays open, and the
 * camera answers the moment it detects something instead of at the next poll.
 * Long enough that a quiet camera is not constantly reconnecting, short enough
 * that a dropped connection is noticed while it still matters.
 */
export const ONVIF_PULL_TIMEOUT_SECONDS = 60;

/** Budget for the short ONVIF calls (probe, subscribe), which answer at once. */
export const ONVIF_REQUEST_TIMEOUT_MS = 10 * 1000;

/**
 * How long a motion stays reported when the camera never sends the falling edge.
 *
 * ONVIF normally reports both edges, so the sensor comes back down on the
 * camera's own schedule. This is the safety net for the firmwares that only
 * report the rising one — without it such a camera would stay "motion detected"
 * forever.
 */
export const ONVIF_MOTION_TIMEOUT_MS = 3 * 60 * 1000;

// --- ONVIF PTZ (pan / tilt / zoom) -------------------------------------------

/**
 * Canonical values of the Gladys `camera.move` feature.
 *
 * Mirrors `CAMERA_MOVE` in the core (`server/utils/constants.js`, spec
 * `docs/specs/camera-ptz-control.md` A.2). Declared here rather than imported
 * from the SDK because the published SDK still exposes `CAMERA.IMAGE` alone —
 * importing an undefined constant would break the integration at startup, while
 * these values are fixed by the spec.
 */
export const CAMERA_MOVE = {
  STOP: 0,
  PAN_LEFT: 1,
  PAN_RIGHT: 2,
  TILT_UP: 3,
  TILT_DOWN: 4,
  ZOOM_IN: 5,
  ZOOM_OUT: 6,
};

/** The `camera` feature types the PTZ contract adds, same reasoning as above. */
export const CAMERA_FEATURE_TYPES = {
  MOVE: 'move',
  PRESET: 'preset',
};

/**
 * How far one `RelativeMove` step travels, in ONVIF normalized units (-1..1).
 *
 * Relative is the ONLY mode this integration sends, because a lone movement
 * value — a scene action, a dashboard tap whose release is lost — is the common
 * case, and a continuous move would then mean seconds of rotation where the user
 * expects a nudge. A step also ends on its own, so no movement here depends on a
 * later message to stop it (which is what the spec's watchdog, A.2, guards).
 *
 * The size is EMPIRICAL, not geometric. Deriving it from the axis range (0.05
 * for ~9° of pan) produced a camera that answered every command with a 200 and
 * did not move an inch: below some firmware threshold, a translation is
 * acknowledged and then ignored. Reported elsewhere on these firmwares too — a
 * distance of 0.1 crawls, 0.8 moves normally, at identical speeds.
 */
export const PTZ_STEP = 0.5;

/**
 * Speed sent alongside a movement, in ONVIF normalized units (0..1).
 *
 * Kept high on purpose. Tapo firmwares largely IGNORE the speed of a
 * `RelativeMove` and derive the pace from the distance instead (reported on a
 * C200: identical speeds, wildly different results depending on `distance`), so
 * a low value here buys nothing and a high one costs nothing.
 */
export const PTZ_SPEED = 0.8;

/** A PTZ call is a short round trip; it must not hang the command path. */
export const PTZ_REQUEST_TIMEOUT_MS = 5 * 1000;

// --- Local network discovery --------------------------------------------------

/** UDP port TP-Link devices answer the discovery broadcast on. */
export const DISCOVERY_PORT = 20002;

/** How long the core listens for discovery replies. */
export const DISCOVERY_TIMEOUT_SECONDS = 5;

// --- Device params stored on each Gladys device -------------------------------

export const DEVICE_PARAMS = {
  /** Local IP of the camera, resolved from the cloud or the manual config. */
  IP: 'TAPO_IP',
  /** Cloud device id, the stable identity of the camera. */
  CLOUD_DEVICE_ID: 'TAPO_CLOUD_DEVICE_ID',
  /** Camera model, e.g. C210 (shown to the user, drives the capabilities). */
  MODEL: 'TAPO_MODEL',
  /** 'rtsp' or 'proprietary': how the image is captured. */
  CAPTURE_MODE: 'TAPO_CAPTURE_MODE',
  /**
   * Stream URL read by the rtsp-camera service to serve the live view. The name
   * is imposed by that service, which is why it carries no TAPO_ prefix.
   */
  CAMERA_URL: 'CAMERA_URL',
  /** Rotation applied to the live view, same contract as rtsp-camera. */
  CAMERA_ROTATION: 'CAMERA_ROTATION',
  /**
   * ONVIF preset tokens, comma-separated, in the order of the feature options.
   *
   * The `preset` feature sends the option's INDEX (Gladys options are integers),
   * while ONVIF identifies a preset by a free-text token ("1", "Preset001"…).
   * This param is what maps one back to the other, so recalling a preset costs
   * no extra call to the camera.
   */
  PRESET_TOKENS: 'TAPO_PRESET_TOKENS',
};

/** How the image of a camera is captured. */
export const CAPTURE_MODES = {
  /** Standard RTSP stream, needs the camera account. */
  RTSP: 'rtsp',
  /** TP-Link proprietary protocol on port 8800, for cameras without RTSP. */
  PROPRIETARY: 'proprietary',
};

// --- RTSP --------------------------------------------------------------------

/** The RTSP port of every Tapo camera. */
export const RTSP_PORT = 554;

/** Tapo cameras expose two RTSP streams: stream1 (HD) and stream2 (SD). */
export const RTSP_STREAMS = {
  HD: 'stream1',
  SD: 'stream2',
};

// --- Media stream protocol (proprietary, port 8800) --------------------------

/** TCP port of the proprietary media stream. */
export const STREAM_PORT = 8800;

/**
 * Hardcoded firmware key, used when media encryption is off (the Key-Exchange
 * username is then "none"). Related to CVE-2022-37255.
 */
export const SUPER_SECRET_KEY = 'TPL075526460603';

/** Multipart boundaries of the media stream protocol. */
export const CLIENT_BOUNDARY = '--client-stream-boundary--';
export const DEVICE_BOUNDARY = '--device-stream-boundary--';

/** How the password is hashed before the AES key derivation. */
export const ENCRYPTION_METHODS = {
  MD5: 'md5',
  SHA256: 'sha256',
};

/** Digest username used by the media stream (never the Tapo email). */
export const STREAM_USERNAME = 'admin';

/** MPEG-TS framing: a packet is 188 bytes and starts with the sync byte. */
export const TS_PACKET_SIZE = 188;
export const TS_SYNC_BYTE = 0x47;

/** Acknowledgement window of the media stream, in packets. */
export const STREAM_WINDOW_SIZE = 50;

// --- Images ------------------------------------------------------------------

/**
 * How long the proprietary handshake may take before giving up. Bounded apart
 * from the capture budget: a battery camera waking from deep sleep can take
 * several seconds to answer, and that wait is not ffmpeg's fault.
 */
export const HANDSHAKE_TIMEOUT_MS = 15 * 1000;

/**
 * How many bytes of MPEG-TS to feed ffmpeg before closing its input, in
 * proprietary mode.
 *
 * The stream never ends by itself, so the capture has to decide when it holds
 * enough for one picture. 512 KB covers a full keyframe at HD comfortably
 * (measured: a keyframe part alone is ~64 KB), while staying small enough that
 * the capture finishes in a couple of seconds.
 */
export const PROPRIETARY_BYTES_PER_FRAME = 512 * 1024;

/**
 * Largest base64 payload an image may reach.
 *
 * The host API documents 150 KB, but that bound is never reached: Gladys mounts
 * `express.json()` with no `limit`, so the HTTP layer rejects any body above
 * Express' 100 KB default with `PayloadTooLargeError` — before the application
 * check ever runs. The effective ceiling is therefore ~100 KB for the WHOLE
 * request, and the margin below leaves room for the JSON envelope.
 *
 * `snapshot.js` lowers the JPEG quality until the payload fits.
 */
export const IMAGE_MAX_BYTES = 96 * 1024;
export const IMAGE_WIDTH = 1280;

// --- Battery protection ------------------------------------------------------

/**
 * Battery thresholds guarding a solar/battery camera, in percent.
 *
 * A lithium cell drained too far may stop accepting charge altogether, and a
 * solar panel only refills it in bursts — so capturing must back off long before
 * the camera reaches a critical level.
 *
 * Only battery models are affected; a wired camera is never throttled.
 */
export const BATTERY_THRESHOLDS = {
  /** Below this, the periodic image refresh stops. */
  PAUSE_REFRESH: 60,
  /** Below this, no capture at all happens, not even an explicit one. */
  STOP_ALL: 40,
  /**
   * Level at which capturing resumes.
   *
   * Comfortably above the pause threshold rather than a couple of points over
   * it: resuming early restarts the drain on a still-weak reserve, and repeated
   * shallow cycles in the low range wear the cell faster than one proper cycle.
   *
   * NOT a full charge, though. A solar camera charges in bursts and rarely sits
   * at 100%, so requiring it meant a camera that dipped once stayed blocked
   * forever — the level was sampled once a minute and simply never read 100.
   * A camera has to earn its way back, not be locked out.
   */
  RESUME: 80,
};

/**
 * How long a battery reading stays trusted, in milliseconds.
 *
 * The guard decides from the last known level, so a level that stopped being
 * refreshed — camera asleep, session refused, network down — must not keep
 * authorizing captures on an increasingly stale number. Past this age the
 * reading is dropped and a battery camera falls back to on-demand only.
 *
 * Generous on purpose: a battery camera in deep sleep legitimately misses
 * several rounds, and treating that as a fault would pause it for nothing.
 */
export const BATTERY_READING_MAX_AGE_MS = 30 * 60 * 1000;

// --- Features ----------------------------------------------------------------

/** Suffixes of the feature external ids, appended to the device external id. */
export const FEATURE_SUFFIXES = {
  IMAGE: 'image',
  BUTTON: 'button',
  MOTION: 'motion',
  BATTERY: 'battery',
  PRIVACY: 'privacy',
  MOVE: 'move',
  PRESET: 'preset',
};

/**
 * Models known to run on battery (doorbells and wire-free cameras): they expose
 * a battery level, and their motion/doorbell events come from the cloud.
 * Matched as a prefix, so C420 also matches C420S2.
 */
export const BATTERY_MODEL_PREFIXES = ['C4', 'C6', 'D2', 'D1', 'TC6'];

/**
 * Models that expose no local access at all, on any port.
 *
 * Deliberately EMPTY: a camera with no RTSP stream is not a camera without local
 * access. The C610 was listed here on the assumption that it blocked everything,
 * and measuring proved the opposite — it serves its video over the proprietary
 * protocol just fine. Reachability is decided by probing the ports, never by a
 * model name, so a model only belongs here with a capture trace to back it up.
 */
export const NO_LOCAL_ACCESS_MODELS = [];
