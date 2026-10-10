import { createHash } from 'node:crypto';
import { skillMetadataField } from './capabilities.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
export const marketplaceSkillSourceSchema = object({
  kind: { const: 'marketplace-package' }, provider: { enum: ['clawhub', 'skills-sh', 'skillsmp'] }, id: text(500), repository: text(300),
  commit: { type: 'string', pattern: '^[0-9a-f]{40}$' }, subdirectory: text(400), sourceUrl: text(1000), catalogUrl: text(1000),
  packageHash: { type: 'string', pattern: '^[0-9a-f]{64}$' }, acquiredAt: text(100), reason: text(2000), compatibility: text(2000),
  // 'no_license_declared_local_use': the source repository ships no license file; the package is installed for
  // this user's local project only (never redistributed), with its provenance recorded.
  licenseReview: { enum: ['preserved_not_legal_approval', 'no_license_declared_local_use'] }, licensePaths: { type: 'array', minItems: 0, maxItems: 128, uniqueItems: true, items: text(400) },
  files: { type: 'array', minItems: 1, maxItems: 128, items: object({ path: text(400), contentHash: { type: 'string', pattern: '^[0-9a-f]{64}$' }, bytes: { type: 'integer', minimum: 0, maximum: 64000 } }) }
});

// A local installation receipt proves its recorded Git identity and selected
// installation-time hashes. It is not evidence of marketplace discovery or of
// remote Git verification for every resource in the current installed snapshot.
export const installedSkillSourceSchema = object({
  kind: { const: 'installed-skill-package' }, integrity: { const: 'installed_snapshot' },
  installationId: text(100), manifestId: text(100), installationRecordHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  repository: text(2000), commit: { type: 'string', pattern: '^[0-9a-f]{40}$' }, subdirectory: text(400),
  packageHash: { type: 'string', pattern: '^[0-9a-f]{64}$' }, frozenAt: text(100), reason: text(2000), compatibility: text(2000),
  licenseReview: { const: 'preserved_not_legal_approval' }, licensePaths: { ...marketplaceSkillSourceSchema.properties.licensePaths, minItems: 1 },
  files: marketplaceSkillSourceSchema.properties.files,
});
export const projectSkillSourceSchema = { anyOf: [marketplaceSkillSourceSchema, installedSkillSourceSchema] };

/** Source bytes are host-owned, never generated in the model's final JSON. */
export function marketplaceGenomeSkill(bundle, { reason, compatibility }) {
  const skill = bundle.files.find(file => file.path === 'SKILL.md');
  if (!skill) throw new Error('Acquired package has no SKILL.md');
  const header = skill.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '';
  const field = key => skillMetadataField(header, key);
  const name = (field('name') || bundle.id.split('/').at(-1)).slice(0, 100);
  const description = (field('description') || `Source package ${bundle.repository}/${bundle.subdirectory}; load to inspect its documented trigger.`).slice(0, 1000);
  const { files, installed, executesCode, omittedFiles, ...provenance } = bundle;
  return { id: `market_${hash(`${bundle.repository}:${bundle.subdirectory}:${bundle.commit}`).slice(0, 24)}`, name, description,
    instructions: skill.content, resources: files.filter(file => file.path !== 'SKILL.md').map(({ path, content }) => ({ path, content })),
    source: { kind: 'marketplace-package', ...provenance, reason, compatibility, files: files.map(({ path, contentHash, bytes }) => ({ path, contentHash, bytes })) } };
}

export function validateMarketplaceSkillBytes(skill) {
  if (!skill.source) return;
  const files = [{ path: 'SKILL.md', content: skill.instructions }, ...skill.resources];
  const actual = files.map(({ path, content }) => ({ path, contentHash: hash(content), bytes: Buffer.byteLength(content) }));
  if (JSON.stringify(actual) !== JSON.stringify(skill.source.files) || hash(JSON.stringify(actual)) !== skill.source.packageHash || !skill.source.licensePaths.every(path => actual.some(file => file.path === path)) || skill.source.licenseReview !== 'no_license_declared_local_use' && !skill.source.licensePaths.length) throw new Error('Marketplace package bytes or license inventory do not match their acquired source');
}

export function projectSkillDocument(skill) {
  return ['marketplace-package', 'installed-skill-package'].includes(skill.source?.kind) ? skill.instructions : `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.instructions}\n`;
}
