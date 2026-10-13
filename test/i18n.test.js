// The four languages of the Gladys interface (en, fr, de, es) in what the user
// reads outside the code: the store limits of the catalog texts, the docs and
// the READMEs. Every text of the manifest is already checked in the four
// languages by test/manifest.test.js, and the runtime messages by
// test/report.test.js. The integration declares no widget, so there is no
// widget text nor generated widget illustration to check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const LANGUAGES = ['en', 'fr', 'de', 'es'];
const READMES = { en: 'README.md', fr: 'README.fr.md', de: 'README.de.md', es: 'README.es.md' };
const REPO_RAW = 'https://raw.githubusercontent.com/William-De71/gladys-tapo/main';
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const exists = (path) => existsSync(new URL(`../${path}`, import.meta.url));
const manifest = JSON.parse(read('gladys-assistant-integration.json'));

/**
 * @description The headings and the number of table rows of a Markdown text,
 * which the four translations of one file must share.
 * @param {string} text - The Markdown text.
 * @returns {{ headings: string[], tableRows: number }} Its shape.
 */
function shape(text) {
  return {
    headings: (text.match(/^#+ /gm) ?? []).map((heading) => heading.trim()),
    tableRows: (text.match(/^\|/gm) ?? []).length,
  };
}

test('the catalog description and the scene trigger labels fit the store limits', () => {
  for (const language of LANGUAGES) {
    const { length } = manifest.description[language];
    assert.ok(length >= 10 && length <= 100, `description.${language}: ${length}`);
    for (const trigger of manifest.scene_triggers) {
      assert.ok(trigger.label[language].length <= 100, `scene ${trigger.key}.${language}`);
    }
  }
});

test('the four docs exist, are long enough and share the same structure', () => {
  const reference = shape(read('docs/en.md'));
  for (const language of LANGUAGES) {
    assert.ok(exists(`docs/${language}.md`), `docs/${language}.md`);
    const text = read(`docs/${language}.md`);
    assert.ok(text.length > 300, `docs/${language}.md is too short`);
    assert.deepEqual(shape(text), reference, `docs/${language}.md structure`);
  }
});

test('the four READMEs exist, link to each other and share the same structure', () => {
  const reference = shape(read(READMES.en));
  for (const file of Object.values(READMES)) {
    assert.ok(exists(file), file);
    const text = read(file);
    assert.deepEqual(shape(text), reference, `${file} structure`);
    for (const other of Object.values(READMES)) {
      if (other !== file) {
        assert.ok(text.includes(`(${other})`), `${file} links to ${other}`);
      }
    }
  }
});

test('every README shows the cover, the docs do not (the store already does)', () => {
  for (const language of LANGUAGES) {
    assert.ok(read(READMES[language]).includes('](cover.jpg)'), `${READMES[language]}: cover`);
    assert.ok(!read(`docs/${language}.md`).includes('cover.jpg'), `docs/${language}.md: no cover`);
  }
});

test('the docs show their images from the repository, as the store re-hosts them', () => {
  for (const language of LANGUAGES) {
    for (const [, target] of read(`docs/${language}.md`).matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
      assert.ok(target.startsWith(`${REPO_RAW}/`), `docs/${language}.md: ${target}`);
      assert.ok(exists(target.slice(REPO_RAW.length + 1)), `docs/${language}.md: ${target}`);
    }
  }
});

test('every relative link of the READMEs points to an existing file', () => {
  for (const file of Object.values(READMES)) {
    for (const [, target] of read(file).matchAll(/\]\(((?!https?:|#)[^)\s]+)\)/g)) {
      assert.ok(exists(target.split('#')[0]), `${file}: ${target}`);
    }
  }
});

test('every README carries the four badges, in order, under the language bar', () => {
  for (const file of Object.values(READMES)) {
    const text = read(file);
    assert.match(text.split('\n')[0], /README\.fr\.md|README\.md/, `${file}: language bar first`);
    const badges = [
      ...text.matchAll(/^\[!\[[^\]]+\]\((https:\/\/img\.shields\.io\/[^)]+)\)\]/gm),
    ].map(([, url]) => url);
    assert.equal(badges.length, 4, file);
    assert.match(badges[0], /badge\/(license|licence|Lizenz|licencia)-Apache--2\.0/, file);
    assert.match(badges[1], /github\/v\/release\/William-De71\/gladys-tapo\?sort=semver/, file);
    assert.match(badges[2], /actions\/workflow\/status\/.*release\.yml/, file);
    assert.match(
      badges[3],
      new RegExp(`Gladys-%E2%89%A5%20${manifest.gladys_version.slice(2)}-`),
      file,
    );
  }
});
