import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeXml,
  buildSecurityHeader,
  readTag,
  classifyTopic,
  parsePullMessages,
  hasDoorbellTopic,
  faultSummary,
  isBenignDisconnect,
  TapoOnvif,
} from '../src/tapo/onvif.js';

// The envelope a C210 actually answered `GetCapabilities` with, trimmed to the
// Events section. Kept verbatim — including the `tt:`/`SOAP-ENV:` prefixes and
// the Analytics section that precedes it — because those are exactly what a
// hand-written parser gets wrong.
const REAL_CAPABILITIES = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
<SOAP-ENV:Body><tds:GetCapabilitiesResponse><tds:Capabilities>
<tt:Analytics><tt:XAddr>http://10.0.50.11:2020/onvif/service</tt:XAddr><tt:RuleSupport>true</tt:RuleSupport></tt:Analytics>
<tt:Events><tt:XAddr>http://10.0.50.11:2020/onvif/service</tt:XAddr><tt:WSSubscriptionPolicySupport>true</tt:WSSubscriptionPolicySupport><tt:WSPullPointSupport>true</tt:WSPullPointSupport></tt:Events>
</tds:Capabilities></tds:GetCapabilitiesResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

test('the XML escaping covers the characters a password may carry', () => {
  // A camera account password is user-chosen: an unescaped `&` produces an
  // envelope the camera rejects as malformed rather than as a bad password.
  assert.equal(escapeXml('a&b<c>"d\''), 'a&amp;b&lt;c&gt;&quot;d&apos;');
  assert.equal(escapeXml(undefined), '');
});

test('the security header carries a digest, never the password itself', () => {
  const header = buildSecurityHeader('gladys', 'MonMotDePasse');
  assert.ok(header.includes('<wsse:Username>gladys</wsse:Username>'));
  assert.ok(!header.includes('MonMotDePasse'), 'the password must not travel in clear');
  assert.ok(header.includes('PasswordDigest'));
  assert.ok(/<wsse:Nonce>[A-Za-z0-9+/=]+<\/wsse:Nonce>/.test(header));
});

test('two headers built in a row use different nonces', () => {
  // A reused nonce is what a replay looks like; the camera rejects it.
  const first = /<wsse:Nonce>([^<]+)</.exec(buildSecurityHeader('u', 'p'))[1];
  const second = /<wsse:Nonce>([^<]+)</.exec(buildSecurityHeader('u', 'p'))[1];
  assert.notEqual(first, second);
});

test('a tag is read whatever namespace prefix the firmware chose', () => {
  assert.equal(readTag('<tt:XAddr>http://x/y</tt:XAddr>', 'XAddr'), 'http://x/y');
  assert.equal(readTag('<XAddr>http://x/y</XAddr>', 'XAddr'), 'http://x/y');
  assert.equal(readTag('<wsnt:Topic Dialect="z">a/b</wsnt:Topic>', 'Topic'), 'a/b');
  assert.equal(readTag('<tt:Other>v</tt:Other>', 'XAddr'), null);
});

test('the Events XAddr is read from its own section, not from Analytics', () => {
  // Both sections carry an XAddr here. Reading the first one in the document
  // would silently subscribe against the Analytics service.
  const section = /<(?:[\w.-]+:)?Events\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Events>/i.exec(
    REAL_CAPABILITIES,
  );
  assert.ok(section, 'the Events section must be found');
  assert.equal(readTag(section[1], 'XAddr'), 'http://10.0.50.11:2020/onvif/service');
  assert.equal(readTag(section[1], 'WSPullPointSupport'), 'true');
});

test('the events service path is not the device service path', () => {
  // Measured on a C210: device management lives on /onvif/device_service while
  // Events lives on /onvif/service. Assuming one address for both makes every
  // subscription fail.
  const client = new TapoOnvif('10.0.50.11', 'u', 'p');
  assert.equal(client.deviceUrl, 'http://10.0.50.11:2020/onvif/device_service');
  assert.equal(client.eventsUrl, null, 'the events URL is only known after the capabilities call');
});

test('topics are classified into the events the integration publishes', () => {
  assert.equal(classifyTopic('tns1:RuleEngine/CellMotionDetector/Motion'), 'motion');
  assert.equal(classifyTopic('tns1:RuleEngine/MyRuleDetector/PeopleDetect'), 'motion');
  assert.equal(classifyTopic('tns1:Device/Trigger/Visitor'), 'doorbell');
  assert.equal(classifyTopic('tns1:Device/HardwareFailure/StorageFailure'), null);
  assert.equal(classifyTopic(''), null);
});

test('a pull answer yields the rising and the falling edge', () => {
  // The falling edge is what ONVIF adds over polling: without it the sensor
  // could only come back down on a timer.
  const xml = `<SOAP-ENV:Envelope><SOAP-ENV:Body><tev:PullMessagesResponse>
    <wsnt:NotificationMessage>
      <wsnt:Topic Dialect="xpath">tns1:RuleEngine/CellMotionDetector/Motion</wsnt:Topic>
      <wsnt:Message><tt:Message UtcTime="2026-08-02T16:30:00Z">
        <tt:Data><tt:SimpleItem Name="IsMotion" Value="true"/></tt:Data>
      </tt:Message></wsnt:Message>
    </wsnt:NotificationMessage>
    <wsnt:NotificationMessage>
      <wsnt:Topic Dialect="xpath">tns1:RuleEngine/CellMotionDetector/Motion</wsnt:Topic>
      <wsnt:Message><tt:Message UtcTime="2026-08-02T16:30:20Z">
        <tt:Data><tt:SimpleItem Name="IsMotion" Value="false"/></tt:Data>
      </tt:Message></wsnt:Message>
    </wsnt:NotificationMessage>
  </tev:PullMessagesResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

  const events = parsePullMessages(xml);
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((event) => [event.kind, event.active]),
    [
      ['motion', true],
      ['motion', false],
    ],
  );
  assert.ok(events[1].at > events[0].at, 'the timestamps must be read, not invented');
});

test('an event carrying no value is an activation', () => {
  // A doorbell ring is an instant, not a state: it has no falling edge to wait
  // for, and treating a missing value as "inactive" would drop the press.
  const xml = `<wsnt:NotificationMessage>
    <wsnt:Topic>tns1:Device/Trigger/Visitor</wsnt:Topic>
    <wsnt:Message><tt:Message UtcTime="2026-08-02T16:30:00Z"/></wsnt:Message>
  </wsnt:NotificationMessage>`;
  const events = parsePullMessages(xml);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'doorbell');
  assert.equal(events[0].active, true);
});

test('an empty pull yields nothing rather than a spurious event', () => {
  // The quiet case is the common one: the camera holds the request open for a
  // minute and answers with an empty list.
  const xml = `<SOAP-ENV:Envelope><SOAP-ENV:Body>
    <tev:PullMessagesResponse><tev:CurrentTime>2026-08-02T16:30:00Z</tev:CurrentTime>
    </tev:PullMessagesResponse></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
  assert.deepEqual(parsePullMessages(xml), []);
  assert.deepEqual(parsePullMessages(''), []);
});

test('an unrecognized topic is dropped instead of guessed as motion', () => {
  // A false motion fires a scene; a missed one does not. The asymmetry is why
  // an unknown topic yields nothing.
  const xml = `<wsnt:NotificationMessage>
    <wsnt:Topic>tns1:Monitoring/ProcessorUsage</wsnt:Topic>
    <wsnt:Message><tt:Message><tt:Data>
      <tt:SimpleItem Name="Value" Value="true"/></tt:Data></tt:Message></wsnt:Message>
  </wsnt:NotificationMessage>`;
  assert.deepEqual(parsePullMessages(xml), []);
});

test('a pull point address is reached on the IP we know, keeping its path', () => {
  // Firmwares hand back an address built from their own idea of the network —
  // a hostname the LAN cannot resolve, or an IP behind a NAT. Only the path is
  // trustworthy.
  const client = new TapoOnvif('10.0.50.11', 'u', 'p');
  const address = 'http://camera-internal.local:2020/onvif/Subscription?Idx=7';
  const target = new URL(address);
  const rebuilt = `http://${client.ip}:2020${target.pathname}${target.search}`;
  assert.equal(rebuilt, 'http://10.0.50.11:2020/onvif/Subscription?Idx=7');
});

// --- Doorbell capability ------------------------------------------------------

test('a topic set listing a visitor topic means the camera has a button', () => {
  const xml = `<tev:GetEventPropertiesResponse><wstop:TopicSet>
<tns1:Device><Trigger><Visitor wstop:topic="true"/></Trigger></tns1:Device>
</wstop:TopicSet></tev:GetEventPropertiesResponse>`;
  assert.equal(hasDoorbellTopic(xml), true);
});

test('a topic set without any visitor topic means no button', () => {
  // A plain camera: it reports motion and nothing else, so a doorbell feature on
  // it would stay empty forever and its scene trigger could never fire.
  const xml = `<tev:GetEventPropertiesResponse><wstop:TopicSet>
<tns1:RuleEngine><CellMotionDetector><Motion wstop:topic="true"/></CellMotionDetector></tns1:RuleEngine>
</wstop:TopicSet></tev:GetEventPropertiesResponse>`;
  assert.equal(hasDoorbellTopic(xml), false);
});

test('an unreadable answer says NOTHING rather than "no button"', () => {
  // The distinction that matters: "the camera said no" and "the camera did not
  // answer" must not lead to the same decision. Dropping the button of a real
  // doorbell silently breaks every scene built on it.
  assert.equal(hasDoorbellTopic(''), null);
  assert.equal(hasDoorbellTopic(undefined), null);
  assert.equal(
    hasDoorbellTopic('<soap:Fault><faultstring>denied</faultstring></soap:Fault>'),
    null,
  );
});

test('the doorbell topic is classified by the same rules as a live event', () => {
  // Both paths share `classifyTopic`, so a spelling accepted at runtime is
  // accepted at discovery too — they cannot drift apart.
  const xml =
    '<wstop:TopicSet><tns1:Device><IsDoorbell wstop:topic="true"/></tns1:Device></wstop:TopicSet>';
  assert.equal(hasDoorbellTopic(xml), true);
});

// --- Pull loop reporting ------------------------------------------------------

test('a run of failed pulls is reported once, and so is the recovery', async () => {
  // Motion detection dying used to be a debug-level event: the sensor stopped
  // reporting and nothing anywhere said why. A single failure stays quiet — a
  // camera rebooting recovers on its own — but a run of them must be visible,
  // and exactly once, or a camera off for the night writes a line a minute.
  const client = new TapoOnvif('10.0.0.5', 'user', 'pass');
  const warnings = [];
  const infos = [];
  const { logger } = await import('@gladysassistant/integration-sdk');
  const realWarn = logger.warn;
  const realInfo = logger.info;
  logger.warn = (message) => warnings.push(message);
  logger.info = (message) => infos.push(message);

  let pulls = 0;
  client.pull = async () => {
    pulls += 1;
    // Fails four times, then recovers.
    if (pulls <= 4) {
      throw new Error('TIMEOUT');
    }
    client.running = false;
    return [];
  };

  const realSetTimeout = globalThis.setTimeout;
  // The loop backs off between attempts; the waits are not what is under test.
  globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
  try {
    client.running = true;
    await client.loop();
    assert.equal(warnings.length, 1, 'one warning per outage, not one per pull');
    assert.match(warnings[0], /10\.0\.0\.5/);
    assert.match(warnings[0], /Motion detection is not working/);
    assert.equal(infos.length, 1, 'the recovery must be announced too');
    assert.match(infos[0], /again/);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    logger.warn = realWarn;
    logger.info = realInfo;
  }
});

// --- SOAP fault reporting -----------------------------------------------------

test('the fault subcode survives a camera that only says "error"', () => {
  // Measured shape: a Tapo firmware rejects a pull with HTTP 400 and a Text of
  // just "error", which reported nothing anyone could act on. The subcode is
  // what names the failure, and the innermost one is the ONVIF-specific one.
  const xml =
    '<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope">' +
    '<env:Body><env:Fault><env:Code><env:Value>env:Sender</env:Value>' +
    '<env:Subcode><env:Value>ter:InvalidArgVal</env:Value>' +
    '<env:Subcode><env:Value>ter:UnknownSubscription</env:Value></env:Subcode>' +
    '</env:Subcode></env:Code>' +
    '<env:Reason><env:Text xml:lang="en">error</env:Text></env:Reason>' +
    '</env:Fault></env:Body></env:Envelope>';
  const summary = faultSummary(xml);
  assert.match(summary, /ter:UnknownSubscription/, 'the innermost subcode identifies the fault');
  assert.match(summary, /ter:InvalidArgVal/, 'the outer subcode is kept as context');
  assert.match(summary, /error/, 'the text is appended when it adds anything');
});

test('a fault with no subcode still reports its text', () => {
  const xml =
    '<env:Envelope><env:Body><env:Fault>' +
    '<env:Reason><env:Text>Action not supported</env:Text></env:Reason>' +
    '</env:Fault></env:Body></env:Envelope>';
  assert.equal(faultSummary(xml), 'Action not supported');
});

test('a body carrying no fault at all summarizes to nothing', () => {
  // Which is what makes the caller fall back to the raw body: an unparsed shape
  // must not be reported as an empty reason, the failure this whole change is
  // about.
  assert.equal(faultSummary('<html><body>Bad Request</body></html>'), '');
  assert.equal(faultSummary(''), '');
});

// --- Quiet pulls --------------------------------------------------------------

test('a camera closing a quiet pull is not treated as a failure', () => {
  // Measured on a C210/C500: instead of answering an empty envelope, the
  // firmware cuts the connection — sometimes trailing bytes after its own
  // `Connection: close`, which Node's parser rejects. Counting those as
  // failures tore down a healthy subscription every few seconds, which is what
  // left motion detection dead.
  assert.equal(isBenignDisconnect(new Error('socket hang up')), true);
  assert.equal(isBenignDisconnect(new Error('Parse Error: Data after `Connection: close`')), true);
  assert.equal(isBenignDisconnect(new Error('ONVIF_TIMEOUT')), true);
  const reset = new Error('read ECONNRESET');
  reset.code = 'ECONNRESET';
  assert.equal(isBenignDisconnect(reset), true);
});

test('a real fault is never mistaken for a quiet pull', () => {
  // The other half of the rule: hiding these behind an endless quiet loop would
  // bury a camera that is unreachable or refusing the account.
  assert.equal(isBenignDisconnect(new Error('connect ECONNREFUSED 10.0.0.5:2020')), false);
  assert.equal(isBenignDisconnect(new Error('ONVIF_HTTP_401:ter:NotAuthorized')), false);
  assert.equal(isBenignDisconnect(new Error('getaddrinfo ENOTFOUND camera')), false);
  assert.equal(isBenignDisconnect(undefined), false);
});

test('a quiet pull keeps the subscription and pulls again', async () => {
  // The point of the fix: the pull point must SURVIVE, or the camera spends its
  // time re-subscribing instead of watching.
  const client = new TapoOnvif('10.0.0.7', 'user', 'pass');
  client.pullPointUrl = 'http://10.0.0.7:2020/onvif/sub1';

  let pulls = 0;
  client.pull = async () => {
    pulls += 1;
    if (pulls === 1) {
      throw new Error('socket hang up');
    }
    client.running = false;
    return [];
  };

  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
  try {
    client.running = true;
    await client.loop();
    assert.equal(pulls, 2, 'the pull is reissued');
    assert.equal(client.failures, 0, 'a quiet pull is not a failure');
    assert.equal(
      client.pullPointUrl,
      'http://10.0.0.7:2020/onvif/sub1',
      'the subscription must not be torn down',
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});
