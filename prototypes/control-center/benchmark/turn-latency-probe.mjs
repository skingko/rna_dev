// Host-side turn latency probe: a real server on scratch state, a local
// OpenAI-compatible fake that streams immediately, N turns in one project
// session. Reports turn.timing per turn so host overhead (journal, runtime,
// context, time-to-request) is visible without any paid model call.
//   node benchmark/turn-latency-probe.mjs [--turns 8] [--history 0] [--provider-delay 0]
import http from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from '../server.mjs';

const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? Number(process.argv[index + 1]) : fallback; };
const turns = arg('turns', 8), history = arg('history', 0), providerDelay = arg('provider-delay', 0), uninitialized = process.argv.includes('--uninitialized');
const filler = 'x'.repeat(1800);

const provider = http.createServer(async (request, response) => {
  for await (const _ of request) { /* drain */ }
  if (providerDelay) await delay(providerDelay);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const chunk = (delta, finish_reason = null, usage) => response.write(`data: ${JSON.stringify({ id: 'probe', object: 'chat.completion.chunk', model: 'probe', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
  chunk({ role: 'assistant' }); chunk({ content: `ok ${filler.slice(0, 400)}` }); chunk({}, 'stop', { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 });
  response.end('data: [DONE]\n\n');
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));

const directory = await mkdtemp(join(tmpdir(), 'rna-latency-probe-'));
const workspace = join(directory, 'workspace'); await mkdir(workspace);
const app = createServer({ stateFile: join(directory, '.state', 'state.json'), ticks: false, initiative: false });
await app.initializer.close();
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${app.server.address().port}`;
const post = async (path, input) => { const response = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }); const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result; };
try {
  const selected = app.store.configurationService.provider(null, { name: 'Probe', protocol: 'openai', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'probe-key', models: [{ id: 'probe', contextWindow: 128000, maxOutputTokens: 1000, reasoning: ['off'] }] });
  app.store.configurationService.update({ defaultModel: { providerId: selected.id, modelId: 'probe', reasoning: 'off' }, memory: { autoRecall: false, autoStore: false } });
  const created = await post('/api/projects', { name: 'Latency probe', workspace, initiative: { enabled: false } });
  if (!uninitialized) app.store.mutate(state => { const project = state.projects.find(row => row.id === created.project.id); project.initialization = { status: 'ready' }; project.simulated = false; project.decisionMode = 'rna-model'; });
  else console.log('initialization', JSON.stringify(app.store.state.projects.find(row => row.id === created.project.id).initialization), 'simulated', app.store.state.projects.find(row => row.id === created.project.id).simulated);
  const session = () => app.store.state.sessions.find(row => row.id === created.session.id);
  const rows = [];
  for (let index = 0; index < history + turns; index++) {
    const started = performance.now();
    await post(`/api/sessions/${created.session.id}/messages`, { text: `turn ${index} ${filler.slice(0, 200)}`, requestId: `probe-${index}` });
    while (!['completed', 'failed', 'stopped'].includes(session().turns[index]?.status)) await delay(2);
    const turn = session().turns[index];
    if (turn.status !== 'completed') throw new Error(`turn ${index} ${turn.status}: ${JSON.stringify(turn.error ?? turn.errorDiagnostic ?? null)}`);
    if (index >= history) rows.push({ turn: index, wallMs: Math.round(performance.now() - started), ...turn.timing });
  }
  const keys = ['wallMs', 'journal', 'runtime', 'preparing', 'context', 'toRequest', 'request', 'firstToken'];
  console.log(keys.join('\t'));
  for (const row of rows) console.log(keys.map(key => row[key] ?? '-').join('\t'));
  const median = key => { const values = rows.map(row => row[key]).filter(Number.isFinite).sort((a, b) => a - b); return values.length ? values[Math.floor(values.length / 2)] : '-'; };
  console.log(`median\t${keys.slice(1).map(median).join('\t')}`.replace('median\t', `median\t${median('wallMs')}\t`).split('\t').slice(0, keys.length + 1).join('\t'));
} finally {
  await app.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); await rm(directory, { recursive: true, force: true });
}
