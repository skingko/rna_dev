import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** Capture once at host start. Paths/secrets/state are never part of the public
 * identity. This identifies source + Node, not the entire OS/provider stack. */
export function runtimeImplementationIdentity({ root = dirname(fileURLToPath(import.meta.url)), nodeVersion = process.versions.node, platform = process.platform, arch = process.arch } = {}) {
  const digest = createHash('sha256');
  digest.update(`rna-runtime-source-v1\0v${nodeVersion.replace(/^v/, '')}\0${platform}\0${arch}\0`);
  for (const [label, directory] of [['host', root], ['sdk', resolve(root, '../../packages/sdk/src')]]) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).filter(row => row.isFile() && row.name.endsWith('.mjs')).sort((a, b) => a.name.localeCompare(b.name))) {
      digest.update(`${label}/${entry.name}\0`).update(readFileSync(resolve(directory, entry.name))).update('\0');
    }
  }
  return digest.digest('hex');
}
