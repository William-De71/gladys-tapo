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
  de: 'IP-Adresse eines Geräts festlegen',
  es: 'Definir la dirección IP de un dispositivo',
};

/**
 * Where an address came from, in words.
 * @param {string|null} source - The `TAPO_IP_SOURCE` param.
 * @returns {{ en: string, fr: string, de: string, es: string }} The description.
 * @example
 * describeAddressSource('scan'); // { en: 'found on the network', ... }
 */
export function describeAddressSource(source) {
  switch (source) {
    case 'manual':
      return {
        en: 'entered by you',
        fr: 'saisie par vous',
        de: 'von Ihnen eingegeben',
        es: 'introducida por usted',
      };
    case 'scan':
      return {
        en: 'found on the network',
        fr: 'trouvée sur le réseau',
        de: 'im Netzwerk gefunden',
        es: 'encontrada en la red',
      };
    case 'cloud':
      return {
        en: 'reported by the Tapo cloud',
        fr: 'fournie par le cloud Tapo',
        de: 'von der Tapo-Cloud gemeldet',
        es: 'facilitada por la nube Tapo',
      };
    case 'previous':
      return {
        en: 'last known address, not seen in the latest scan',
        fr: 'dernière adresse connue, absente du dernier scan',
        de: 'zuletzt bekannte Adresse, bei der letzten Suche nicht gesehen',
        es: 'última dirección conocida, no vista en la última búsqueda',
      };
    default:
      return {
        en: 'unknown origin',
        fr: 'origine inconnue',
        de: 'unbekannte Herkunft',
        es: 'origen desconocido',
      };
  }
}

/**
 * One line of the connection report, per device.
 * @param {object} device - The device as published.
 * @returns {{ en: string, fr: string, de: string, es: string, ok: boolean }} The line, and whether the
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
      de: `✖ ${label}: nicht in Ihrem Netzwerk gefunden → verwenden Sie unten „${ADDRESS_ACTION_LABEL.de}“.`,
      es: `✖ ${label}: no se encuentra en su red → use «${ADDRESS_ACTION_LABEL.es}» más abajo.`,
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
      de: `⚠ ${label}: ${ip} (${source.de}) antwortet nicht. Ist sie eingeschaltet, in diesem Netzwerk und ist in der Tapo-App die „Drittanbieter-Kompatibilität“ aktiviert? Ist die Adresse falsch, korrigieren Sie sie mit „${ADDRESS_ACTION_LABEL.de}“.`,
      es: `⚠ ${label}: ${ip} (${source.es}) no responde. ¿Está encendida, en esta red y con la «Compatibilidad con terceros» activada en la aplicación Tapo? Si la dirección es incorrecta, corríjala con «${ADDRESS_ACTION_LABEL.es}».`,
    };
  }

  const how = !isCamera
    ? { en: '', fr: '', de: '', es: '' }
    : mode === CAPTURE_MODES.RTSP
      ? {
          en: ', images over RTSP',
          fr: ', images en RTSP',
          de: ', Bilder über RTSP',
          es: ', imágenes por RTSP',
        }
      : {
          en: ', images over the Tapo protocol',
          fr: ', images par le protocole Tapo',
          de: ', Bilder über das Tapo-Protokoll',
          es: ', imágenes por el protocolo Tapo',
        };
  return {
    ok: true,
    en: `✔ ${label}: ${ip} (${source.en})${how.en}`,
    fr: `✔ ${label} : ${ip} (${source.fr})${how.fr}`,
    de: `✔ ${label}: ${ip} (${source.de})${how.de}`,
    es: `✔ ${label}: ${ip} (${source.es})${how.es}`,
  };
}

/**
 * One line for a device the last publish could not describe.
 * @param {object} problem - `{ physical, reason, message }` from the manager.
 * @returns {{ en: string, fr: string, de: string, es: string, ok: boolean }} The line.
 * @example
 * problemLine({ physical, reason: 'unreachable' });
 */
export function problemLine({ physical, reason }) {
  const label = physical.model ? `${physical.name} (${physical.model})` : physical.name;
  if (reason === 'address') {
    return {
      ok: false,
      en: `✖ ${label}: not found on your network → run "${ADDRESS_ACTION_LABEL.en}" below.`,
      fr: `✖ ${label} : introuvable sur votre réseau → utilisez « ${ADDRESS_ACTION_LABEL.fr} » ci-dessous.`,
      de: `✖ ${label}: nicht in Ihrem Netzwerk gefunden → verwenden Sie unten „${ADDRESS_ACTION_LABEL.de}“.`,
      es: `✖ ${label}: no se encuentra en su red → use «${ADDRESS_ACTION_LABEL.es}» más abajo.`,
    };
  }
  if (reason === 'unsupported') {
    return {
      ok: false,
      en: `✖ ${label}: not supported yet by this integration.`,
      fr: `✖ ${label} : pas encore pris en charge par cette intégration.`,
      de: `✖ ${label}: wird von dieser Integration noch nicht unterstützt.`,
      es: `✖ ${label}: esta integración todavía no lo admite.`,
    };
  }
  if (reason === 'credentials') {
    return {
      ok: false,
      en: `✖ ${label}: ${physical.ip} refused your Tapo account. Check the email and password above, as typed in the Tapo app.`,
      fr: `✖ ${label} : ${physical.ip} refuse votre compte Tapo. Vérifiez l'e-mail et le mot de passe ci-dessus, tels que dans l'application Tapo.`,
      de: `✖ ${label}: ${physical.ip} lehnt Ihr Tapo-Konto ab. Prüfen Sie E-Mail und Passwort oben, so wie in der Tapo-App eingegeben.`,
      es: `✖ ${label}: ${physical.ip} rechaza su cuenta Tapo. Compruebe el correo electrónico y la contraseña de arriba, tal como en la aplicación Tapo.`,
    };
  }
  return {
    ok: false,
    en: `⚠ ${label}: ${physical.ip} does not answer. Is it powered on and on this network? If the address is wrong, fix it with "${ADDRESS_ACTION_LABEL.en}".`,
    fr: `⚠ ${label} : ${physical.ip} ne répond pas. Est-il allumé et sur ce réseau ? Si l'adresse est fausse, corrigez-la avec « ${ADDRESS_ACTION_LABEL.fr} ».`,
    de: `⚠ ${label}: ${physical.ip} antwortet nicht. Ist es eingeschaltet und in diesem Netzwerk? Ist die Adresse falsch, korrigieren Sie sie mit „${ADDRESS_ACTION_LABEL.de}“.`,
    es: `⚠ ${label}: ${physical.ip} no responde. ¿Está encendido y en esta red? Si la dirección es incorrecta, corríjala con «${ADDRESS_ACTION_LABEL.es}».`,
  };
}

/**
 * The full connection report.
 * @param {object[]} devices - The devices as published.
 * @param {object[]} [problems] - Devices that could not be described.
 * @returns {{ en: string, fr: string, de: string, es: string }} The report, one device per line.
 * @example
 * buildConnectionReport(devices, problems);
 */
export function buildConnectionReport(devices, problems = []) {
  // A device already published before keeps its devices while it is down: it
  // gets the problem line, not a misleading ✔ from its previous params.
  const troubled = new Set(
    problems.map((problem) => String(problem.physical.cloudDeviceId).toUpperCase()),
  );
  const cloudIdOf = (device) =>
    String(getParam(device, DEVICE_PARAMS.CLOUD_DEVICE_ID) || '').toUpperCase();
  const lines = [
    ...devices.filter((device) => !troubled.has(cloudIdOf(device))).map(reportLine),
    ...problems.map(problemLine),
  ];
  const usable = lines.filter((line) => line.ok).length;
  const header = {
    en: `Connected to the Tapo cloud: ${lines.length} device(s), ${usable} reachable on your network.`,
    fr: `Connexion au cloud Tapo OK : ${lines.length} appareil(s), ${usable} joignable(s) sur votre réseau.`,
    de: `Mit der Tapo-Cloud verbunden: ${lines.length} Gerät(e), ${usable} in Ihrem Netzwerk erreichbar.`,
    es: `Conectado a la nube Tapo: ${lines.length} dispositivo(s), ${usable} accesible(s) en su red.`,
  };
  return {
    en: [header.en, ...lines.map((line) => line.en)].join('\n'),
    fr: [header.fr, ...lines.map((line) => line.fr)].join('\n'),
    de: [header.de, ...lines.map((line) => line.de)].join('\n'),
    es: [header.es, ...lines.map((line) => line.es)].join('\n'),
  };
}

/**
 * The connection status shown on the Configuration screen after a publish.
 *
 * Connected as soon as the cloud answered, but never silently so: a device with
 * no address is named, with the fix. That is the message users were missing —
 * the badge said "connected" while every image stayed empty.
 * @param {object[]} devices - The devices as published.
 * @returns {{ connected: boolean, message?: { en: string, fr: string, de: string, es: string } }} The status.
 * @example
 * connectionStatusFor(devices);
 */
export function connectionStatusFor(devices, problems = []) {
  if (devices.length === 0 && problems.length === 0) {
    return {
      connected: false,
      message: {
        en: 'No device found on your Tapo account. Check that your devices appear in the Tapo app.',
        fr: "Aucun appareil trouvé sur votre compte Tapo. Vérifiez qu'ils apparaissent dans l'application Tapo.",
        de: 'Kein Gerät in Ihrem Tapo-Konto gefunden. Prüfen Sie, ob Ihre Geräte in der Tapo-App erscheinen.',
        es: 'No se ha encontrado ningún dispositivo en su cuenta Tapo. Compruebe que sus dispositivos aparecen en la aplicación Tapo.',
      },
    };
  }
  const missing = [
    ...devices.filter((device) => !getParam(device, DEVICE_PARAMS.IP)).map((device) => device.name),
    ...problems
      .filter((problem) => problem.reason === 'address')
      .map((problem) => problem.physical.name),
  ];
  const silent = problems
    .filter((problem) => problem.reason !== 'address')
    .map((problem) => problem.physical.name);
  if (missing.length === 0 && silent.length === 0) {
    return { connected: true };
  }
  if (missing.length === 0) {
    return {
      connected: true,
      message: {
        en: `Not answering: ${silent.join(', ')}. Run "Test the connection" for details.`,
        fr: `Ne répondent pas : ${silent.join(', ')}. Lancez « Tester la connexion » pour le détail.`,
        de: `Antworten nicht: ${silent.join(', ')}. Starten Sie „Verbindung testen“ für Details.`,
        es: `No responden: ${silent.join(', ')}. Ejecute «Probar la conexión» para ver el detalle.`,
      },
    };
  }
  const names = missing.join(', ');
  return {
    connected: true,
    message: {
      en: `Not found on your network: ${names}. Run "${ADDRESS_ACTION_LABEL.en}" for each of them (the address is in the Tapo app: device settings > Device info).`,
      fr: `Introuvable(s) sur votre réseau : ${names}. Utilisez « ${ADDRESS_ACTION_LABEL.fr} » pour chacun (l'adresse est dans l'application Tapo : paramètres de l'appareil > Infos sur l'appareil).`,
      de: `Nicht in Ihrem Netzwerk gefunden: ${names}. Verwenden Sie „${ADDRESS_ACTION_LABEL.de}“ für jedes davon (die Adresse steht in der Tapo-App: Geräteeinstellungen > Geräteinfo).`,
      es: `No se encuentran en su red: ${names}. Use «${ADDRESS_ACTION_LABEL.es}» para cada uno (la dirección está en la aplicación Tapo: ajustes del dispositivo > Información del dispositivo).`,
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
