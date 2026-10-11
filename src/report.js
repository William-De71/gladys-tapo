// -----------------------------------------------------------------------------
// What the integration tells the user about its devices, in plain text.
//
// The Configuration screen renders these messages as escaped text with their
// line breaks preserved (spec C.1), so one device per line is the richest
// layout available — and the most useful one: the questions that come up on the
// forum are all per device ("why does THIS camera show nothing?").
// -----------------------------------------------------------------------------

import { DEVICE_PARAMS, CAPTURE_MODES } from './tapo/constants.js';
import { getParam } from './devices.js';

/** The action that fixes a missing or wrong address, as the UI labels it. */
export const ADDRESS_ACTION_LABEL = {
  en: 'Set a device IP address',
  fr: "Définir l'adresse IP d'un appareil",
};

/**
 * Where an address came from, in words.
 * @param {string|null} source - The `TAPO_IP_SOURCE` param.
 * @returns {{ en: string, fr: string }} The description.
 * @example
 * describeAddressSource('scan'); // { en: 'found on the network', ... }
 */
export function describeAddressSource(source) {
  switch (source) {
    case 'manual':
      return { en: 'entered by you', fr: 'saisie par vous' };
    case 'scan':
      return { en: 'found on the network', fr: 'trouvée sur le réseau' };
    case 'cloud':
      return { en: 'reported by the Tapo cloud', fr: 'fournie par le cloud Tapo' };
    case 'previous':
      return {
        en: 'last known address, not seen in the latest scan',
        fr: 'dernière adresse connue, absente du dernier scan',
      };
    default:
      return { en: 'unknown origin', fr: 'origine inconnue' };
  }
}

/**
 * One line of the connection report, per device.
 * @param {object} device - The device as published.
 * @returns {{ en: string, fr: string, ok: boolean }} The line, and whether the
 * device is usable.
 * @example
 * reportLine(device);
 */
export function reportLine(device) {
  const ip = getParam(device, DEVICE_PARAMS.IP);
  const model = getParam(device, DEVICE_PARAMS.MODEL) || device.model || '';
  const label = model ? `${device.name} (${model})` : device.name;

  if (!ip) {
    return {
      ok: false,
      en: `✖ ${label}: not found on your network → run "${ADDRESS_ACTION_LABEL.en}" below.`,
      fr: `✖ ${label} : introuvable sur votre réseau → utilisez « ${ADDRESS_ACTION_LABEL.fr} » ci-dessous.`,
    };
  }

  const source = describeAddressSource(getParam(device, DEVICE_PARAMS.IP_SOURCE));
  const mode = getParam(device, DEVICE_PARAMS.CAPTURE_MODE);
  const isCamera = (device.features || []).some((feature) => feature.category === 'camera');
  if (isCamera && !mode) {
    return {
      ok: false,
      en: `⚠ ${label}: ${ip} (${source.en}) does not answer. Is it powered on, on this network, with "Third-Party Compatibility" enabled in the Tapo app? If the address is wrong, fix it with "${ADDRESS_ACTION_LABEL.en}".`,
      fr: `⚠ ${label} : ${ip} (${source.fr}) ne répond pas. Est-elle allumée, sur ce réseau, avec la « Compatibilité tierce » activée dans l'application Tapo ? Si l'adresse est fausse, corrigez-la avec « ${ADDRESS_ACTION_LABEL.fr} ».`,
    };
  }

  const how = !isCamera
    ? { en: '', fr: '' }
    : mode === CAPTURE_MODES.RTSP
      ? { en: ', images over RTSP', fr: ', images en RTSP' }
      : { en: ', images over the Tapo protocol', fr: ', images par le protocole Tapo' };
  return {
    ok: true,
    en: `✔ ${label}: ${ip} (${source.en})${how.en}`,
    fr: `✔ ${label} : ${ip} (${source.fr})${how.fr}`,
  };
}

/**
 * The full connection report.
 * @param {object[]} devices - The devices as published.
 * @returns {{ en: string, fr: string }} The report, one device per line.
 * @example
 * buildConnectionReport(devices);
 */
export function buildConnectionReport(devices) {
  const lines = devices.map(reportLine);
  const usable = lines.filter((line) => line.ok).length;
  const header = {
    en: `Connected to the Tapo cloud: ${devices.length} device(s), ${usable} reachable on your network.`,
    fr: `Connexion au cloud Tapo OK : ${devices.length} appareil(s), ${usable} joignable(s) sur votre réseau.`,
  };
  return {
    en: [header.en, ...lines.map((line) => line.en)].join('\n'),
    fr: [header.fr, ...lines.map((line) => line.fr)].join('\n'),
  };
}

/**
 * The connection status shown on the Configuration screen after a publish.
 *
 * Connected as soon as the cloud answered, but never silently so: a device with
 * no address is named, with the fix. That is the message users were missing —
 * the badge said "connected" while every image stayed empty.
 * @param {object[]} devices - The devices as published.
 * @returns {{ connected: boolean, message?: { en: string, fr: string } }} The status.
 * @example
 * connectionStatusFor(devices);
 */
export function connectionStatusFor(devices) {
  if (devices.length === 0) {
    return {
      connected: false,
      message: {
        en: 'No device found on your Tapo account. Check that your devices appear in the Tapo app.',
        fr: "Aucun appareil trouvé sur votre compte Tapo. Vérifiez qu'ils apparaissent dans l'application Tapo.",
      },
    };
  }
  const missing = devices.filter((device) => !getParam(device, DEVICE_PARAMS.IP));
  if (missing.length === 0) {
    return { connected: true };
  }
  const names = missing.map((device) => device.name).join(', ');
  return {
    connected: true,
    message: {
      en: `Not found on your network: ${names}. Run "${ADDRESS_ACTION_LABEL.en}" for each of them (the address is in the Tapo app: device settings > Device info).`,
      fr: `Introuvable(s) sur votre réseau : ${names}. Utilisez « ${ADDRESS_ACTION_LABEL.fr} » pour chacun (l'adresse est dans l'application Tapo : paramètres de l'appareil > Infos sur l'appareil).`,
    },
  };
}

/**
 * Tell whether a string is a usable device address.
 *
 * An IPv4 address, or a host name. IPv6 is not accepted: no Tapo device is
 * known to be reachable over it locally, and a typo is far likelier.
 * @param {string} value - The candidate.
 * @returns {boolean} True when it can be used as an address.
 * @example
 * isValidAddress('192.168.1.20'); // true
 */
export function isValidAddress(value) {
  const text = String(value || '').trim();
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (ipv4) {
    return ipv4.slice(1).every((part) => Number(part) <= 255);
  }
  // Something that looks like an IPv4 with a typo is not a host name.
  if (/^[\d.]+$/.test(text)) {
    return false;
  }
  return /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(
    text,
  );
}
