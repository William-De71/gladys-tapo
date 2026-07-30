import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(
  readFileSync(new URL('../gladys-assistant-integration.json', import.meta.url)),
);

test('the manifest declares the fields Gladys requires', () => {
  for (const field of [
    'manifest_version',
    'type',
    'name',
    'version',
    'docker_image',
    'gladys_version',
  ]) {
    assert.ok(manifest[field], `${field} is required`);
  }
  assert.equal(manifest.type, 'device');
});

test('the manifest respects the length limits Gladys enforces', () => {
  // Gladys rejects the whole manifest — with a generic "invalid manifest"
  // message — when these bounds are exceeded, so they are worth pinning.
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30, 'name must be 3-30 chars');
  for (const [lang, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length >= 10 && text.length <= 100,
      `description.${lang} must be 10-100 chars, got ${text.length}`,
    );
  }
  assert.ok(manifest.description.en, 'the en description is mandatory');
});

test('the manifest root fields match the documented contract', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'strict semver');
  assert.ok(manifest.cover_image.startsWith('https://'), 'cover_image must be https');
  assert.ok(manifest.transports.every((transport) => ['local', 'cloud'].includes(transport)));
  assert.ok(manifest.actions.length >= 1 && manifest.actions.length <= 10, '1 to 10 actions');
  for (const action of manifest.actions) {
    if (action.timeout_seconds !== undefined) {
      assert.ok(
        action.timeout_seconds >= 5 && action.timeout_seconds <= 120,
        `${action.key}: timeout_seconds must be 5-120`,
      );
    }
  }
});

test('every config field carries the parts the Configuration screen renders', () => {
  for (const field of manifest.config_schema) {
    assert.ok(field.key, 'a config field needs a key');
    assert.match(field.key, /^[a-z0-9_]+$/, `${field.key}: invalid key`);
    assert.ok(field.label && field.label.en, `${field.key}: an en label is mandatory`);
    if (field.type === 'section') {
      // A section stores no value: declaring these would reject the manifest.
      assert.equal(field.required, undefined, `${field.key}: a section has no "required"`);
      assert.equal(field.default, undefined, `${field.key}: a section has no "default"`);
      assert.equal(field.placeholder, undefined, `${field.key}: a section has no "placeholder"`);
    }
    for (const link of field.links || []) {
      assert.ok(link.url.startsWith('https://'), `${field.key}: links must be https`);
    }
    for (const [lang, text] of Object.entries(field.description || {})) {
      assert.ok(text.length <= 1000, `${field.key}.${lang}: description must be <= 1000 chars`);
    }
  }
});

test('the passwords are declared as secrets, never as plain strings', () => {
  // A `string` field would render the password in clear in the Configuration screen.
  for (const key of ['password', 'rtsp_password']) {
    const field = manifest.config_schema.find((entry) => entry.key === key);
    assert.ok(field, `${key} must be declared`);
    assert.equal(field.type, 'secret', `${key} must be a secret`);
  }
});

test('every select declares options containing its default', () => {
  for (const field of manifest.config_schema.filter((entry) => entry.type === 'select')) {
    assert.ok(
      Array.isArray(field.options) && field.options.length > 0,
      `${field.key}: options are mandatory`,
    );
    for (const option of field.options) {
      assert.ok(option.value && option.label && option.label.en, `${field.key}: malformed option`);
    }
    if (field.default !== undefined) {
      assert.ok(
        field.options.some((option) => option.value === field.default),
        `${field.key}: the default must be one of the options`,
      );
    }
  }
});

test('the default capture timeout stays under the onGetImage budget', () => {
  // Gladys waits 15 s for an image, so the DEFAULT must fit in that window.
  // The maximum is deliberately higher: a battery camera on the proprietary
  // protocol can need longer, and the scheduled refresh has no such deadline.
  const field = manifest.config_schema.find((entry) => entry.key === 'capture_timeout');
  assert.ok(
    field.default <= 14,
    `capture_timeout default must stay under 15s, got ${field.default}`,
  );
  assert.ok(field.max >= field.default, 'the max must leave room above the default');
});

test('the manifest version matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(manifest.version, pkg.version);
  // The release workflow keeps the image tag in lockstep with the version.
  assert.ok(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    'docker_image must be tagged with the manifest version',
  );
});

test('the config defaults agree with the ones the code falls back to', async () => {
  // A drift here means the user sees one value in the form and the integration
  // uses another.
  const { DEFAULT_CONFIG } = await import('../src/config.js');
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    const field = manifest.config_schema.find((entry) => entry.key === key);
    assert.ok(field, `${key} must be declared in the config_schema`);
    assert.equal(field.default, value, `${key}: default drift between manifest and code`);
  }
});

test('every action the manifest declares is handled by the code', async () => {
  // A button that does nothing is worse than no button.
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
  for (const action of manifest.actions) {
    assert.match(
      source,
      new RegExp(`onAction\\('${action.key}'`),
      `the action "${action.key}" has no handler`,
    );
  }
});
