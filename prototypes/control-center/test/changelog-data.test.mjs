import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// docs/changelog.json is what the website reads from GitHub at build time (the site lives in its own local repository and
// has no copy): the user-visible changes of each release, in Chinese and English. A release without an entry would show
// the site an older version than the one shipped, so the app version must have the top entry.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const releases = JSON.parse(readFileSync(`${root}docs/changelog.json`, 'utf8'));
const appVersion = JSON.parse(readFileSync(`${root}prototypes/control-center/desktop/package.json`, 'utf8')).version;
const order = version => version.split('.').map(Number);
const newer = (a, b) => { const x = order(a), y = order(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

test('every entry has a version, a date, a bilingual title and bilingual items', () => {
  assert.ok(Array.isArray(releases) && releases.length > 0);
  for (const release of releases) {
    assert.match(release.version, /^\d+\.\d+\.\d+$/); assert.match(release.date, /^\d{4}-\d{2}-\d{2}$/);
    if (release.sdk !== undefined) assert.match(release.sdk, /^\d+\.\d+\.\d+$/);
    for (const text of [release.title, ...release.items]) { assert.ok(text.zh?.trim() && text.en?.trim(), `${release.version}: zh and en are both written`); assert.ok(!/[—–]/.test(`${text.zh}${text.en}`), `${release.version}: the site's copy uses no dashes`); }
    assert.ok(release.items.length > 0, `${release.version} lists at least one change`);
    assert.deepEqual(Object.keys(release).filter(key => !['version', 'sdk', 'date', 'title', 'items'].includes(key)), []);
  }
});

test('newest first, each version once, no entry dated in the future', () => {
  for (let i = 1; i < releases.length; i++) assert.ok(newer(releases[i - 1].version, releases[i].version), `${releases[i - 1].version} is newer than ${releases[i].version}`);
  assert.ok(releases.every(release => Date.parse(`${release.date}T00:00:00Z`) <= Date.now() + 86400000));
});

test('the top entry is the version the app ships: a version bump brings its changelog entry', () => {
  assert.equal(releases[0].version, appVersion);
});
