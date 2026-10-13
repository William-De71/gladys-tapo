// -----------------------------------------------------------------------------
// Release helpers, run by the Release, GitHub releases and PR title workflows.
// No dependency: Node built-ins and git only.
//
//   node .github/scripts/release.mjs next [<release-as>]
//     Prints `{ release, version, bump, previous }` as JSON: the next version
//     computed from the Conventional Commits since the last `v*` tag
//     (feat -> minor, fix/perf -> patch, breaking -> major, or minor below
//     1.0.0; docs/chore/ci/test/style/refactor/build alone -> no release). No
//     tag yet: the current version is released as is, unless its image is
//     already published (then it is the base, never published twice).
//     `release-as` forces it.
//
//   node .github/scripts/release.mjs changelog <version> <repo-url> [<date>]
//     Writes the section of <version> at the top of CHANGELOG.md, generated
//     from the commits since the last tag, and its comparison link. Dates the
//     hand-written starter section `## [0.1.0] - unreleased` instead. A
//     `## [Unreleased]` section with text is merged once into the new section,
//     then removed. Running it twice changes nothing; a different existing
//     section is an error.
//
//   node .github/scripts/release.mjs prepare <version> <docker-image>
//     Sets the version in package.json, package-lock.json and the manifest
//     (`version` + `docker_image`), editing the files in place so the release
//     commit keeps the Prettier layout.
//
//   node .github/scripts/release.mjs notes <version> < CHANGELOG.md
//     Prints the changelog section of <version>: the GitHub Release notes.
//
//   node .github/scripts/release.mjs check-title "<pull request title>"
//     Fails unless the title is a Conventional Commit with a description a
//     user can read: it becomes the squash commit, then the changelog line.
// -----------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MANIFEST_FILE = 'gladys-assistant-integration.json';
const CHANGELOG_FILE = 'CHANGELOG.md';
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export const RELEASE_TYPES = { feat: 'minor', fix: 'patch', perf: 'patch' };
export const SILENT_TYPES = ['docs', 'chore', 'ci', 'test', 'style', 'refactor', 'build', 'revert'];
const SECTION_ORDER = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];

// --- Versions ----------------------------------------------------------------

export function parseVersion(version) {
  const match = SEMVER.exec(version ?? '');
  if (!match) {
    throw new Error(`Not a x.y.z version: "${version}"`);
  }
  return match.slice(1).map(Number);
}

export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) {
      return x[i] - y[i];
    }
  }
  return 0;
}

export function bumpVersion(version, bump) {
  const [major, minor, patch] = parseVersion(version);
  if (bump === 'major') {
    return `${major + 1}.0.0`;
  }
  if (bump === 'minor') {
    return `${major}.${minor + 1}.0`;
  }
  return `${major}.${minor}.${patch + 1}`;
}

// --- Commits -----------------------------------------------------------------

const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?: (?<description>.+)$/;
const PR_SUFFIX = /\s*\(#(\d+)\)$/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE: ([\s\S]+?)(?:\n\n|\n[A-Za-z-]+: |$)/m;

/**
 * Parse a commit: `{ hash, subject, body }` -> Conventional Commit fields.
 * Non-conventional subjects get `type: null` (ignored).
 */
export function parseCommit({ hash, subject, body = '' }) {
  const pr = PR_SUFFIX.exec(subject)?.[1];
  const header = HEADER.exec(subject.replace(PR_SUFFIX, ''));
  const footer = BREAKING_FOOTER.exec(body)?.[1]?.trim().replace(/\s+/g, ' ');
  if (!header) {
    return { hash, subject, body, type: null, breaking: Boolean(footer), breakingNote: footer };
  }
  const { type, scope, bang, description } = header.groups;
  return {
    hash,
    subject,
    body,
    type,
    scope,
    description: description.trim(),
    pr: pr ? Number(pr) : undefined,
    breaking: Boolean(bang) || Boolean(footer),
    breakingNote: footer,
  };
}

/** Drop the reverted commits and their reverts when both are in the range. */
export function withoutReverts(commits) {
  const reverted = new Set();
  const reverts = new Set();
  for (const commit of commits) {
    const target = /This reverts commit ([0-9a-f]{7,40})/.exec(commit.body ?? '')?.[1];
    if (!target) {
      continue;
    }
    const original = commits.find(
      (other) => other.hash.startsWith(target) || target.startsWith(other.hash),
    );
    if (original) {
      reverted.add(original.hash);
      reverts.add(commit.hash);
    }
  }
  return commits.filter((commit) => !reverted.has(commit.hash) && !reverts.has(commit.hash));
}

const isReleaseCommit = (commit) => commit.type === 'chore' && commit.scope === 'release';

/**
 * Next version.
 * @param {string} current - Version in package.json.
 * @param {object[]} commits - Parsed commits since the last tag.
 * @param {{ hasTag: boolean, published?: boolean, releaseAs?: string }} options -
 * Context: `published` = the image of `current` exists without a tag.
 * @returns {{ release: boolean, version: string, bump: string | null }}
 */
export function nextVersion(current, commits, { hasTag, published = false, releaseAs } = {}) {
  // A version whose image exists is a base, tagged or not: never republished.
  const hasBase = hasTag || published;
  if (releaseAs) {
    parseVersion(releaseAs);
    if (hasBase && compareVersions(releaseAs, current) <= 0) {
      throw new Error(`release-as ${releaseAs} must be greater than ${current}`);
    }
    return { release: true, version: releaseAs, bump: 'release-as' };
  }
  if (!hasBase) {
    // First release: the version written at the creation of the project.
    return { release: true, version: current, bump: null };
  }
  let bump = null;
  const rank = { patch: 1, minor: 2, major: 3 };
  for (const commit of withoutReverts(commits).filter((c) => !isReleaseCommit(c))) {
    let level = commit.breaking ? 'major' : RELEASE_TYPES[commit.type];
    if (!level) {
      continue;
    }
    // Below 1.0.0 a breaking change is a minor: 1.0.0 is the maintainer's call.
    if (level === 'major' && parseVersion(current)[0] === 0) {
      level = 'minor';
    }
    if (!bump || rank[level] > rank[bump]) {
      bump = level;
    }
  }
  if (!bump) {
    return { release: false, version: current, bump: null };
  }
  return { release: true, version: bumpVersion(current, bump), bump };
}

// --- Changelog ---------------------------------------------------------------

function sectionOf(commit) {
  const security =
    commit.type === 'security' ||
    commit.scope === 'security' ||
    (commit.type === 'fix' && commit.scope === 'deps');
  if (security) {
    return 'Security';
  }
  if (!['feat', 'fix', 'perf'].includes(commit.type)) {
    return null;
  }
  if (/^(remove|drop)\b/i.test(commit.description)) {
    return 'Removed';
  }
  return { feat: 'Added', fix: 'Fixed', perf: 'Changed' }[commit.type];
}

function changelogLine(commit, repoUrl) {
  const links = [];
  if (commit.pr) {
    links.push(`[#${commit.pr}](${repoUrl}/pull/${commit.pr})`);
  }
  links.push(`[${commit.hash.slice(0, 7)}](${repoUrl}/commit/${commit.hash})`);
  const scope = commit.scope ? `**${commit.scope}:** ` : '';
  return `- ${scope}${commit.description} (${links.join(', ')})`;
}

/**
 * Body of a changelog section (without its heading), from parsed commits.
 * @returns {string} Markdown, empty when no commit is worth a line.
 */
export function renderSection(commits, repoUrl) {
  const relevant = withoutReverts(commits).filter((commit) => !isReleaseCommit(commit));
  const blocks = [];
  const breaking = relevant.filter((commit) => commit.breaking);
  if (breaking.length > 0) {
    const notes = [...new Set(breaking.map((c) => c.breakingNote ?? c.description ?? c.subject))];
    blocks.push(`### Breaking changes\n\n${notes.map((note) => `- ${note}`).join('\n')}`);
  }
  const groups = new Map();
  const seen = new Set();
  for (const commit of relevant) {
    const section = commit.type ? sectionOf(commit) : null;
    if (!section) {
      continue;
    }
    const identity = `${section}|${commit.scope ?? ''}|${commit.description.toLowerCase()}`;
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    groups.set(section, [...(groups.get(section) ?? []), changelogLine(commit, repoUrl)]);
  }
  for (const section of SECTION_ORDER) {
    if (groups.has(section)) {
      blocks.push(`### ${section}\n\n${groups.get(section).join('\n')}`);
    }
  }
  return blocks.join('\n\n');
}

const escapeVersion = (version) => version.replaceAll('.', '\\.');

const UNRELEASED_HEADING = /^## \[Unreleased\][^\n]*\n?/im;
const UNRELEASED_LINK = /^\[Unreleased\]: [^\n]*\n?/im;

/**
 * The `## [Unreleased]` section: its bounds and its text (hand-written lines
 * kept from before the automatic releases).
 */
function unreleasedSection(text) {
  const match = UNRELEASED_HEADING.exec(text);
  if (!match) {
    return null;
  }
  const bodyStart = match.index + match[0].length;
  const next = text.slice(bodyStart).search(/^## |^\[[^\]]+\]: /m);
  const end = next === -1 ? text.length : bodyStart + next;
  return { start: match.index, end, body: text.slice(bodyStart, end).trim() };
}

/** Split a section body into `{ heading: lines }` (`null` = before any `###`). */
function blocksOf(body) {
  const blocks = new Map();
  let heading = null;
  for (const line of body.split('\n')) {
    const match = /^### (.+)$/.exec(line);
    if (match) {
      heading = match[1].trim();
      blocks.set(heading, blocks.get(heading) ?? []);
    } else if (line.trim()) {
      blocks.set(heading, [...(blocks.get(heading) ?? []), line]);
    }
  }
  return blocks;
}

/** Merge two section bodies, heading by heading (Breaking changes first). */
export function mergeBodies(first, second) {
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }
  const merged = blocksOf(first);
  for (const [heading, lines] of blocksOf(second)) {
    merged.set(heading, [...(merged.get(heading) ?? []), ...lines]);
  }
  const order = ['Breaking changes', ...SECTION_ORDER];
  const headings = [...merged.keys()].sort((a, b) => {
    const rank = (h) => (h === null ? -1 : order.includes(h) ? order.indexOf(h) : order.length);
    return rank(a) - rank(b);
  });
  return headings
    .filter((heading) => merged.get(heading).length > 0)
    .map((heading) => {
      const lines = merged.get(heading).join('\n');
      return heading === null ? lines : `### ${heading}\n\n${lines}`;
    })
    .join('\n\n');
}

/** Heading line of a version: `## [1.2.0] - 2026-01-02` (or `- unreleased`). */
function versionHeading(version) {
  return new RegExp(`^## \\[${escapeVersion(version)}\\](?: - (.+))?[ \\t]*$`, 'm');
}

function sectionBounds(text, version) {
  const match = versionHeading(version).exec(text);
  if (!match) {
    return null;
  }
  const bodyStart = match.index + match[0].length;
  const rest = text.slice(bodyStart);
  const next = rest.search(/^## |^\[[^\]]+\]: /m);
  return {
    start: match.index,
    bodyStart,
    end: next === -1 ? text.length : bodyStart + next,
    date: match[1],
  };
}

/** Body of the section of a version (the GitHub Release notes). */
export function releaseNotes(text, version) {
  const bounds = sectionBounds(text, version);
  return bounds ? text.slice(bounds.bodyStart, bounds.end).trim() : '';
}

/**
 * Write the section of a release into the changelog.
 * @param {string} text - CHANGELOG.md content.
 * @param {object} release - `{ version, previous, date, commits, repoUrl }`.
 * @returns {string} The new content.
 */
export function updateChangelog(text, { version, previous, date, commits, repoUrl }) {
  const link = previous
    ? `[${version}]: ${repoUrl}/compare/v${previous}...v${version}`
    : `[${version}]: ${repoUrl}/releases/tag/v${version}`;
  const existing = sectionBounds(text, version);
  let result;
  if (existing) {
    if (existing.date === 'unreleased') {
      // The starter section written with the project: date it, keep its text.
      result = text.replace(versionHeading(version), `## [${version}] - ${date}`);
    } else if (!previous) {
      // The first release run again: its section is the hand-written starter,
      // dated by the first run, never compared with generated lines.
      result = text;
    } else {
      const generated = renderSection(commits, repoUrl);
      const current = text.slice(existing.bodyStart, existing.end).trim();
      // Same release run again: every generated line is already there (the
      // section may also hold lines merged from [Unreleased]).
      const missing = generated
        .split('\n')
        .filter((line) => line.startsWith('- ') && !current.split('\n').includes(line));
      if (missing.length > 0) {
        throw new Error(`${CHANGELOG_FILE} already has a different ${version} section`);
      }
      result = text;
    }
  } else {
    // Hand-written lines waiting under [Unreleased]: into this release, once.
    const unreleased = unreleasedSection(text);
    if (unreleased) {
      text = `${text.slice(0, unreleased.start)}${text.slice(unreleased.end)}`.replace(
        UNRELEASED_LINK,
        '',
      );
    }
    const body =
      mergeBodies(unreleased?.body ?? '', renderSection(commits, repoUrl)) ||
      '- Maintenance release.';
    const first = text.search(/^## /m);
    const linksStart = text.search(/^\[[^\]]+\]: /m);
    const insertAt = first !== -1 ? first : linksStart !== -1 ? linksStart : text.length;
    const head = text.slice(0, insertAt).trimEnd();
    const tail = text.slice(insertAt).trimStart();
    result = `${head}\n\n## [${version}] - ${date}\n\n${body}\n\n${tail}`;
  }
  // The comparison link, once, at the top of the link definitions.
  if (!result.includes(`${link}\n`) && !result.endsWith(link)) {
    const linksStart = result.search(/^\[[^\]]+\]: /m);
    result =
      linksStart === -1
        ? `${result.trimEnd()}\n\n${link}\n`
        : `${result.slice(0, linksStart)}${link}\n${result.slice(linksStart)}`;
  }
  return `${result.trimEnd()}\n`;
}

// --- Version files -----------------------------------------------------------

/** Replace the value of a top-level string key, keeping the layout. */
function setTopLevelString(text, key, value, file) {
  const indent = /^[ \t]+(?=")/m.exec(text)?.[0];
  const pattern = new RegExp(`^(${indent}"${key}":\\s*)"[^"]*"`, 'm');
  if (indent === undefined || !pattern.test(text)) {
    throw new Error(`${file}: no top-level "${key}" string to update`);
  }
  return text.replace(pattern, (_match, prefix) => prefix + JSON.stringify(value));
}

export function bumpManifest(text, version, dockerImage) {
  const manifest = JSON.parse(text);
  let result = setTopLevelString(text, 'version', version, MANIFEST_FILE);
  result = setTopLevelString(result, 'docker_image', dockerImage, MANIFEST_FILE);
  assert.deepEqual(JSON.parse(result), { ...manifest, version, docker_image: dockerImage });
  return result;
}

export function bumpPackage(text, version) {
  const result = setTopLevelString(text, 'version', version, 'package.json');
  assert.equal(JSON.parse(result).version, version);
  return result;
}

/** package-lock.json: the top-level version and the root package entry. */
export function bumpLock(text, version) {
  const lock = JSON.parse(text);
  let result = setTopLevelString(text, 'version', version, 'package-lock.json');
  // The root package is the first `"": {` entry of `packages`.
  result = result.replace(
    /("packages":\s*\{\s*"":\s*\{[^{}]*?"version":\s*)"[^"]*"/,
    `$1"${version}"`,
  );
  const expected = structuredClone(lock);
  expected.version = version;
  expected.packages[''].version = version;
  assert.deepEqual(JSON.parse(result), expected);
  return result;
}

// --- Pull request titles -----------------------------------------------------

const TITLE_TYPES = [...Object.keys(RELEASE_TYPES), ...SILENT_TYPES, 'security'];

/**
 * Problems of a pull request title ([] when it is fine). The title becomes the
 * squash commit, hence the version bump and the changelog line.
 */
export function titleProblems(title) {
  const commit = parseCommit({ hash: '0000000', subject: String(title ?? '').trim() });
  if (!commit.type) {
    return ['use the Conventional Commits format: "type(scope): description"'];
  }
  const problems = [];
  if (!TITLE_TYPES.includes(commit.type)) {
    problems.push(`unknown type "${commit.type}" (use ${TITLE_TYPES.join(', ')})`);
  }
  if (commit.description.length < 10) {
    problems.push('the description needs at least 10 characters');
  }
  if (/^(wip|fix|update|changes?|stuff|misc|tmp)\b\.?$/i.test(commit.description)) {
    problems.push('describe the change for the user, e.g. "add a dashboard widget for X"');
  }
  if (/[^ -~]/.test(commit.description)) {
    problems.push('write the description in English, without accented characters');
  }
  if (/^[A-Z][a-z]/.test(commit.description)) {
    problems.push('start the description with a lowercase verb ("add...", "fix...")');
  }
  return problems;
}

// --- git ---------------------------------------------------------------------

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function lastTag() {
  try {
    return git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*.[0-9]*.[0-9]*');
  } catch {
    return null;
  }
}

function commitsSince(tag) {
  const range = tag ? [`${tag}..HEAD`] : ['HEAD'];
  const raw = git('log', '--format=%H%x1f%s%x1f%b%x1e', ...range);
  return raw
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, subject, body] = record.split('\x1f');
      return parseCommit({ hash, subject, body });
    });
}

// --- CLI ---------------------------------------------------------------------

/**
 * Whether ghcr.io serves the image of a version to anyone (an anonymous pull,
 * like a Gladys instance). Unknown repository -> false.
 */
async function imagePublished(repository, version) {
  if (!repository) {
    return false;
  }
  const repo = repository.toLowerCase();
  try {
    const auth = await fetch(`https://ghcr.io/token?scope=repository:${repo}:pull`);
    const { token } = await auth.json();
    const manifest = await fetch(`https://ghcr.io/v2/${repo}/manifests/${version}`, {
      method: 'HEAD',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept:
          'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json',
      },
    });
    return manifest.ok;
  } catch {
    return false;
  }
}

async function main([command, ...args]) {
  if (command === 'next') {
    const tag = lastTag();
    const current = JSON.parse(readFileSync('package.json', 'utf8')).version;
    const result = nextVersion(current, commitsSince(tag), {
      hasTag: Boolean(tag),
      published: !tag && (await imagePublished(process.env.GITHUB_REPOSITORY, current)),
      releaseAs: args[0] || undefined,
    });
    process.stdout.write(`${JSON.stringify({ ...result, previous: tag?.slice(1) ?? null })}\n`);
  } else if (command === 'changelog') {
    const [version, repoUrl, date = new Date().toISOString().slice(0, 10)] = args;
    parseVersion(version);
    const tag = lastTag();
    const text = readFileSync(CHANGELOG_FILE, 'utf8');
    writeFileSync(
      CHANGELOG_FILE,
      updateChangelog(text, {
        version,
        previous: tag?.slice(1),
        date,
        commits: commitsSince(tag),
        repoUrl,
      }),
    );
  } else if (command === 'prepare') {
    const [version, dockerImage] = args;
    parseVersion(version);
    writeFileSync('package.json', bumpPackage(readFileSync('package.json', 'utf8'), version));
    writeFileSync(
      'package-lock.json',
      bumpLock(readFileSync('package-lock.json', 'utf8'), version),
    );
    writeFileSync(
      MANIFEST_FILE,
      bumpManifest(readFileSync(MANIFEST_FILE, 'utf8'), version, dockerImage),
    );
  } else if (command === 'notes') {
    process.stdout.write(releaseNotes(readFileSync(0, 'utf8'), args[0]));
  } else if (command === 'check-title') {
    const problems = titleProblems(args[0]);
    for (const problem of problems) {
      console.error(`::error::Pull request title: ${problem}`);
    }
    process.exitCode = problems.length > 0 ? 1 : 0;
  } else {
    console.error('Usage: release.mjs next|changelog|prepare|notes|check-title ...');
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
