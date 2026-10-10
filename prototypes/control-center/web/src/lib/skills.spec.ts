import { describe, expect, it } from 'vitest'
import { frontMatterName, humanizeSkillId, skillDisplayName } from './skills'

const catalog = [
  { id: 'skill-frontend-design', name: 'frontend-design' },
  { id: 'gen-59b6c5f75c83c7c8-ink-jump-design', localId: 'ink-jump-design', name: '水墨跳跃机制设计' },
]

describe('skill names', () => {
  it('uses capability metadata first', () => {
    expect(skillDisplayName('skill-frontend-design', catalog)).toBe('frontend-design')
  })
  it('matches generated skills across version hashes by local id', () => {
    expect(skillDisplayName('gen-0770d810df366217-ink-jump-design', catalog)).toBe('水墨跳跃机制设计')
  })
  it('falls back to SKILL.md front matter from the tool output', () => {
    const output = JSON.stringify({ id: 'gen-369075cf2a5376d7-daily-research-workflow', content: '---\nname: "每日 Ai 调研与报告"\ndescription: "x"\n---\n# body' })
    expect(frontMatterName(output)).toBe('每日 Ai 调研与报告')
    expect(skillDisplayName('gen-369075cf2a5376d7-daily-research-workflow', [], output)).toBe('每日 Ai 调研与报告')
  })
  it('never shows the generated hash', () => {
    expect(humanizeSkillId('gen-369075cf2a5376d7-daily-research-workflow')).toBe('daily research workflow')
    expect(skillDisplayName('gen-e67276fe4b52b5d4-market_ba3c6dd7e0f454da21ac1a4a', [])).toBe('项目技能')
  })
})
