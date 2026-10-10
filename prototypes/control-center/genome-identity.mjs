import { genomeToolName } from '../../packages/sdk/src/project-genome.mjs';
import { genomeSkillId, genomeIdentity } from './project-genome-store.mjs';
import { projectRhythmEvidenceKey } from './project-rhythm.mjs';

/**
 * EVO-3 / TC-1, one time and idempotent (every start; a second run changes nothing). Generated tool and skill names used
 * to hash the project *and the version* (`gen_<hash(project:version)>_<localId>`), so every generation renamed every
 * generated tool, changed the tools array and cost each live conversation of the project one whole uncached request. They
 * are the project's now (`genomeIdentity`); this renames what the state already holds:
 * - every version's generated skill and tool rows (generatedSkills, skillManifests, generatedTools, toolDescriptors);
 * - the project's assignments (ids, reasons) and every version's saved assignments, order kept, duplicates folded;
 * - the capability snapshot (skill hashes, tools), the active or trial version's entry winning a collision;
 * - `state.capabilities.skills`: one manifest per (project, localId), the active or trial version's (else the last),
 *   since CapabilityRegistry refuses a duplicate id and two generations now share it.
 * Rows of a deleted project are left as they are: their old ids stay unique and the deletion owns them. Session journals
 * and old tool calls are history and are not rewritten. Storage identity (record.namespace, bundle hashes) is unchanged.
 *
 * The initiative scope split (0.65, PDL-1/MEM-2) treats a change of this project's own assignments and capability
 * declarations as drift (a refresh), never as a revocation, so the rename revokes no receipt and stops no work.
 * The rename is not evidence either: the rhythm evidence key hashes the assignments, so a project whose last accepted
 * decision had consumed the key before the rename gets the renamed key as consumed too (as a schedule the decision itself
 * registered does, project-schedule-service). Otherwise every live project would wake once as `new_evidence` after the
 * upgrade, and the gate could not hold it: a deferral does not consume the key, the two-pass bound forces a paid review.
 */
const SKILL = /^gen-[a-f0-9]{16}-/, TOOL = /^gen_[a-f0-9]{8}_/;
const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);
const json = value => JSON.stringify(value ?? null);
const localOf = (row, pattern) => typeof row?.localId === 'string' && row.localId ? row.localId : typeof row?.id === 'string' && pattern.test(row.id) ? row.id.replace(pattern, '') : null;
/** Ids in order with each remapped and only its first occurrence kept. */
const remapIds = (ids, map) => Array.isArray(ids) ? [...new Set(ids.map(id => map.get(id) ?? id))] : ids;
/** Reason rows remapped; one row per (kind, id), the last one kept, in the order of those last occurrences. */
function remapReasons(rows, map) {
  if (!Array.isArray(rows)) return rows;
  const mapped = rows.map(row => isRecord(row) && typeof row.id === 'string' && map.has(row.id) ? { ...row, id: map.get(row.id) } : row);
  const last = new Map(mapped.map((row, index) => [isRecord(row) ? `${row.kind ?? ''}\u0000${row.id}` : `\u0001${index}`, index]));
  return mapped.filter((row, index) => last.get(isRecord(row) ? `${row.kind ?? ''}\u0000${row.id}` : `\u0001${index}`) === index);
}
function remapAssignments(value, map) {
  if (!isRecord(value)) return value;
  const next = { ...value };
  for (const key of ['skillIds', 'toolIds']) if (Array.isArray(value[key])) next[key] = remapIds(value[key], map);
  if (Array.isArray(value.reasons)) next.reasons = remapReasons(value.reasons, map);
  return next;
}

export function migrateGenomeIdentities(state) {
  const result = { changed: false, projects: 0, remapped: 0 };
  if (!isRecord(state) || !Array.isArray(state.projects)) return result;
  const existing = new Set(state.projects.filter(isRecord).map(project => project.id));
  let capabilitiesChanged = false;
  for (const project of state.projects) {
    if (!isRecord(project) || typeof project.id !== 'string' || !project.id) continue;
    const identity = genomeIdentity(project.id), skillName = localId => genomeSkillId(identity, localId), toolName = localId => genomeToolName(identity, localId);
    const map = new Map(), owner = new Map(), selected = project.trialVersionId ?? project.activeVersionId ?? null;
    let changed = false;
    // 1. Version rows: the old id of each, and which version it named.
    for (const version of Array.isArray(project.versions) ? project.versions : []) {
      if (!isRecord(version)) continue;
      for (const [key, pattern, name] of [['generatedSkills', SKILL, skillName], ['skillManifests', SKILL, skillName], ['generatedTools', TOOL, toolName], ['toolDescriptors', TOOL, toolName]]) {
        if (!Array.isArray(version[key])) continue;
        version[key] = version[key].map(row => {
          if (!isRecord(row) || typeof row.id !== 'string') return row;
          // Only generated names are renamed (a row whose id is not one is left as it is).
          const localId = pattern.test(row.id) ? localOf(row, pattern) : null; if (!localId) return row;
          const stable = name(localId); if (row.id === stable && (pattern === SKILL || row.toolName === undefined || row.toolName === stable)) return row;
          if (row.id !== stable) { map.set(row.id, stable); owner.set(row.id, version.id); }
          changed = true;
          return { ...row, id: stable, ...(pattern === TOOL && row.toolName !== undefined ? { toolName: stable } : {}) };
        });
      }
    }
    // 2. Assignments, saved per-version assignments, capability snapshot. The rhythm key is read before (step 1 renames
    // version rows, which the key does not hash).
    const rhythm = isRecord(project.rhythmRuntime) && typeof project.rhythmRuntime.evidenceKey === 'string' && map.size ? project.rhythmRuntime : null;
    const consumed = rhythm && rhythm.evidenceKey === projectRhythmEvidenceKey(state, project);
    if (map.size) {
      for (const [target, key] of [[project, 'assignments'], ...(Array.isArray(project.versions) ? project.versions.filter(isRecord).map(version => [version, 'assignments']) : [])]) {
        if (!isRecord(target[key])) continue;
        const next = remapAssignments(target[key], map);
        if (json(next) !== json(target[key])) { target[key] = next; changed = true; }
      }
      const snapshot = project.capabilitySnapshot;
      if (isRecord(snapshot)) {
        const next = { ...snapshot };
        if (isRecord(snapshot.skillHashes)) {
          const hashes = {}, from = {};
          for (const [id, value] of Object.entries(snapshot.skillHashes)) {
            const stable = map.get(id) ?? id;
            // A collision keeps the selected version's hash; otherwise the later entry.
            if (Object.hasOwn(hashes, stable) && from[stable] === selected && owner.get(id) !== selected) continue;
            hashes[stable] = value; from[stable] = owner.get(id) ?? null;
          }
          next.skillHashes = hashes;
        }
        if (Array.isArray(snapshot.tools)) {
          const tools = [], at = new Map();
          for (const row of snapshot.tools) {
            if (!isRecord(row) || typeof row.id !== 'string' || !map.has(row.id)) { tools.push(row); continue; }
            const stable = map.get(row.id), renamed = { ...row, id: stable, ...(row.toolName !== undefined ? { toolName: stable } : {}) };
            if (!at.has(stable)) { at.set(stable, tools.length); tools.push(renamed); continue; }
            const index = at.get(stable), kept = tools[index];
            if (!(kept.versionId === selected && renamed.versionId !== selected)) tools[index] = renamed;
          }
          next.tools = tools;
        }
        if (json(next) !== json(snapshot)) { project.capabilitySnapshot = next; changed = true; }
      }
    }
    if (consumed) { const renamed = projectRhythmEvidenceKey(state, project); if (renamed !== rhythm.evidenceKey) { rhythm.evidenceKey = renamed; changed = true; } }
    if (changed) { result.projects++; result.remapped += map.size; result.changed = true; }
  }
  // 3. One manifest per (project, localId) in the registry, renamed; a deleted project's rows are its deletion's.
  if (isRecord(state.capabilities) && Array.isArray(state.capabilities.skills)) {
    const projects = new Map(state.projects.filter(isRecord).map(project => [project.id, project]));
    const groups = new Map();
    state.capabilities.skills.forEach((row, index) => {
      if (!isRecord(row) || row.managed !== 'project-genome' || !existing.has(row.projectId)) return;
      const localId = SKILL.test(String(row.id)) ? localOf(row, SKILL) : null; if (!localId) return;
      const key = `${row.projectId}\u0000${localId}`; (groups.get(key) ?? groups.set(key, []).get(key)).push(index);
    });
    const keep = new Map(), drop = new Set();
    for (const [key, indexes] of groups) {
      const projectId = key.split('\u0000')[0], project = projects.get(projectId), selected = project.trialVersionId ?? project.activeVersionId ?? null;
      const chosen = indexes.findLast(index => state.capabilities.skills[index].versionId === selected) ?? indexes.at(-1);
      for (const index of indexes) if (index !== chosen) drop.add(index);
      keep.set(chosen, genomeSkillId(genomeIdentity(projectId), localOf(state.capabilities.skills[chosen], SKILL)));
    }
    if (drop.size || [...keep].some(([index, id]) => state.capabilities.skills[index].id !== id)) {
      state.capabilities.skills = state.capabilities.skills.flatMap((row, index) => drop.has(index) ? [] : keep.has(index) && row.id !== keep.get(index) ? [{ ...row, id: keep.get(index) }] : [row]);
      capabilitiesChanged = true;
    }
  }
  if (capabilitiesChanged || result.changed) {
    if (isRecord(state.capabilities)) state.capabilities.revision = (Number.isSafeInteger(state.capabilities.revision) ? state.capabilities.revision : 0) + 1;
    result.changed = true;
  }
  return result;
}
