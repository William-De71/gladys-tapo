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
 * Every minute keeps the dashboard image fresh without hammering the cameras —
 * a battery model would drain far faster under a tighter loop.
 */
export const POLL_FREQUENCY_MS = 60 * 1000;

/**
 * How often the integration re-publishes the camera images by itself.
 *
 * Gladys only wires a device into its poll scheduler at creation time, so a
 * camera created before `should_poll` was declared would never be refreshed.
 * This loop makes the dashboard image independent of that.
 *
 * Kept well under the 12 images/minute/device the host API allows.
 */
export const IMAGE_REFRESH_INTERVAL_MS = 30 * 1000;

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
 * Gladys rejects an image above 150 KB. ffmpeg is asked for a width of 1280 and
 * a quality that lands well under the limit; `snapshot.js` degrades the quality
 * further if a frame still comes out too big.
 */
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

export const IMAGE_MAX_BYTES = 150 * 1024;
export const IMAGE_WIDTH = 1280;

// --- Features ----------------------------------------------------------------

/** Suffixes of the feature external ids, appended to the device external id. */
export const FEATURE_SUFFIXES = {
  IMAGE: 'image',
  BUTTON: 'button',
  MOTION: 'motion',
  BATTERY: 'battery',
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
