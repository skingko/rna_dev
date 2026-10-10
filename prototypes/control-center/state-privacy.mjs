import { readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// What Rna keeps private from the project's tools: the state file and every `<state>.*` sibling (sidecars, journals,
// credentials, checkpoints). One deny root for every caller instead of hand-copied lists (alignment 2026-10-05 §1.3 G).
// The folder around the state file is not denied: managed project workspaces live in `<state dir>/projects/`, and a
// project folder may itself hold the state file (a test, or this repository).

/** Sidecars that may not exist yet when a turn starts; any other `<state>.*` sibling is found by listing. */
const SIDECARS = Object.freeze(['d', 'observations', 'service', 'recovery', 'recovery.json', 'secrets', 'subscriptions', 'rna', 'pi', 'capabilities', 'genomes', 'evolution', 'initialization', 'skill-foundation', 'archive', 'background-changes', 'usage-cache.jsonl', 'usage-cache.survival.json', 'v1-backup', 'before-projects-backup', 'lock', 'previews', 'direct-fixes']);
/**
 * What a sandboxed command may still read inside the private state: skill packages, whose scripts run from their own
 * folder (skill_load reports it), and the runtime of a maintenance-applied daemon — the shared Node copies and the
 * release slots (runtime-release.mjs sharedNodeLocation; maintenancePaths), whose Node comes first on a command's PATH
 * and whose npm runs `<release>/lib/npm`. They hold Rna's own code only; the rest of `<state>.service` (receipts, logs,
 * checkpoints, maintenance records) stays denied.
 */
const SANDBOX_READABLE = Object.freeze(['capabilities', 'genomes', 'skill-foundation', 'service/node', 'service/releases']);

/** The state file and all its sidecars, absolute: never read or written by project tools. */
export function privateStatePaths(file) {
  const state = resolve(file), folder = dirname(state), name = basename(state);
  let present = [];
  try { present = readdirSync(folder).filter(entry => entry.startsWith(`${name}.`)).map(entry => join(folder, entry)); } catch {}
  return [...new Set([state, ...SIDECARS.map(suffix => `${state}.${suffix}`), ...present])];
}
/** Paths inside the private state a sandboxed command may read (never write). */
export function sandboxReadableStatePaths(file) {
  const state = resolve(file);
  return SANDBOX_READABLE.map(suffix => `${state}.${suffix}`);
}

/** Rna's own credential variables: providers, memory, web tools, the skill marketplace and JEV. */
export function rnaCredentialEnvironmentNames(state = {}) {
  const configuration = state.configuration ?? {};
  return names([...(configuration.providers ?? []).map(provider => provider?.apiKeyEnv), configuration.memory?.apiKeyEnv, configuration.webTools?.apiKeyEnv,
    configuration.marketplaces?.skillsmp?.apiKeyEnv ?? 'SKILLSMP_API_KEY', 'TYPESAFE_API_KEY']);
}
/** The variables configured command tools and MCP services take their credentials from (GITHUB_TOKEN, …). */
export function capabilityEnvironmentNames(state = {}) {
  const capabilities = state.capabilities ?? {};
  return names([...(capabilities.tools ?? []), ...(capabilities.mcpServers ?? [])].flatMap(item => [...(item?.envNames ?? []), ...Object.values(item?.envMapping ?? {}), ...Object.values(item?.headerEnv ?? {})]));
}
const names = list => [...new Set(list.filter(name => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))].sort();
/** Environment variable names the settings use as credential sources (also redacted from tool output elsewhere). */
export function credentialEnvironmentNames(state = {}) {
  return names([...rnaCredentialEnvironmentNames(state), ...capabilityEnvironmentNames(state)]);
}

/**
 * createWorkspaceTools options that keep Rna's state and credentials away from the project's file tools and commands.
 * Every command goes without Rna's own credential variables. An `unattended` run (background work, a worker) also goes
 * without the capability and MCP credential variables; a foreground command the user is watching keeps them, so the
 * user's own scripts that read e.g. GITHUB_TOKEN still work there. `<state>.` is denied as a prefix too, so siblings
 * created after the tools (`state.json.secrets.tmp-<pid>`, `state.json.tmp-<pid>-<uuid>`) are covered.
 */
export function stateConfinement(store, { unattended = false } = {}) {
  const state = resolve(store.file);
  return { deniedPaths: privateStatePaths(state), deniedPrefixes: [`${state}.`], sandboxReadable: sandboxReadableStatePaths(state), withheldEnv: unattended ? credentialEnvironmentNames(store.state) : rnaCredentialEnvironmentNames(store.state) };
}
