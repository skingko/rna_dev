import { validateToolArguments } from './capabilities.mjs';
import { evolutionHash } from './evolution.mjs';
import { projectGenomeSchema, validateProjectGenome } from './project-genome.mjs';

const clone = value => structuredClone(value);
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const baseSkill = projectGenomeSchema.properties.skills.items;
const skillId = clone(baseSkill.properties.id), resourcePath = clone(baseSkill.properties.resources.items.properties.path);
const beforeHash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const reason = { type: 'string', minLength: 12, maxLength: 1000, pattern: '\\S' };
const skillIdentity = object({ id: skillId, beforeHash });
const resourceIdentity = object({ skillId, path: resourcePath, beforeHash });
const withdrawSkill = object({ id: skillId, beforeHash, reason });
const withdrawResource = object({ skillId, path: resourcePath, beforeHash, reason });
const array = (items, maxItems) => ({ type: 'array', maxItems, items });
const declarationSchema = object({ withdrawSkills: array(withdrawSkill, 12), withdrawSkillResources: array(withdrawResource, 1536) }, []);
const assetSchema = object({ schemaVersion: { const: 1 }, baselineHash: beforeHash, inheritedSkills: array(skillIdentity, 12), inheritedSkillResources: array(resourceIdentity, 1536), withdrawnSkills: array(withdrawSkill, 12), withdrawnSkillResources: array(withdrawResource, 1536) });
const fail = message => Object.assign(new Error(message), { name: 'ProjectProposalInheritanceError', code: 'invalid_genome' });
function validate(schema, value) { try { validateToolArguments(schema, value); } catch (error) { throw fail(`Invalid proposal skill assets: ${error.message}`); } }
function baselineValue(value) { try { return validateProjectGenome(value); } catch (error) { throw fail(`Invalid frozen skill baseline: ${error.message}`); } }
function unique(rows, key, label) {
  const seen = new Set();
  for (const row of rows) { const id = key(row); if (seen.has(id)) throw fail(`Duplicate ${label}: ${id}`); seen.add(id); }
}
const resourceKey = row => `${row.skillId}\0${row.path}`;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sortedSkills = rows => rows.sort((a, b) => compare(a.id, b.id));
const sortedResources = rows => rows.sort((a, b) => compare(a.skillId, b.skillId) || compare(a.path, b.path));
function validateResources(skills) {
  unique(skills, row => row.id, 'skill ID');
  for (const skill of skills) {
    unique(skill.resources, row => row.path, `resource path in ${skill.id}`);
    for (const resource of skill.resources) if (!/^[A-Za-z0-9_.@+ -]+(?:\/[A-Za-z0-9_.@+ -]+)*$/.test(resource.path) || resource.path.split('/').some(part => ['.', '..', '.git', 'node_modules'].includes(part)) || resource.path === 'SKILL.md') throw fail(`Unsafe skill resource path: ${resource.path}`);
  }
}

/** Author-only schema. Published genomes retain the original complete schema. */
export function authorSkillSchema(skillSchema = baseSkill) {
  const full = clone(skillSchema);
  if (!full.properties?.id || !full.properties?.resources?.items?.properties?.path) throw fail('Author skill schema requires complete skill and resource declarations');
  const skillRef = object({ id: clone(full.properties.id), inheritFromBaseline: { const: true } });
  const resourceRef = object({ path: clone(full.properties.resources.items.properties.path), inheritFromBaseline: { const: true } });
  full.properties.resources.items = { oneOf: [clone(full.properties.resources.items), resourceRef] };
  return { oneOf: [full, skillRef] };
}

/** Add these optional properties to the outer proposal, never to its genome. */
export const proposalAssetDeclarationProperties = clone(declarationSchema.properties);

/** Hashes are public authoring identity, not hidden smoke/evaluation contents. */
export function projectSkillAssetInventory(baseline) {
  const valid = baselineValue(baseline);
  return { baselineHash: evolutionHash(valid), skills: valid.skills.map(skill => ({ id: skill.id, beforeHash: evolutionHash(skill), resources: skill.resources.map(resource => ({ path: resource.path, beforeHash: evolutionHash(resource) })) })) };
}

/** Resolve an explicit complete inventory against one frozen baseline. Omissions
 * never imply inheritance or deletion. This only copies data; it executes none. */
export function expandAuthorSkills(genome, baseline, declarations = {}) {
  const valid = baselineValue(baseline), input = clone(genome?.skills);
  validate({ ...clone(projectGenomeSchema.properties.skills), items: authorSkillSchema() }, input);
  validate(declarationSchema, declarations);
  unique(input, row => row.id, 'author skill ID');
  const withdrawSkills = clone(declarations.withdrawSkills ?? []), withdrawSkillResources = clone(declarations.withdrawSkillResources ?? []);
  unique(withdrawSkills, row => row.id, 'withdrawn skill ID');
  unique(withdrawSkillResources, resourceKey, 'withdrawn resource');
  for (const row of [...withdrawSkills, ...withdrawSkillResources]) if (row.reason.trim().length < 12) throw fail('Asset withdrawal requires a specific reason of at least 12 characters after trimming');
  const originals = new Map(valid.skills.map(skill => [skill.id, skill]));
  const authored = new Map(input.map(skill => [skill.id, skill]));
  const deletedSkills = new Set(withdrawSkills.map(row => row.id)), deletedResources = new Set(withdrawSkillResources.map(resourceKey));
  for (const row of withdrawSkills) {
    const original = originals.get(row.id);
    if (!original || evolutionHash(original) !== row.beforeHash) throw fail(`Unknown or changed skill withdrawal: ${row.id}`);
    if (authored.has(row.id)) throw fail(`Withdrawn skill is still present: ${row.id}`);
  }
  for (const row of withdrawSkillResources) {
    if (deletedSkills.has(row.skillId)) throw fail(`Cannot withdraw a skill and its resource together: ${row.skillId}`);
    const original = originals.get(row.skillId)?.resources.find(resource => resource.path === row.path);
    if (!original || evolutionHash(original) !== row.beforeHash) throw fail(`Unknown or changed resource withdrawal: ${row.skillId}/${row.path}`);
    const next = authored.get(row.skillId);
    if (!next) throw fail(`Resource withdrawal requires its retained skill: ${row.skillId}`);
    if (next.inheritFromBaseline === true || next.resources.some(resource => resource.path === row.path)) throw fail(`Withdrawn resource is still present: ${row.skillId}/${row.path}`);
  }
  for (const original of valid.skills) if (!authored.has(original.id) && !deletedSkills.has(original.id)) throw fail(`Existing skill was omitted without withdrawSkills: ${original.id}`);
  const inheritedSkills = [], inheritedSkillResources = [];
  const skills = input.map(skill => {
    const original = originals.get(skill.id);
    if (skill.inheritFromBaseline === true) {
      if (!original) throw fail(`Cannot inherit unknown skill: ${skill.id}`);
      inheritedSkills.push({ id: skill.id, beforeHash: evolutionHash(original) });
      return clone(original);
    }
    unique(skill.resources, row => row.path, `author resource path in ${skill.id}`);
    const paths = new Set(skill.resources.map(resource => resource.path));
    for (const resource of original?.resources ?? []) if (!paths.has(resource.path) && !deletedResources.has(resourceKey({ skillId: skill.id, path: resource.path }))) throw fail(`Existing resource was omitted without withdrawSkillResources: ${skill.id}/${resource.path}`);
    return { ...clone(skill), resources: skill.resources.map(resource => {
      if (resource.inheritFromBaseline !== true) return clone(resource);
      const source = original?.resources.find(item => item.path === resource.path);
      if (!source) throw fail(`Cannot inherit unknown skill resource: ${skill.id}/${resource.path}`);
      inheritedSkillResources.push({ skillId: skill.id, path: resource.path, beforeHash: evolutionHash(source) });
      return clone(source);
    }) };
  });
  validate(projectGenomeSchema.properties.skills, skills); validateResources(skills);
  return { skills, assetChanges: { schemaVersion: 1, baselineHash: evolutionHash(valid), inheritedSkills: sortedSkills(inheritedSkills), inheritedSkillResources: sortedResources(inheritedSkillResources), withdrawnSkills: sortedSkills(withdrawSkills), withdrawnSkillResources: sortedResources(withdrawSkillResources) } };
}

/** Compress only unchanged, hash-verified inherited assets for later author
 * repair. Current complete publication data remains untouched. */
export function authorRepairSkills(skills, assetChanges, baseline) {
  validate(projectGenomeSchema.properties.skills, skills); validateResources(skills);
  if (assetChanges === undefined) return clone(skills);
  validate(assetSchema, assetChanges);
  unique(assetChanges.inheritedSkills, row => row.id, 'inherited skill ID');
  unique(assetChanges.inheritedSkillResources, resourceKey, 'inherited skill resource');
  unique(assetChanges.withdrawnSkills, row => row.id, 'withdrawn skill ID');
  unique(assetChanges.withdrawnSkillResources, resourceKey, 'withdrawn skill resource');
  const valid = baseline === undefined ? undefined : baselineValue(baseline);
  if (valid && evolutionHash(valid) !== assetChanges.baselineHash) throw fail('Skill inheritance refers to a different frozen baseline');
  const result = clone(skills), byId = new Map(result.map(skill => [skill.id, skill]));
  for (const row of assetChanges.withdrawnSkills) {
    const source = valid?.skills.find(item => item.id === row.id);
    if (byId.has(row.id) || valid && (!source || evolutionHash(source) !== row.beforeHash)) throw fail(`Withdrawn skill changed during repair: ${row.id}`);
  }
  for (const row of assetChanges.withdrawnSkillResources) {
    const source = valid?.skills.find(item => item.id === row.skillId)?.resources.find(item => item.path === row.path);
    if (!byId.has(row.skillId) || byId.get(row.skillId).resources.some(resource => resource.path === row.path) || valid && (!source || evolutionHash(source) !== row.beforeHash)) throw fail(`Withdrawn resource changed during repair: ${row.skillId}/${row.path}`);
  }
  const inherited = new Set(assetChanges.inheritedSkills.map(row => row.id));
  for (const row of assetChanges.inheritedSkillResources) {
    if (inherited.has(row.skillId)) throw fail(`Overlapping skill/resource inheritance: ${row.skillId}`);
    const skill = byId.get(row.skillId), resource = skill?.resources.find(item => item.path === row.path);
    const source = valid?.skills.find(item => item.id === row.skillId)?.resources.find(item => item.path === row.path);
    if (!resource || evolutionHash(resource) !== row.beforeHash || valid && (!source || evolutionHash(source) !== row.beforeHash)) throw fail(`Inherited resource changed during repair: ${row.skillId}/${row.path}`);
    skill.resources = skill.resources.map(item => item.path === row.path ? { path: item.path, inheritFromBaseline: true } : item);
  }
  for (const row of assetChanges.inheritedSkills) {
    const skill = byId.get(row.id);
    const source = valid?.skills.find(item => item.id === row.id);
    if (!skill || evolutionHash(skill) !== row.beforeHash || valid && (!source || evolutionHash(source) !== row.beforeHash)) throw fail(`Inherited skill changed during repair: ${row.id}`);
  }
  return result.map(skill => inherited.has(skill.id) ? { id: skill.id, inheritFromBaseline: true } : skill);
}
