import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { detectFeatures, missingFeature } from './features.mjs';

// Deterministic scenario runner (plan §5 scenarios). Each scenario module
// default-exports { id, title, requires: [features], run(context) → checks[] }.
// Missing K1/K2 features → status 'skip' with a reason; any failed check →
// 'fail'; an exception → 'error'. Scenario outcomes never throw.
export const SCENARIO_DIR = fileURLToPath(new URL('./scenarios/', import.meta.url));
export const check = (name, pass, detail = null) => ({ name, pass: Boolean(pass), ...(detail === null ? {} : { detail }) });

export async function loadScenarios(dir = SCENARIO_DIR) {
  const files = readdirSync(dir).filter(name => name.endsWith('.mjs')).sort();
  return Promise.all(files.map(async name => ({ file: name, ...(await import(pathToFileURL(join(dir, name)).href)).default })));
}

/** force: run scenarios even when features are missing (baseline diagnostics; adapter-dependent ones will error). */
export async function runScenarios({ only, dir, features, adapterDir, env, force = false, onResult = () => {} } = {}) {
  const detected = features ?? await detectFeatures({ adapterDir, env });
  const scenarios = (await loadScenarios(dir)).filter(row => !only?.length || only.includes(row.id));
  const results = [];
  for (const scenario of scenarios) {
    const started = Date.now(), missing = missingFeature(detected, scenario.requires ?? []), skip = force ? null : missing;
    let result;
    if (skip) result = { id: scenario.id, title: scenario.title, status: 'skip', reason: skip, checks: [] };
    else {
      try {
        const checks = await scenario.run({ features: detected, check });
        result = { id: scenario.id, title: scenario.title, status: checks.every(row => row.pass) ? 'pass' : 'fail', checks };
      } catch (failure) { result = { id: scenario.id, title: scenario.title, status: 'error', reason: failure.message, code: failure.code ?? null, checks: [] }; }
    }
    result.durationMs = Date.now() - started; result.requires = scenario.requires ?? []; if (force && missing) result.forced = missing;
    results.push(result); onResult(result);
  }
  const summary = { pass: 0, fail: 0, skip: 0, error: 0 }; for (const row of results) summary[row.status]++;
  return { features: Object.fromEntries(Object.entries(detected).map(([key, value]) => [key, value.available ? 'available' : value.reason])), summary, results };
}

export function scenarioText(report) {
  const lines = [`scenarios: ${report.summary.pass} pass · ${report.summary.fail} fail · ${report.summary.skip} skip · ${report.summary.error} error`];
  for (const row of report.results) {
    lines.push(`  [${row.status.toUpperCase()}] ${row.id} — ${row.title}${row.reason ? ` (${row.reason})` : ''}`);
    for (const item of row.checks) lines.push(`      ${item.pass ? 'ok  ' : 'FAIL'} ${item.name}${item.detail !== undefined ? ` — ${typeof item.detail === 'string' ? item.detail : JSON.stringify(item.detail)}` : ''}`);
  }
  return lines.join('\n');
}
