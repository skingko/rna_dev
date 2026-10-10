import { createServer } from 'node:http';
import { deflateRawSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

/** A small ZIP (deflate) built in memory, the shape ClawHub serves. */
export function zip(files) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text), packed = deflateRawSync(data), nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed); centrals.push(central, nameBytes); offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
export async function marketplaceFixture(t, { transform = x => x, delay = 0 } = {}) {
  const commit = 'a'.repeat(40), calls = [], sources = {
    'skills/research/SKILL.md': '---\nname: Source checking\ndescription: Check claims against original sources.\n---\nRead references/method.md; distinguish observable records from assumptions.\n',
    'skills/research/references/method.md': 'Compare claims and source units. Change the conclusion when the evidence design changes.\n',
    'LICENSE': 'MIT License\nCopyright (c) fixture authors\n',
  };
  const tree = Object.entries(sources).map(([path, value]) => ({ type: 'blob', mode: '100644', path, size: Buffer.byteLength(value), sha: createHash('sha1').update(`blob ${Buffer.byteLength(value)}\0${value}`).digest('hex') }));
  const server = createServer(async (request, response) => {
    const original = new URL(new URL(request.url, 'http://fixture').searchParams.get('target')); calls.push({ url: original.href, authorization: request.headers.authorization });
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    let result;
    if (original.hostname === 'clawhub.ai' && original.pathname === '/api/v1/search') result = { results: [
      { source: 'clawhub', id: 'clawhub:k1', ownerHandle: 'fixture', slug: 'story-method', displayName: 'Story method', summary: '# Story method Plan long serial fiction chapter by chapter.', downloads: 5, trust: { installability: 'installable', clawHubVerdict: null }, version: '1.0.0' },
      { source: 'skills-sh', id: 'skills-sh:fixture/skills/research', install: { kind: 'skills-sh', reference: 'skills-sh:fixture/skills/research' }, displayName: 'research', summary: '# Source checking Check claims against original sources.', downloads: 9, trust: { installability: 'installable' } },
      { source: 'clawhub', id: 'clawhub:k2', ownerHandle: 'fixture', slug: 'flagged', displayName: 'Flagged', summary: 'x', trust: { installability: 'installable', clawHubVerdict: 'malicious' } }] };
    else if (original.hostname === 'clawhub.ai' && original.pathname === '/api/v1/download') {
      const value = transform(zip({ 'SKILL.md': '---\nname: story-method\ndescription: Plan long serial fiction.\n---\nOutline arcs first.\n', 'references/arcs.md': 'Arc notes.\n', '_meta.json': '{}' }), original);
      response.writeHead(200, { 'content-type': 'application/zip' }); response.end(value); return;
    }
    else if (original.hostname === 'www.skills.sh') result = { skills: [{ id: 'fixture/skills/research', source: 'fixture/skills', skillId: 'research', name: 'Source checking', installs: 10 }] };
    else if (original.hostname === 'skillsmp.com') result = { success: true, data: { skills: [{ id: 'fixture-skills-research-skill-md', name: 'Source checking', githubUrl: 'https://github.com/fixture/skills/tree/main/skills/research', stars: 3 }] } };
    else if (original.hostname === 'api.github.com') result = original.pathname.includes('/commits/') ? { sha: commit } : { truncated: false, tree };
    else if (original.hostname === 'raw.githubusercontent.com') result = sources[original.pathname.split('/').slice(4).map(decodeURIComponent).join('/')];
    // skills.sh snapshot endpoint: files of skills/<skill>/ relative to the skill directory.
    else if (original.hostname === 'skills.sh' && original.pathname.startsWith('/api/download/')) {
      // Built from the (test-transformed) repository tree and raw files, so a test that reshapes the
      // repository reshapes the snapshot the same way. The skill directory is the one named <skill>.
      const [, , , owner, repo, skill] = original.pathname.split('/').map(decodeURIComponent);
      const listing = transform({ truncated: false, tree }, new URL(`https://api.github.com/repos/${owner}/${repo}/git/trees/${commit}?recursive=1`));
      const rows = (listing?.tree ?? []).filter(row => row.type === 'blob');
      const skillFile = rows.find(row => row.path === `${skill}/SKILL.md` || row.path.endsWith(`/${skill}/SKILL.md`)) ?? (skill === repo ? rows.find(row => row.path === 'SKILL.md') : undefined);
      if (!skillFile) result = { status: 404 };
      else {
        const prefix = skillFile.path.slice(0, -'SKILL.md'.length), files = [];
        for (const row of rows.filter(row => row.path.startsWith(prefix))) {
          const contents = transform(sources[row.path], new URL(`https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${row.path.split('/').map(encodeURIComponent).join('/')}`));
          if (typeof contents === 'string') files.push({ path: row.path.slice(prefix.length), contents });
        }
        result = { files, hash: 'fixture' };
      }
    }
    const value = transform(result, original); if (value?.status) { response.writeHead(value.status); response.end('untrusted provider message'); return; }
    response.writeHead(200, { 'content-type': typeof value === 'string' ? 'text/plain' : 'application/json' }); response.end(typeof value === 'string' ? value : JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const fetchImpl = (url, options) => fetch(`http://127.0.0.1:${server.address().port}/?${new URLSearchParams({ target: url })}`, options);
  // git stand-in for the sparse-checkout fallback: ls-remote reports the commit; clone/checkout
  // materialize the requested directory (and root licenses) from `sources` (or `gitSources`).
  const gitCalls = [];
  const git = async args => {
    gitCalls.push(args);
    if (args[0] === 'ls-remote') return `${commit}\tHEAD\n`;
    const at = args.indexOf('-C'), dir = at >= 0 ? args[at + 1] : args.at(-1);
    if (args[0] === 'clone') { await mkdir(dir, { recursive: true }); return ''; }
    if (args.includes('sparse-checkout')) { git.patterns = args.slice(args.indexOf('set') + 2); return ''; }
    if (args.includes('checkout')) { for (const [path, value] of Object.entries(git.sources ?? sources)) { const full = join(dir, path); await mkdir(dirname(full), { recursive: true }); await writeFile(full, value); } return ''; }
    if (args.includes('rev-parse')) return `${commit}\n`;
    if (args.includes('ls-tree')) { const listing = transform({ truncated: false, tree }, new URL(`https://api.github.com/repos/fixture/skills/git/trees/${commit}?recursive=1`)); return (listing?.tree ?? []).map(row => row.path).join('\n'); }
    return '';
  };
  return { fetchImpl, commit, calls, sources, git, gitCalls };
}
