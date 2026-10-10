import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runCapabilityProcess } from '../../src/capability-installation.mjs';

export async function skillFixture(root, name = 'fixture-skill') {
  const path = join(root, name); await mkdir(join(path, 'references'), { recursive: true }); await mkdir(join(path, 'scripts'));
  await writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture instructions and adjacent resources\n---\nRead references/guide.md when needed. Never execute installation scripts automatically.\n`);
  await writeFile(join(path, 'references', 'guide.md'), 'supporting fixture resource'); await writeFile(join(path, 'scripts', 'helper.mjs'), 'throw new Error("A skill installer must not run me");\n');
  return path;
}

/** A local registry serving packages we generate ourselves; no public package download. */
export async function npmRegistryFixture(root, { native = false } = {}) {
  const path = join(root, native ? 'native-package' : 'npm-package'); await mkdir(path, { recursive: true });
  const name = native ? '@rna-fixture/native-mcp' : '@rna-fixture/mcp-echo';
  const manifest = { name, version: '1.2.3', description: 'Isolated locally authored MCP fixture', bin: { 'rna-fixture': './server.mjs' }, scripts: { postinstall: 'node -e "require(\'fs\').writeFileSync(\'postinstall-ran\',\'unexpected\')"' } };
  await writeFile(join(path, 'package.json'), JSON.stringify(manifest));
  const mcp = await readFile(new URL('./mcp-server.mjs', import.meta.url), 'utf8');
  await writeFile(join(path, 'server.mjs'), `#!/usr/bin/env node\n${native ? 'import { existsSync } from "node:fs"; if (!existsSync(new URL("./postinstall-ran", import.meta.url))) process.exit(12);\n' : ''}${mcp}`);
  const packed = await runCapabilityProcess('npm', ['pack', '--ignore-scripts', '--json'], { cwd: path }); const file = JSON.parse(packed.stdout)[0].filename, archive = await readFile(join(path, file));
  const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`; const requests = [];
  const server = createServer((req, res) => {
    const route = decodeURIComponent(new URL(req.url, 'http://fixture').pathname); requests.push(route);
    if (route === '/fixture.tgz') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(archive); return; }
    const version = { ...manifest, dist: { tarball: `${base}/fixture.tgz`, integrity } };
    const body = route.endsWith('/1.2.3') ? version : { name, 'dist-tags': { latest: '1.2.3' }, versions: { '1.2.3': version } };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  return { name, path, base, integrity, requests, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
