#!/usr/bin/env node
// Trial working rules that get no proof, on a captured state (trial-evidence.mjs), read-only and without any network: every
// trial skill rule of every live project with the placements its stored counters hold, the placements the background run
// journals imply (what the counter would hold had it existed: a run that loaded the rule's skill and read its section, once
// per run, the way gene-evolution-service.mjs noteSkillLoad counts), the user's rhythm in the project, and the verdict of the
// production rule for each. Prints titles and numbers only, never a message or a report.
// Usage: node benchmark/trial-gene-evidence.mjs <code root> <state.json copy> [<run journals dir>] [<now ISO>]
//   run journals dir: `<state>.rna/initiative` of the daemon the copy came from (read only; a project's runs are in
//   `<dir>/<projectId>/<actionId>/*.rna.jsonl`). Without it only the stored counters are read.
// Never point it at production state: readStateFile only reads, but pass a copy.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
const [root, statePath, journals = null, nowText = null] = process.argv.slice(2);
if (!root || !statePath) { console.error('Usage: trial-gene-evidence.mjs <code root> <state.json copy> [<run journals dir>] [<now ISO>]'); process.exit(2); }
const cc = `${root}/prototypes/control-center`;
const { readStateFile } = await import(`${cc}/state-shards.mjs`);
const { methodGenes } = await import(`${cc}/project-mind.mjs`);
const { trialEvidence, unjudgedOf, userRhythm, AWAY_FACTOR } = await import(`${cc}/trial-evidence.mjs`);
const { state } = readStateFile(statePath);
const now = nowText ? Date.parse(nowText) : Date.now();
const DAY = 86400000, days = ms => Math.round(ms / DAY * 10) / 10;

/** Runs of `projectId` whose journal shows a skill_load of the rule's skill that returned its section (once per run). */
function runsReading(projectId, rules) {
  const counts = new Map(rules.map(rule => [rule.id, new Set()]));
  const dir = journals ? `${journals}/${projectId}` : null;
  if (!dir || !existsSync(dir)) return null;
  for (const run of readdirSync(dir)) {
    const folder = `${dir}/${run}`;
    if (!statSync(folder).isDirectory()) continue;
    for (const file of readdirSync(folder).filter(name => name.endsWith('.jsonl'))) {
      const intents = new Map();
      for (const line of readFileSync(`${folder}/${file}`, 'utf8').split('\n')) {
        if (!line) continue;
        let row; try { row = JSON.parse(line); } catch { continue; }
        if (row.type === 'tool_intent' && row.data?.toolName === 'skill_load') intents.set(row.data.callKey, { args: row.data.arguments, at: Date.parse(row.time) });
        if (row.type !== 'tool_completed' || !intents.has(row.data?.callKey) || row.data.result?.isError === true) continue;
        const { args, at } = intents.get(row.data.callKey);
        let page; try { page = JSON.parse((row.data.result?.content ?? []).map(block => block.text ?? '').join('')); } catch { continue; }
        if (!page || (page.path && page.path !== 'SKILL.md') || typeof page.content !== 'string') continue;
        const local = String(page.id ?? args?.id ?? '').replace(/^gen-[0-9a-f]{16}-/, '');
        for (const rule of rules) if (rule.body.skillId === local && at >= (Date.parse(rule.createdAt ?? 0) || 0) && page.content.includes(String(rule.body.note).trim().split('\n')[0])) counts.get(rule.id).add(run);
      }
    }
  }
  return new Map([...counts].map(([id, set]) => [id, set.size]));
}

let stored = 0, implied = 0, trials = 0;
for (const project of state.projects.filter(row => !row.archivedAt)) {
  const rules = methodGenes(project).filter(row => row.status === 'trial');
  if (!rules.length) continue;
  const sessions = state.sessions.filter(row => row.projectId === project.id && !row.archivedAt && row.kind !== 'side');
  const rhythm = userRhythm(sessions, { touched: Date.parse(project.genes?.evidenceAsks?.answeredAt ?? 0) || 0 });
  const reads = runsReading(project.id, rules);
  console.log(`\n${project.name}: ${rules.length} trial rule(s); the user last wrote ${rhythm.last ? days(now - rhythm.last) : '-'} days ago, longest absence ${rhythm.longest === null ? '-' : days(rhythm.longest)} days (bar ${rhythm.longest === null ? '-' : days(AWAY_FACTOR * rhythm.longest)}), ${rhythm.messages} messages`);
  const asStored = trialEvidence(project, sessions, { now });
  // The same rules as the counter would hold them with the journals' runs added (a counted run is an injected run: injected and injectedRuns).
  const imagined = reads ? { ...project, genes: { ...project.genes, genes: project.genes.genes.map(gene => reads.has(gene.id) ? { ...gene, stats: { ...(gene.stats ?? {}), injected: (gene.stats?.injected ?? 0) + reads.get(gene.id), injectedRuns: (gene.stats?.injectedRuns ?? 0) + reads.get(gene.id) } } : gene) } } : null;
  const withRuns = imagined ? trialEvidence(imagined, sessions, { now }) : null;
  for (const [index, row] of asStored.rows.entries()) {
    trials++;
    const more = withRuns?.rows[index];
    console.log(`  ${row.gene.title}: stored unjudged ${unjudgedOf(row.gene)} -> ${row.ask ? 'ASK' : row.why}${more ? `; with ${reads.get(row.gene.id)} journal run(s) unjudged ${more.unjudged} -> ${more.ask ? 'ASK' : more.why}${more.waited ? ` (waited ${days(more.waited)} days)` : ''}` : ''}`);
    if (row.ask) stored++; if (more?.ask) implied++;
  }
  console.log(`  next card: ${asStored.ask ? asStored.ask.gene.title : '-'}${withRuns ? ` / with the journals' runs: ${withRuns.ask ? withRuns.ask.gene.title : '-'}` : ''}`);
}
console.log(`\n${trials} trial rule(s): ${stored} would be asked about with the stored counters${journals ? `, ${implied} with the placements the run journals imply` : ''} (one card at a time).`);
