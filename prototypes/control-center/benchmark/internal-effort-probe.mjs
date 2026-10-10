#!/usr/bin/env node
// Stage A of the internal-effort rollout (spec p1 effort §6.2; AGENTS.md: a labelled probe before a judgment point
// ships). Labelled internal calls go to the live daemon's raw probe (POST /api/v2/decision-kernel/probe: one System One
// call with the app's key, no thresholds, cache or ledger), built with the production state builder and template, and
// judged with the production combine function and thresholds. Reports each item's distribution, the verdict, and the
// lowest light/standard tiers that route nothing lighter than its label (zero under-routing).
//
// Usage: node benchmark/internal-effort-probe.mjs --labels file.json [--out result.json] [--only decision,work] [--variant v]
//   labels: [{ id, purpose: decision|work|narrator|setup|compaction, label: light|standard|deep|ambiguous, input: { facts,
//   task?, evidence?, message?, request?, project? }, note? }]. Labelled sets built from real projects hold private text:
//   keep them outside the repository (the research note records distributions only). RNA_URL (default 127.0.0.1:4317).
import { readFileSync, writeFileSync } from 'node:fs';
import { buildDecisionState } from '../../../packages/sdk/src/decision-state.mjs';
import { minimizeDecisionState, deriveDecisionPolicy } from '../../../packages/sdk/src/decision-kernel.mjs';
import { effortTemplate, combineEffortDepth, stakeThreshold, DECISION_THRESHOLDS } from '../../../packages/sdk/src/decision-templates.mjs';

const BASE = process.env.RNA_URL ?? 'http://127.0.0.1:4317';
const DEPTHS = ['light', 'standard', 'deep'];
const rank = depth => DEPTHS.indexOf(depth);
const round = value => typeof value === 'number' ? Math.round(value * 1000) / 1000 : value;
const wire = plan => Object.fromEntries(Object.entries(plan.questions).map(([id, question]) => [id, { ...question, type: question.type === 'boolean' ? 'noul' : question.type }]));

/** The state the kernel would send for one labelled item (production builder, the kernel's character budget). */
export function probeState(item) {
  const point = `effort.${item.purpose}`;
  return minimizeDecisionState(buildDecisionState(point, item.input ?? {}), { maxChars: deriveDecisionPolicy(point).maxStateChars });
}
/** The lowest light and standard thresholds with no item routed lighter than its label (labelled items only). */
export function zeroUnderRoutingTiers(rows) {
  const labelled = rows.filter(row => DEPTHS.includes(row.label) && row.probabilities);
  // light is allowed only for items labelled light: the threshold must exceed P(light) of every deeper item.
  const lightFloor = Math.max(0, ...labelled.filter(row => row.label !== 'light').map(row => row.probabilities.light ?? 0));
  // standard (or lighter) only for light/standard items: above P(light)+P(standard) of every deep item.
  const standardFloor = Math.max(0, ...labelled.filter(row => row.label === 'deep').map(row => (row.probabilities.light ?? 0) + (row.probabilities.standard ?? 0)));
  const lightKept = labelled.filter(row => row.label === 'light' && (row.probabilities.light ?? 0) > lightFloor).length, standardKept = labelled.filter(row => row.label !== 'deep' && (row.probabilities.light ?? 0) + (row.probabilities.standard ?? 0) > standardFloor).length;
  return { light: { mustExceed: round(lightFloor), lightItemsAbove: lightKept, lightItems: labelled.filter(row => row.label === 'light').length }, standard: { mustExceed: round(standardFloor), lighterItemsAbove: standardKept, lighterItems: labelled.filter(row => row.label !== 'deep').length } };
}
async function probe(state, questions) {
  const response = await fetch(`${BASE}/api/v2/decision-kernel/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, questions }) });
  const body = await response.json();
  if (response.status !== 200 || body.status !== 200) throw new Error(`probe ${response.status}/${body.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}
export async function runProbe(items, { only = null } = {}) {
  const rows = [];
  for (const item of items.filter(row => !only || only.has(row.purpose))) {
    const plan = effortTemplate(item.purpose), questions = wire(plan), state = probeState(item);
    const body = await probe(state, questions), raw = body.answers?.depth ?? {};
    const answers = { depth: { type: 'choice', choice: raw.choice, probabilities: raw.probabilities } }, verdict = combineEffortDepth(answers, { point: `effort.${item.purpose}` });
    const under = DEPTHS.includes(item.label) && verdict && rank(verdict) < rank(item.label), over = DEPTHS.includes(item.label) && verdict && rank(verdict) > rank(item.label);
    rows.push({ id: item.id, purpose: item.purpose, label: item.label, choice: raw.choice, probabilities: Object.fromEntries(Object.entries(raw.probabilities ?? {}).map(([key, value]) => [key, round(value)])), verdict, under: Boolean(under), over: Boolean(over), stateChars: JSON.stringify(state).length, latencyMs: body.latencyMs, inputTokens: body.usage?.input_tokens ?? null, ...(item.note ? { note: item.note } : {}) });
  }
  const purposes = [...new Set(rows.map(row => row.purpose))];
  const summary = Object.fromEntries(purposes.map(purpose => {
    const group = rows.filter(row => row.purpose === purpose), labelled = group.filter(row => DEPTHS.includes(row.label));
    return [purpose, { items: group.length, labelled: labelled.length, exact: labelled.filter(row => row.verdict === row.label).length, under: labelled.filter(row => row.under).length, over: labelled.filter(row => row.over).length, abstained: labelled.filter(row => !row.verdict).length,
      thresholds: { light: stakeThreshold(DECISION_THRESHOLDS.points[`effort.${purpose}`].light), standard: stakeThreshold(DECISION_THRESHOLDS.points[`effort.${purpose}`].standard) }, zeroUnderRouting: zeroUnderRoutingTiers(group),
      meanLatencyMs: Math.round(group.reduce((sum, row) => sum + (row.latencyMs ?? 0), 0) / Math.max(1, group.length)), meanInputTokens: Math.round(group.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0) / Math.max(1, group.length)) }];
  }));
  return { at: new Date().toISOString(), base: BASE, summary, rows };
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const arg = name => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : null; };
  const labels = arg('--labels'); if (!labels) { console.error('usage: node benchmark/internal-effort-probe.mjs --labels file.json [--out result.json] [--only decision,work]'); process.exit(2); }
  const only = arg('--only') ? new Set(arg('--only').split(',')) : null;
  const result = await runProbe(JSON.parse(readFileSync(labels, 'utf8')), { only });
  if (arg('--out')) writeFileSync(arg('--out'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.summary, null, 2));
}
