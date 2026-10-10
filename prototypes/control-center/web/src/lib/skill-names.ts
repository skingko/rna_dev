/**
 * Pure skill-name resolution (no store): capability metadata, then SKILL.md
 * front matter from the tool output, then a humanized id — never the raw
 * generated id (`gen-369075cf…`).
 */
import type { ProjectSkill } from '@/api/project-api'
import { t } from '@/i18n'

export const GEN = /^gen-[0-9a-f]{8,}-/i

/** The id without generated/marketplace prefixes: `daily-research-workflow`. */
export function localSkillId(id: string): string {
  return id.replace(GEN, '').replace(/^skill-/, '')
}

export function humanizeSkillId(id: string): string {
  if (!id) return ''
  const local = localSkillId(id)
  if (/^[0-9a-f-]{16,}$/i.test(local) || /^market_[0-9a-f]+$/i.test(local)) return ''
  return local.replace(/[-_]+/g, ' ').trim()
}

/** `name:` from SKILL.md front matter inside a skill_load tool output (JSON or raw). */
export function frontMatterName(output?: string): string {
  if (!output) return ''
  let content = output
  try {
    const parsed = JSON.parse(output) as { content?: unknown; name?: unknown }
    if (typeof parsed.name === 'string' && parsed.name.trim()) return parsed.name.trim()
    if (typeof parsed.content === 'string') content = parsed.content
  } catch { /* not JSON */ }
  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(content)
  const name = fm && /^name:\s*["']?(.+?)["']?\s*$/m.exec(fm[1])
  return name ? name[1].trim() : ''
}

export function skillDisplayName(id: string, catalog: ProjectSkill[], output?: string): string {
  if (!id) return ''
  const exact = catalog.find(s => s.id === id)
  if (exact?.name) return exact.name
  // Generated skills are re-issued per version with a new hash prefix: match on the local id.
  const local = localSkillId(id)
  const sibling = catalog.find(s => (s.localId ?? localSkillId(s.id)) === local && s.name)
  if (sibling) return sibling.name
  return frontMatterName(output) || humanizeSkillId(id) || t('项目技能')
}
