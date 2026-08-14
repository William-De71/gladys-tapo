// -----------------------------------------------------------------------------
// ONVIF events: motion and doorbell pushed by the camera (port 2020).
//
// Why this exists alongside the local API: `searchDetectionList` polls a camera
// for what already happened, so a motion is only noticed at the next round —
// up to `event_poll_interval` seconds late, and a short motion that starts and
// ends between two rounds is reported with that same delay. ONVIF inverts it:
// the camera holds the request open and answers the moment something happens,
// which is what turns a motion into a usable scene trigger.
//
// The protocol is plain SOAP over HTTP, so it is written out by hand here rather
// than pulling in a WSDL stack: the integration needs exactly three calls
// (GetServices, CreatePullPointSubscription, PullMessages) out of a standard
// covering hundreds, and a SOAP client would weigh more than the whole project.
//
// Authentication is WS-UsernameToken with a password digest — the CAMERA
// account created in the Tapo app, never the cloud account. Cameras that expose
// no camera account also expose no ONVIF, so the two travel together.
// -----------------------------------------------------------------------------

import crypto from 'node:crypto';
import http from 'node:http';
import { logger } from '@gladysassistant/integration-sdk';
import { ONVIF_PORT, ONVIF_PULL_TIMEOUT_SECONDS, ONVIF_REQUEST_TIMEOUT_MS } from './constants.js';

/** XML namespaces of the services this module and the PTZ client talk to. */
export const NS = {
  soap: 'http://www.w3.org/2003/05/soap-envelope',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  device: 'http://www.onvif.org/ver10/device/wsdl',
  events: 'http://www.onvif.org/ver10/events/wsdl',
  addressing: 'http://www.w3.org/2005/08/addressing',
  media: 'http://www.onvif.org/ver10/media/wsdl',
  ptz: 'http://www.onvif.org/ver20/ptz/wsdl',
  schema: 'http://www.onvif.org/ver10/schema',
};

/**
 * Consecutive failed pulls before the outage is reported at warn level.
 *
 * Three, because the first two are the ordinary ones: a subscription that
 * expired and a camera that rebooted both cost a pull, and both are recovered
 * from without anyone needing to know. By the third the camera is not answering
 * at all, and a silent motion sensor is worse than a noisy log.
 */
const ONVIF_FAILURES_BEFORE_WARNING = 3;

/**
 * Pause before reissuing a pull the camera ended quietly.
 *
 * Small enough to stay invisible on a motion — the next pull is waiting well
 * before anyone walks past — and large enough that a firmware closing the
 * connection immediately cannot turn the loop into a busy wait.
 */
const ONVIF_QUIET_PULL_PAUSE_MS = 250;

/** Password type declared by the UsernameToken digest profile. */
const PASSWORD_DIGEST_TYPE =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest';

/**
 * Escape the five characters XML cannot carry literally.
 *
 * Applied to the username and to the nonce/digest: a camera account may well
 * contain an `&` or a `<`, and an unescaped one would produce a malformed
 * envelope the camera answers with a parse fault rather than a clear rejection.
 * @param {string} value - The raw text.
 * @returns {string} The escaped text.
 * @example
 * escapeXml('a&b'); // 'a&amp;b'
 */
export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build the WS-Security header proving the camera account.
 *
 * The digest is `base64(sha1(nonce + created + password))`, with the nonce sent
 * in base64 and the timestamp in UTC — the camera recomputes it and compares.
 * The password itself never travels, which is why this profile is used over the
 * plaintext one even on a LAN.
 * @param {string} username - The camera account username.
 * @param {string} password - The camera account password.
 * @returns {string} The `<Security>` header.
 * @example
 * buildSecurityHeader('gladys', 'secret');
 */
export function buildSecurityHeader(username, password) {
  const nonce = crypto.randomBytes(16);
  const created = new Date().toISOString();
  const digest = crypto
    .createHash('sha1')
    .update(Buffer.concat([nonce, Buffer.from(created, 'utf8'), Buffer.from(password, 'utf8')]))
    .digest('base64');

  return (
    `<wsse:Security xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}">` +
    `<wsse:UsernameToken>` +
    `<wsse:Username>${escapeXml(username)}</wsse:Username>` +
    `<wsse:Password Type="${PASSWORD_DIGEST_TYPE}">${digest}</wsse:Password>` +
    `<wsse:Nonce>${nonce.toString('base64')}</wsse:Nonce>` +
    `<wsu:Created>${created}</wsu:Created>` +
    `</wsse:UsernameToken></wsse:Security>`
  );
}

/**
 * Wrap a SOAP body in the envelope the camera expects.
 * @param {string} body - The body XML.
 * @param {string} securityHeader - The WS-Security header.
 * @param {string} [extraHeader] - Addressing headers, when the call needs them.
 * @returns {string} The complete envelope.
 * @example
 * buildEnvelope('<tds:GetServices/>', header);
 */
export function buildEnvelope(body, securityHeader, extraHeader = '') {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<s:Envelope xmlns:s="${NS.soap}" xmlns:tds="${NS.device}" ` +
    `xmlns:tev="${NS.events}" xmlns:wsa="${NS.addressing}" ` +
    // Media and PTZ travel with the same envelope: the PTZ client below reuses
    // this builder, and a body referencing an undeclared prefix is answered with
    // a parse fault rather than a usable error.
    `xmlns:trt="${NS.media}" xmlns:tptz="${NS.ptz}" xmlns:tt="${NS.schema}">` +
    `<s:Header>${securityHeader}${extraHeader}</s:Header>` +
    `<s:Body>${body}</s:Body></s:Envelope>`
  );
}

/**
 * Read the text of the first matching element, whatever namespace prefix the
 * camera chose.
 *
 * Firmwares disagree on their prefixes (`tt:`, `wsnt:`, none at all), so the tag
 * is matched on its LOCAL name. A real XML parser would be more rigorous, but
 * these responses carry a handful of known fields and a dependency-free read
 * keeps the module in line with the rest of the integration.
 * @param {string} xml - The response body.
 * @param {string} localName - The tag name, without its prefix.
 * @returns {string|null} The text, or null when absent.
 * @example
 * readTag(xml, 'Address');
 */
export function readTag(xml, localName) {
  const pattern = new RegExp(
    `<(?:[\\w.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${localName}>`,
    'i',
  );
  const match = pattern.exec(String(xml || ''));
  return match ? match[1].trim() : null;
}

/**
 * Summarize a SOAP fault into something a log line can carry.
 *
 * `<Text>` alone is not enough: Tapo firmwares answer a rejected pull with a
 * bare "error", which says only that something went wrong — the whole reason
 * this was unreadable in production. What identifies the failure is the fault
 * SUBCODE (`ter:InvalidMessage`, `ter:ResourceUnknown`…), so the subcodes are
 * read first and the text is appended when it adds anything.
 *
 * Subcodes nest — `env:Subcode > env:Value` repeated — and it is the innermost
 * that names the ONVIF error, so every Value is collected in order.
 * @param {string} xml - The response body.
 * @returns {string} The summary, empty when the body carries no fault.
 * @example
 * faultSummary(xml); // 'ter:InvalidArgVal/ter:UnknownSubscription: error'
 */
export function faultSummary(xml) {
  const body = String(xml || '');
  const codes = [];
  // Walked as a token stream rather than matched as a block: subcodes NEST, and
  // a non-greedy `<Subcode>...</Subcode>` stops at the first closing tag — which
  // drops the innermost subcode, the one that actually names the ONVIF error.
  //
  // Only the Values under a Subcode are kept: the top-level `env:Code > Value`
  // is always Sender/Receiver and never tells two failures apart.
  const tokenPattern = /<(\/?)(?:[\w.-]+:)?(Subcode|Value)\b[^>]*>([\s\S]*?)(?=<)/gi;
  let depth = 0;
  let token = tokenPattern.exec(body);
  while (token !== null) {
    const [, closing, name, text] = token;
    if (name.toLowerCase() === 'subcode') {
      depth += closing ? -1 : 1;
    } else if (!closing && depth > 0 && text.trim()) {
      codes.push(text.trim());
    }
    token = tokenPattern.exec(body);
  }

  const text = readTag(body, 'Text') || readTag(body, 'faultstring') || '';
  const code = codes.join('/');
  if (code && text) {
    return `${code}: ${text}`;
  }
  return code || text;
}

/**
 * Tell whether a failed pull is the camera ending a quiet poll rather than a
 * real fault.
 *
 * Tapo firmwares close a `PullMessages` connection when they have nothing to
 * report, instead of answering the empty envelope the standard describes. Some
 * write a few bytes after their own `Connection: close`, which Node's HTTP
 * parser rejects. Both mean "nothing happened", and both used to be counted as
 * failures — tearing down a healthy subscription every few seconds.
 *
 * Deliberately narrow: a refused connection, a DNS failure or a SOAP fault are
 * NOT benign, and treating them as such would hide a camera that is genuinely
 * unreachable or rejecting the account behind an endless quiet loop.
 * @param {Error} error - The error the pull rejected with.
 * @returns {boolean} True when the pull can simply be reissued.
 * @example
 * isBenignDisconnect(new Error('socket hang up')); // true
 */
export function isBenignDisconnect(error) {
  const message = String(error?.message || '');
  if (error?.code === 'ECONNRESET') {
    return true;
  }
  return (
    message.includes('socket hang up') ||
    // Node's parser, on a firmware that trails bytes after its close header.
    message.includes('Data after `Connection: close`') ||
    message.includes('ONVIF_TIMEOUT')
  );
}

/**
 * POST a SOAP envelope and return the raw response body.
 *
 * A SOAP fault comes back with HTTP 500 and a body explaining why, so the body
 * is kept in the error: an ONVIF rejection is almost always a wrong camera
 * account, and that reason has to survive to the logs.
 * @param {string} url - The service URL.
 * @param {string} envelope - The envelope to send.
 * @param {number} [timeoutMs] - How long to wait.
 * @returns {Promise<string>} The response body.
 * @example
 * await postSoap('http://192.168.1.20:2020/onvif/device_service', envelope);
 */
export function postSoap(url, envelope, timeoutMs = ONVIF_REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port || ONVIF_PORT,
        path: target.pathname + target.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/soap+xml; charset=utf-8',
          'Content-Length': Buffer.byteLength(envelope),
        },
        timeout: timeoutMs,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          if (response.statusCode >= 400) {
            // The fault reason is the actionable part; the status alone is not.
            // A camera that answers a bare "error" leaves nothing to act on, so
            // the raw body is the last resort — trimmed, but enough to identify
            // a shape this code does not know how to read.
            const reason =
              faultSummary(body) ||
              body.replace(/\s+/g, ' ').trim().slice(0, 200) ||
              '(empty body)';
            reject(new Error(`ONVIF_HTTP_${response.statusCode}:${reason.slice(0, 200)}`));
            return;
          }
          resolve(body);
        });
      },
    );

    // A PullMessages request legitimately stays open for a minute waiting for a
    // motion, so the timeout is the caller's to choose, not a fixed one.
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('ONVIF_TIMEOUT'));
    });
    request.on('error', reject);
    request.end(envelope);
  });
}

/**
 * Turn an ONVIF topic into the kind of event the integration publishes.
 *
 * The topic is the only reliable discriminator: firmwares name their rules
 * freely ("MyMotion", "PeopleDetect"), but they all hang them under a standard
 * topic. Anything unrecognized yields null rather than a guessed motion — a
 * false motion firing a scene is worse than a missed one.
 * @param {string} topic - The `Topic` element content.
 * @returns {'doorbell'|'motion'|null} The kind, or null when unknown.
 * @example
 * classifyTopic('tns1:RuleEngine/CellMotionDetector/Motion'); // 'motion'
 */
export function classifyTopic(topic) {
  const normalized = String(topic || '').toLowerCase();
  if (!normalized) {
    return null;
  }
  // The doorbell ring is reported by Tapo under a device-specific topic; both
  // the standard `Visitor` and TP-Link's own spelling are accepted.
  if (
    normalized.includes('visitor') ||
    normalized.includes('doorbell') ||
    normalized.includes('button')
  ) {
    return 'doorbell';
  }
  if (
    normalized.includes('motion') ||
    normalized.includes('peopledetect') ||
    normalized.includes('person') ||
    normalized.includes('vehicle') ||
    normalized.includes('pet') ||
    normalized.includes('tamper')
  ) {
    return 'motion';
  }
  return null;
}

/**
 * Tell whether a `GetEventProperties` response declares a doorbell topic.
 *
 * This is how a camera says it HAS a button: the topic set lists everything the
 * firmware can ever emit, so a camera with no visitor/doorbell topic in it will
 * never ring — and a doorbell feature on such a device is a row that stays empty
 * forever, and a scene trigger that can never fire.
 *
 * Absence is only trusted when the response is a real topic set. An empty body,
 * a fault, or anything unparseable yields null rather than false: "the camera
 * said no" and "the camera did not answer" must not lead to the same decision,
 * since dropping the feature of a real doorbell breaks the user's scenes.
 * @param {string} xml - The response body.
 * @returns {boolean|null} True/false when known, null when undeterminable.
 * @example
 * hasDoorbellTopic(xml); // true on a D230
 */
export function hasDoorbellTopic(xml) {
  const text = String(xml || '');
  // The topic set is what makes the answer meaningful; without it there is
  // nothing to conclude from.
  const section = /<(?:[\w.-]+:)?TopicSet\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?TopicSet>/i.exec(text);
  if (!section) {
    return null;
  }

  // Topics are ELEMENT NAMES in the hierarchy, not text: a doorbell hangs under
  // something like `<tns1:Device><Trigger><Visitor wstop:topic="true"/>`. Every
  // tag name is therefore collected and classified with the same rules as a
  // live event, so the two paths cannot drift apart.
  const names = section[1].match(/<(?:[\w.-]+:)?([\w.-]+)/g) || [];
  return names.some((name) => classifyTopic(name) === 'doorbell');
}

/**
 * Extract the events from a `PullMessages` response.
 *
 * ONVIF reports both edges of a detection: a message carries a `SimpleItem`
 * whose value is true when the motion starts and false when it ends. Both are
 * returned, because the falling edge is precisely what the polled path could
 * never provide — it is what lets a motion sensor come back down on the
 * camera's schedule instead of an arbitrary timer.
 * @param {string} xml - The response body.
 * @returns {Array<{ kind: string, active: boolean, at: number }>} The events.
 * @example
 * parsePullMessages(xml);
 */
export function parsePullMessages(xml) {
  const events = [];
  // One `NotificationMessage` per event; splitting on the opening tag keeps the
  // topic and its data together, whatever prefix the firmware used.
  const chunks = String(xml || '').split(/<(?:[\w.-]+:)?NotificationMessage\b/i);

  chunks.slice(1).forEach((chunk) => {
    const kind = classifyTopic(readTag(chunk, 'Topic'));
    if (!kind) {
      return;
    }

    // The state lives in a `SimpleItem` whose Name varies (State, IsMotion,
    // IsPeople…), so the VALUE is what is read: ONVIF constrains it to a
    // boolean for these topics, and its absence means a stateless event — a
    // doorbell ring — which is always an activation.
    const valueMatch = /<(?:[\w.-]+:)?SimpleItem\b[^>]*\bValue="([^"]*)"/i.exec(chunk);
    const raw = valueMatch ? valueMatch[1].toLowerCase() : null;
    const active = raw === null ? true : raw === 'true' || raw === '1';

    // `UtcTime` is an ATTRIBUTE of `<tt:Message>`, not an element — reading it
    // as a tag silently found nothing and every event fell back to "now",
    // which looks right until two events pulled together share a timestamp.
    const timeMatch = /\bUtcTime="([^"]+)"/i.exec(chunk);
    const parsed = timeMatch ? Date.parse(timeMatch[1]) : NaN;

    events.push({ kind, active, at: Number.isFinite(parsed) ? parsed : Date.now() });
  });

  return events;
}

/**
 * ONVIF event client for ONE camera.
 *
 * It owns the pull point subscription and the long-poll loop. Nothing is shared
 * between cameras: a subscription is bound to the camera that issued it, and a
 * camera that stops answering must not hold up the others.
 * @example
 * const client = new TapoOnvif('192.168.1.20', 'gladys', 'secret');
 * client.start((event) => console.log(event.kind, event.active));
 */
export class TapoOnvif {
  /**
   * @param {string} ip - The camera address.
   * @param {string} username - The camera account username.
   * @param {string} password - The camera account password.
   */
  constructor(ip, username, password) {
    this.ip = ip;
    this.username = username;
    this.password = password;

    this.deviceUrl = `http://${ip}:${ONVIF_PORT}/onvif/device_service`;
    /**
     * URL of the Events service, read from the capabilities.
     *
     * NOT the device service: measured on a C210, the camera serves its device
     * management on `/onvif/device_service` but every other service —  Events
     * included — on `/onvif/service`. Subscribing on the device URL is answered
     * with a fault, so the address is read rather than assumed.
     * @type {string|null}
     */
    this.eventsUrl = null;
    /** URL of the pull point, handed out by the camera at subscription. @type {string|null} */
    this.pullPointUrl = null;
    /** @type {((event: object) => void)|null} */
    this.onEvent = null;
    this.running = false;
    /** Consecutive failures, used to back off a camera that stopped answering. */
    this.failures = 0;
  }

  /**
   * Send one authenticated call to a service.
   * @param {string} url - The service URL.
   * @param {string} body - The SOAP body.
   * @param {object} [options] - Call options.
   * @param {number} [options.timeoutMs] - How long to wait.
   * @param {string} [options.extraHeader] - Extra SOAP headers.
   * @returns {Promise<string>} The response body.
   * @example
   * await client.call(url, '<tds:GetServices/>');
   */
  call(url, body, { timeoutMs, extraHeader } = {}) {
    // A fresh security header per call: the digest carries a timestamp the
    // camera checks against its own clock, so a reused one is eventually
    // rejected as a replay.
    const envelope = buildEnvelope(
      body,
      buildSecurityHeader(this.username, this.password),
      extraHeader,
    );
    return postSoap(url, envelope, timeoutMs);
  }

  /**
   * Check that the camera answers ONVIF with these credentials.
   *
   * Used before anything is subscribed, so a wrong camera account surfaces as a
   * clear rejection instead of a subscription that silently never fires.
   * @returns {Promise<boolean>} True when ONVIF is usable.
   * @example
   * await client.probe();
   */
  async probe() {
    try {
      const xml = await this.call(this.deviceUrl, '<tds:GetDeviceInformation/>');
      return Boolean(readTag(xml, 'Manufacturer'));
    } catch (e) {
      logger.debug(`ONVIF probe of ${this.ip} failed: ${e.message}`);
      return false;
    }
  }

  /**
   * Read the capabilities: where the Events service lives, and whether the
   * camera supports pull points at all.
   *
   * Both answers come from the same call, and both are needed before any
   * subscription: a camera declaring `WSPullPointSupport` false would accept the
   * subscription and then never deliver anything.
   * @returns {Promise<{ eventsUrl: string|null, pullPoint: boolean }>} What the
   * camera declares.
   * @example
   * const { eventsUrl, pullPoint } = await client.getCapabilities();
   */
  async getCapabilities() {
    const xml = await this.call(
      this.deviceUrl,
      '<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>',
    );

    // The Events section carries its own XAddr; reading the first XAddr of the
    // document would pick up Analytics instead, which is the section before it.
    const section = /<(?:[\w.-]+:)?Events\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Events>/i.exec(xml);
    const scope = section ? section[1] : '';
    const address = readTag(scope, 'XAddr');
    const pullPoint = (readTag(scope, 'WSPullPointSupport') || '').toLowerCase() !== 'false';

    if (address) {
      // Same reasoning as for the pull point address: keep the path the camera
      // chose, but reach it on the address that is known to work.
      const target = new URL(address);
      this.eventsUrl = `http://${this.ip}:${ONVIF_PORT}${target.pathname}${target.search}`;
    }
    return { eventsUrl: this.eventsUrl, pullPoint };
  }

  /**
   * Ask the camera whether it can ever report a doorbell press.
   *
   * Answered from the topic set rather than from the model name: TP-Link ships
   * doorbells and plain cameras under neighbouring references, and this project
   * already learned (see `NO_LOCAL_ACCESS_MODELS`) that a capability guessed
   * from a model string is a capability guessed wrong.
   * @returns {Promise<boolean|null>} True/false when known, null when the camera
   * could not be asked.
   * @example
   * const hasButton = await client.hasDoorbell();
   */
  async hasDoorbell() {
    try {
      if (!this.eventsUrl) {
        await this.getCapabilities();
      }
      const xml = await this.call(this.eventsUrl || this.deviceUrl, '<tev:GetEventProperties/>');
      return hasDoorbellTopic(xml);
    } catch (e) {
      // Null, never false: a camera that refused the call has said nothing about
      // its button, and dropping the feature of a real doorbell would silently
      // break the scenes built on it.
      logger.debug(`Reading the event topics of ${this.ip} failed: ${e.message}`);
      return null;
    }
  }

  /**
   * Open a pull point subscription and remember where to pull from.
   *
   * The camera answers with the address of a subscription created FOR this
   * client; pulling from the events service instead returns nothing, which is
   * the failure mode this method exists to avoid.
   * @returns {Promise<void>} Resolves once the subscription is open.
   * @example
   * await client.subscribe();
   */
  async subscribe() {
    if (!this.eventsUrl) {
      const { pullPoint } = await this.getCapabilities();
      if (!pullPoint) {
        // Saying so explicitly: the caller falls back to polling, and a silent
        // subscription that never fires would look like a broken sensor.
        throw new Error('ONVIF_NO_PULLPOINT_SUPPORT');
      }
    }

    // The initial termination time is a bound, not a promise: every pull renews
    // it, and a subscription the integration stops pulling expires on its own
    // instead of lingering on the camera.
    //
    // Some firmwares reject it outright — measured on a C500, which answers
    // `ter:InvalidArgVal` to the very same request another Tapo camera accepts.
    // The element is OPTIONAL in the standard, so a camera that refuses it gets
    // asked again without it and picks its own default. Without this fallback
    // that camera got no subscription at all, and its motion sensor stayed dead
    // while its neighbour worked.
    const subscribe = (body) => this.call(this.eventsUrl || this.deviceUrl, body);
    const xml = await subscribe(
      '<tev:CreatePullPointSubscription>' +
        '<tev:InitialTerminationTime>PT10M</tev:InitialTerminationTime>' +
        '</tev:CreatePullPointSubscription>',
    ).catch((e) => {
      if (!String(e.message).includes('InvalidArgVal')) {
        throw e;
      }
      logger.debug(
        `${this.ip} refused the subscription termination time, asking without it: ${e.message}`,
      );
      return subscribe('<tev:CreatePullPointSubscription/>');
    });

    const address = readTag(xml, 'Address');
    if (!address) {
      throw new Error('ONVIF_NO_PULLPOINT');
    }
    // Some firmwares hand back an address pointing at a hostname the LAN cannot
    // resolve, or at the camera's own idea of its IP behind a NAT. The host is
    // therefore forced back to the address we reached it on, which is known to
    // work — only the path the camera chose is kept.
    const target = new URL(address);
    this.pullPointUrl = `http://${this.ip}:${ONVIF_PORT}${target.pathname}${target.search}`;
    logger.debug(`ONVIF subscription open on ${this.ip}`);
  }

  /**
   * Pull the events the camera accumulated, waiting for one if there is none.
   *
   * This is the call that makes the whole module worthwhile: the camera holds
   * it open until something happens, so an event reaches Gladys within a second
   * of the detection rather than at the next poll.
   * @returns {Promise<object[]>} The events, possibly empty on timeout.
   * @example
   * const events = await client.pull();
   */
  async pull() {
    if (!this.pullPointUrl) {
      await this.subscribe();
    }

    const xml = await this.call(
      this.pullPointUrl,
      '<tev:PullMessages>' +
        `<tev:Timeout>PT${ONVIF_PULL_TIMEOUT_SECONDS}S</tev:Timeout>` +
        // Bounded: a camera that buffered a burst of detections must not answer
        // with hundreds of messages, all of which collapse to one motion anyway.
        '<tev:MessageLimit>32</tev:MessageLimit>' +
        '</tev:PullMessages>',
      {
        // The camera is EXPECTED to hold this open for the full timeout, so the
        // socket must outlive it — with a margin, since the answer still has to
        // travel. Using the default here would kill every quiet pull as a
        // failure and resubscribe in a loop.
        timeoutMs: (ONVIF_PULL_TIMEOUT_SECONDS + 10) * 1000,
        extraHeader: `<wsa:Action>${NS.events}/PullPointSubscription/PullMessages</wsa:Action>`,
      },
    );

    const events = parsePullMessages(xml);

    // A quiet pull returns an empty envelope, and logging those would drown the
    // logs at one entry per timeout per camera. What is worth seeing is a camera
    // that DID report something: either the events read from it, or — when
    // nothing was understood — the payload itself, which is the only way to tell
    // an unknown topic apart from a message shape this parser mishandles.
    if (xml.includes('NotificationMessage')) {
      if (events.length > 0) {
        logger.debug(
          `ONVIF events from ${this.ip}: ${events.map((event) => `${event.kind}=${event.active}`).join(', ')}`,
        );
      } else {
        logger.debug(`ONVIF message from ${this.ip} yielded no event, raw payload: ${xml}`);
      }
    }

    return events;
  }

  /**
   * Start the long-poll loop.
   *
   * Runs until `stop()`, re-subscribing whenever the camera drops the
   * subscription — which it does on reboot, and silently after an idle period on
   * some firmwares.
   * @param {(event: object) => void} onEvent - Called for each event.
   * @example
   * client.start((event) => { ... });
   */
  start(onEvent) {
    if (this.running) {
      return;
    }
    this.onEvent = onEvent;
    this.running = true;
    this.loop().catch((e) => logger.debug(`ONVIF loop of ${this.ip} ended: ${e.message}`));
  }

  /**
   * The loop itself: pull, dispatch, repeat.
   * @returns {Promise<void>} Resolves when the loop stops.
   * @example
   * await client.loop();
   */
  async loop() {
    while (this.running) {
      try {
        const events = await this.pull();
        // Pair of the warning above: an outage that was announced must have its
        // recovery announced too, or the log leaves the camera looking broken
        // long after it came back.
        if (this.failures >= ONVIF_FAILURES_BEFORE_WARNING) {
          logger.info(`ONVIF events are being read from ${this.ip} again`);
        }
        // A successful pull clears the backoff: a camera that answered once is
        // healthy again, whether or not it had anything to report.
        this.failures = 0;
        events.forEach((event) => {
          if (this.onEvent) {
            this.onEvent(event);
          }
        });
      } catch (e) {
        if (!this.running) {
          return;
        }

        // A Tapo firmware ends a quiet pull by cutting the connection instead of
        // answering an empty envelope — sometimes writing bytes after its own
        // `Connection: close`, which Node's parser refuses. That is not a
        // failure: nothing was lost, the camera simply had nothing to report.
        //
        // Treating it as one is what broke motion detection. Every cut tore the
        // subscription down (`pullPointUrl = null`) and backed off for seconds,
        // so the camera spent its time re-subscribing instead of watching, and a
        // motion arriving in that gap was never seen. The subscription is KEPT
        // and the next pull goes straight back out.
        if (isBenignDisconnect(e)) {
          logger.debug(`ONVIF pull on ${this.ip} ended quietly (${e.message}), pulling again`);
          // A short breath before reissuing. The camera normally holds the pull
          // for seconds, so this costs nothing — but a firmware that closed
          // INSTANTLY would otherwise spin this loop as fast as the network
          // allows, burning CPU and hammering the camera.
          await new Promise((resolve) => setTimeout(resolve, ONVIF_QUIET_PULL_PAUSE_MS));
          continue;
        }

        this.failures += 1;
        // The subscription is the first suspect: it expires, and a rebooted
        // camera forgets it. Dropping it forces the next round to open a new one.
        this.pullPointUrl = null;
        // Backing off rather than hammering: a camera that is off, asleep or
        // unplugged would otherwise be retried in a tight loop for as long as it
        // stays away. Capped so a camera coming back is picked up within a minute.
        const waitMs = Math.min(60_000, 2_000 * this.failures);
        logger.debug(
          `ONVIF pull on ${this.ip} failed (${this.failures}): ${e.message} — retrying in ${waitMs / 1000}s`,
        );
        // Said ONCE, out loud, when the failures stop looking accidental. A
        // single failure is ordinary — a camera rebooting, a subscription that
        // expired — and the loop recovers from it by itself. A run of them means
        // motion detection is DEAD on that camera, and that used to be visible
        // only at debug level: the sensor silently stopped reporting, with
        // nothing anywhere to say so. Logged once per outage rather than per
        // pull, so a camera that is off for the night costs one line, not one a
        // minute; `failures` is reset to 0 by the first successful pull, which
        // re-arms the warning for the next outage.
        if (this.failures === ONVIF_FAILURES_BEFORE_WARNING) {
          logger.warn(
            `No ONVIF event could be read from ${this.ip} after ${this.failures} attempts ` +
              `(${e.message}). Motion detection is not working on this camera; ` +
              `it keeps retrying every ${Math.round(waitMs / 1000)}s.`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }

  /**
   * Stop the loop and release the subscription.
   *
   * The in-flight pull is left to finish on its own: it is a plain HTTP request
   * that times out within the minute, and the loop checks `running` before
   * doing anything with what it returns.
   * @example
   * client.stop();
   */
  stop() {
    this.running = false;
    const url = this.pullPointUrl;
    this.pullPointUrl = null;
    if (!url) {
      return;
    }
    // Best effort: the camera expires the subscription on its own anyway, but
    // unsubscribing frees the slot now rather than in ten minutes — and the
    // firmware only keeps a few.
    this.call(url, '<tev:Unsubscribe/>', { timeoutMs: 3000 }).catch(() => {});
  }
}
