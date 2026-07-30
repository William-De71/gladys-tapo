// -----------------------------------------------------------------------------
// Local network discovery of the cameras.
//
// Why this exists: the TP-Link cloud lists which cameras you own, but it does
// NOT report their local address — so the cloud alone can tell you a camera
// exists while leaving you unable to reach it.
//
// TP-Link devices answer a UDP broadcast on port 20002, the same request the
// Tapo app sends when it looks for devices on your network. The reply carries
// the device id, which is what lets a discovered IP be matched to a cloud
// camera. The core performs the broadcast itself (a bridge container never
// receives LAN broadcast) and relays the raw replies.
// -----------------------------------------------------------------------------

import { logger } from '@gladysassistant/integration-sdk';
import { DISCOVERY_PORT, DISCOVERY_TIMEOUT_SECONDS } from './constants.js';

/**
 * The discovery request the Tapo app broadcasts. A 16-byte header:
 * magic `0x02 0x00 0x00 0x01`, then a zeroed body — devices answer to any
 * well-formed request, no encryption involved at this stage.
 * @returns {Buffer} The request bytes.
 * @example
 * buildDiscoveryRequest();
 */
export function buildDiscoveryRequest() {
  const request = Buffer.alloc(16);
  request[0] = 0x02;
  request[1] = 0x00;
  request[2] = 0x00;
  request[3] = 0x01;
  return request;
}

/**
 * Extract the device id from a discovery reply.
 *
 * The reply is a 16-byte header followed by a JSON body, but firmwares disagree
 * on the exact envelope: rather than parsing a shape that varies, the device id
 * is looked up in the decoded text. It is a 32-hex-character string, distinctive
 * enough that a false positive is implausible.
 * @param {Buffer} payload - The raw reply.
 * @returns {{ deviceId: string|null, model: string|null }} What could be read.
 * @example
 * parseDiscoveryReply(buffer);
 */
export function parseDiscoveryReply(payload) {
  const text = payload.toString('utf-8');

  // A device id is 32 uppercase hex characters; `device_id` may also appear
  // spelled `deviceId` depending on the firmware.
  const idMatch = /"device_?[iI]d"\s*:\s*"([0-9A-Fa-f]{32})"/.exec(text);
  const deviceId = idMatch ? idMatch[1].toUpperCase() : null;

  const modelMatch = /"device_?[mM]odel"\s*:\s*"([^"]+)"/.exec(text);
  // The model is announced as e.g. "C210 1.0", and only the reference matters.
  const model = modelMatch ? modelMatch[1].split(' ')[0] : null;

  return { deviceId, model };
}

/**
 * Discover the local addresses of the Tapo devices on the network.
 *
 * Failures are swallowed on purpose: discovery is an enhancement over the cloud
 * list, so a missing Gladys Plus, a filtered broadcast or a rate-limited scan
 * must degrade to "no address found", never break the whole publish.
 * @param {object} gladys - The SDK instance.
 * @returns {Promise<Map<string, string>>} IPs indexed by upper-cased device id.
 * @example
 * const ips = await discoverLocalAddresses(gladys);
 */
export async function discoverLocalAddresses(gladys) {
  /** @type {Map<string, string>} */
  const addresses = new Map();

  let replies;
  try {
    replies = await gladys.scanNetwork('udp-active-broadcast', {
      port: DISCOVERY_PORT,
      payload: buildDiscoveryRequest(),
      timeoutSeconds: DISCOVERY_TIMEOUT_SECONDS,
    });
  } catch (e) {
    // A 403 means the running Gladys still holds a manifest without
    // `network_discovery` — the integration was installed before the field was
    // declared. Reinstalling it is the fix, and staying silent here would hide
    // the reason why every camera ends up without an address.
    if (e.status === 403) {
      logger.warn(
        'Gladys refused the network scan: the installed integration predates its "network_discovery" declaration. Reinstall the integration to pick up the new manifest.',
      );
    } else {
      logger.warn(`The network scan failed: ${e.message}`);
    }
    return addresses;
  }

  (replies || []).forEach((reply) => {
    try {
      const { deviceId } = parseDiscoveryReply(Buffer.from(reply.payload_base64, 'base64'));
      if (deviceId && reply.source_ip) {
        addresses.set(deviceId, reply.source_ip);
      }
    } catch (e) {
      logger.debug(`Unreadable discovery reply from ${reply.source_ip}: ${e.message}`);
    }
  });

  if (addresses.size > 0) {
    logger.info(`${addresses.size} Tapo device(s) located on the local network`);
  } else {
    logger.debug('The network scan located no Tapo device');
  }
  return addresses;
}
