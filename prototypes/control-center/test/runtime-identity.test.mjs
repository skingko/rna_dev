import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

test('implementation identity is stable, source sensitive and independent of paths or operational state', async t => {
  const root = mkdtempSync(join(tmpdir(), 'rna-runtime-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const host = join(root, 'prototypes/control-center'), sdk = join(root, 'packages/sdk/src');
  mkdirSync(host, { recursive: true }); mkdirSync(sdk, { recursive: true });
  copyFileSync(new URL('../runtime-identity.mjs', import.meta.url), join(host, 'runtime-identity.mjs'));
  writeFileSync(join(host, 'server.mjs'), 'export const version = 1;');
  writeFileSync(join(sdk, 'core.mjs'), 'export const behaviour = 1;');
  const { runtimeImplementationIdentity } = await import(pathToFileURL(join(host, 'runtime-identity.mjs')));
  const initial = runtimeImplementationIdentity(); assert.match(initial, /^[a-f0-9]{64}$/); assert.equal(runtimeImplementationIdentity(), initial);
  writeFileSync(join(host, 'state.json'), JSON.stringify({ credential: 'isolated-not-a-key', dynamic: Date.now() }));
  assert.equal(runtimeImplementationIdentity(), initial, 'operational state and secrets are excluded');
  writeFileSync(join(sdk, 'core.mjs'), 'export const behaviour = 2;');
  const changedSdk = runtimeImplementationIdentity(); assert.notEqual(changedSdk, initial);
  writeFileSync(join(host, 'server.mjs'), 'export const version = 2;'); assert.notEqual(runtimeImplementationIdentity(), changedSdk);
  const previous = runtimeImplementationIdentity(); writeFileSync(join(sdk, 'new-feature.mjs'), 'export const enabled = true;');
  assert.notEqual(runtimeImplementationIdentity(), previous, 'a new runtime module also changes identity');
});
