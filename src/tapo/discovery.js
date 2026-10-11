// -----------------------------------------------------------------------------
// Local network discovery of the Tapo devices.
//
// Why this exists: the TP-Link cloud lists which devices you own, but it does
// NOT report their local address — so the cloud alone can tell you a camera
// exists while leaving you unable to reach it.
//
// TP-Link devices answer a UDP broadcast on port 20002 (the "TDP" probe the Tapo
// app sends when it looks for devices on your network). The core performs the
// broadcast itself — a bridge container never reaches the LAN in broadcast — and
// relays the raw replies; this module forges the probe and reads the replies.
//
// Two facts this module is built on, both taken from python-kasa (the reference
// implementation, with captures of real devices):
//
//   - the probe must be a WELL-FORMED TDP packet: a 16-byte header carrying the
//     payload size, flags and a CRC32, followed by a JSON body holding an RSA
//     public key. The first version of this module sent sixteen zero bytes
//     after the magic, which recent firmwares simply ignore;
//   - the `device_id` a device announces is a 32-character HASH, not the
//     40-character id the cloud lists. The only identifier both sides share in
//     clear is the MAC address, so that is what a reply is matched on.
// -----------------------------------------------------------------------------

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { logger } from '@gladysassistant/integration-sdk';
import {
  DISCOVERY_PORT,
  DISCOVERY_TIMEOUT_SECONDS,
  DISCOVERY_CACHE_MS,
  DISCOVERY_MAX_PAYLOAD_BYTES,
} from './constants.js';

/** Header layout constants of a TDP probe. */
const TDP = {
  VERSION: 2,
  MSG_TYPE: 0,
  OP_PROBE: 1,
  FLAGS: 17,
  INITIAL_CRC: 0x5a6b7c8d,
  HEADER_SIZE: 16,
};

/**
 * Key pair whose public half travels in the probe. Devices use it to encrypt
 * the part of their reply this module does not need; it only has to be a valid
 * key. Generated once per process: it costs a few dozen milliseconds.
 * @type {{ publicKey: string }|null}
 */
let keyPair = null;

/**
 * The public key to announce, generated on first use.
 * @returns {string} The PEM-encoded SubjectPublicKeyInfo.
 * @example
 * discoveryPublicKey();
 */
function discoveryPublicKey() {
  if (!keyPair) {
    const { publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    keyPair = { publicKey };
  }
  return keyPair.publicKey;
}

/**
 * Build the TDP probe the Tapo app broadcasts on port 20002.
 *
 * Layout (big-endian): version (1), message type (1), op code (2), payload size
 * (2), flags (1), padding (1), a random serial (4), then a CRC32 (4) computed
 * over the whole packet with `0x5A6B7C8D` standing in its own place.
 * @param {string} [publicKeyPem] - The key to announce; generated when absent.
 * @returns {Buffer} The probe bytes.
 * @example
 * buildDiscoveryRequest();
 */
export function buildDiscoveryRequest(publicKeyPem = discoveryPublicKey()) {
  const body = Buffer.from(JSON.stringify({ params: { rsa_key: publicKeyPem } }), 'utf8');
  const header = Buffer.alloc(TDP.HEADER_SIZE);
  header.writeUInt8(TDP.VERSION, 0);
  header.writeUInt8(TDP.MSG_TYPE, 1);
  header.writeUInt16BE(TDP.OP_PROBE, 2);
  header.writeUInt16BE(body.length, 4);
  header.writeUInt8(TDP.FLAGS, 6);
  header.writeUInt8(0, 7);
  header.writeUInt32BE(crypto.randomBytes(4).readUInt32BE(0), 8);
  header.writeUInt32BE(TDP.INITIAL_CRC, 12);

  const packet = Buffer.concat([header, body]);
  packet.writeUInt32BE(zlib.crc32(packet) >>> 0, 12);
  if (packet.length > DISCOVERY_MAX_PAYLOAD_BYTES) {
    // The core refuses a payload past this size; failing here says why.
    throw new Error(`TAPO_DISCOVERY_PROBE_TOO_LARGE:${packet.length}`);
  }
  return packet;
}

/**
 * Normalize a MAC address to twelve uppercase hex digits.
 *
 * The two sides spell it differently — `28-EE-52-00-00-00` in a discovery
 * reply, `28EE52000000` in the cloud list, `28:ee:52:...` when typed — and only
 * the digits are worth comparing.
 * @param {unknown} mac - The MAC, in any common spelling.
 * @returns {string|null} The normalized MAC, or null when it is not one.
 * @example
 * normalizeMac('28-ee-52-00-00-01'); // '28EE52000001'
 */
export function normalizeMac(mac) {
  const hex = String(mac || '')
    .replace(/[^0-9a-f]/gi, '')
    .toUpperCase();
  return hex.length === 12 ? hex : null;
}

/**
 * Read one discovery reply.
 *
 * The reply is a 16-byte TDP header followed by a JSON body. Some firmwares pad
 * or prefix differently, so the JSON is taken from the first `{` when it does
 * not start right after the header.
 * @param {Buffer} payload - The raw reply.
 * @returns {object|null} What the device announced, or null when unreadable.
 * @example
 * parseDiscoveryReply(buffer); // { mac: '28EE52000001', model: 'C200', ... }
 */
export function parseDiscoveryReply(payload) {
  const text = payload.toString('utf-8');
  const start =
    payload.length > TDP.HEADER_SIZE && payload[TDP.HEADER_SIZE] === 0x7b
      ? TDP.HEADER_SIZE
      : text.indexOf('{');
  if (start === -1) {
    return null;
  }
  let json;
  try {
    json = JSON.parse(payload.subarray(start).toString('utf-8').replace(/\0+$/, ''));
  } catch {
    return null;
  }
  const result = json?.result || json;
  if (!result || typeof result !== 'object') {
    return null;
  }

  const scheme = result.mgt_encrypt_schm || {};
  return {
    mac: normalizeMac(result.mac),
    // The hashed id: kept for diagnosis only, it never matches the cloud's.
    deviceId: typeof result.device_id === 'string' ? result.device_id.toUpperCase() : null,
    // Announced as "C210(EU)" or "C210 1.0": only the reference matters.
    model: result.device_model ? String(result.device_model).split(/[ (]/)[0] : null,
    deviceType: result.device_type || null,
    // The address the device believes it has; the source address of the reply
    // is preferred by the caller, as it is the one that is known to route.
    ip: result.ip || null,
    encryptType: scheme.encrypt_type || null,
    httpPort: Number.isFinite(Number(scheme.http_port)) ? Number(scheme.http_port) : null,
    https: scheme.is_support_https === true,
    loginVersion: Number.isFinite(Number(scheme.lv)) ? Number(scheme.lv) : null,
  };
}

/**
 * The last scan, reused for a short while.
 *
 * The core allows one scan every ten seconds per integration and answers 429
 * beyond. A configuration save, the action that saves an address and the
 * re-publish they both trigger land within a second of each other — measured on
 * a user setup: the second scan was refused, and every camera was then published
 * without its address. Reusing the last result (and the scan in flight) is what
 * keeps them consistent.
 */
const scanCache = {
  /** @type {number} */
  at: 0,
  /** @type {object[]|null} */
  results: null,
  /** @type {Promise<object[]>|null} */
  pending: null,
};

/**
 * Forget the last scan, so the next call broadcasts again.
 * @example
 * forgetLastScan();
 */
export function forgetLastScan() {
  scanCache.at = 0;
  scanCache.results = null;
  scanCache.pending = null;
}

/**
 * Broadcast the probe and read the replies.
 * @param {object} gladys - The SDK instance.
 * @returns {Promise<object[]>} The devices that answered.
 * @example
 * await scanOnce(gladys);
 */
async function scanOnce(gladys) {
  const replies = await gladys.scanNetwork('udp-active-broadcast', {
    port: DISCOVERY_PORT,
    payload: buildDiscoveryRequest(),
    timeoutSeconds: DISCOVERY_TIMEOUT_SECONDS,
  });

  const found = [];
  (replies || []).forEach((reply) => {
    try {
      const parsed = parseDiscoveryReply(Buffer.from(reply.payload_base64, 'base64'));
      if (parsed && parsed.mac && (reply.source_ip || parsed.ip)) {
        found.push({ ...parsed, ip: reply.source_ip || parsed.ip });
      }
    } catch (e) {
      logger.debug(`Unreadable discovery reply from ${reply.source_ip}: ${e.message}`);
    }
  });
  return found;
}

/**
 * Discover the Tapo devices on the local network.
 *
 * Failures are swallowed on purpose: discovery is an enhancement over the cloud
 * list, so a filtered broadcast or a refused scan must degrade to "no address
 * found", never break the whole publish. A rate-limited scan falls back to the
 * last result, whatever its age, since it is still far better than nothing.
 * @param {object} gladys - The SDK instance.
 * @returns {Promise<object[]>} What answered, each with its `ip` and `mac`.
 * @example
 * const found = await discoverDevices(gladys);
 */
export async function discoverDevices(gladys) {
  if (scanCache.results && Date.now() - scanCache.at < DISCOVERY_CACHE_MS) {
    return scanCache.results;
  }
  if (scanCache.pending) {
    return scanCache.pending;
  }

  scanCache.pending = scanOnce(gladys)
    .then((found) => {
      scanCache.results = found;
      scanCache.at = Date.now();
      if (found.length > 0) {
        logger.info(`${found.length} Tapo device(s) located on the local network`);
      } else {
        logger.info(
          'The network scan located no Tapo device. If your devices are on another subnet or VLAN, set their address with the "Set a device IP address" action.',
        );
      }
      return found;
    })
    .catch((e) => {
      // A 403 means the running Gladys still holds a manifest without
      // `network_discovery` — the integration was installed before the field
      // was declared. Reinstalling it is the fix.
      if (e.status === 403) {
        logger.warn(
          'Gladys refused the network scan: the installed integration predates its "network_discovery" declaration. Reinstall the integration to pick up the new manifest.',
        );
      } else if (e.status === 429 || /Too Many Requests/i.test(e.message)) {
        logger.debug('The network scan was rate-limited, reusing the previous result');
      } else {
        logger.warn(`The network scan failed: ${e.message}`);
      }
      return scanCache.results || [];
    })
    .finally(() => {
      scanCache.pending = null;
    });
  return scanCache.pending;
}

/**
 * Index discovery results by MAC, the identifier the cloud shares.
 * @param {object[]} found - The discovery results.
 * @returns {Map<string, object>} The results by normalized MAC.
 * @example
 * const byMac = indexByMac(await discoverDevices(gladys));
 */
export function indexByMac(found) {
  const byMac = new Map();
  (found || []).forEach((entry) => {
    if (entry.mac) {
      byMac.set(entry.mac, entry);
    }
  });
  return byMac;
}
