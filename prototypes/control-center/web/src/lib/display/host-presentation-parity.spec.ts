// @ts-nocheck -- compares against the host's untyped presentation modules with loose fixtures.
/**
 * The CLI formats with the host's presentation/*.mjs, the workbench with these
 * TS ports. Both must project the same records identically (zh locale).
 */
import { describe, expect, it } from 'vitest'
import * as web from './evolution-evidence'
import * as webSource from './observation-source'
import * as webMaintenance from '@/components/settings/maintenance-display'
import * as host from '../../../../presentation/evolution-evidence-display.mjs'
import * as hostSource from '../../../../presentation/observation-source-display.mjs'
import * as hostMaintenance from '../../../../presentation/maintenance-display.mjs'

const genome = (skills, prompt = 'p') => ({ systemPrompt: prompt, skills, tools: [{ id: 't1' }], evaluationSuite: { cases: [] } })
const base = { id: 'v1', version: '1', state: 'baseline', bundle: { genome: genome([{ id: 's1' }]) } }
const child = { id: 'v2', version: '2', state: 'ready', parentVersionId: 'v1', createdAt: '2026-09-28T01:00:00Z', bundle: { hash: 'h', genome: genome([{ id: 's1' }, { id: 's2', name: '**New** skill' }], 'q') }, evaluation: { evaluationComplete: true, gatePassed: true, selection: { baselineScore: 0.5, candidateScore: 0.62 }, suite: { thresholds: { minImprovement: 0.05 } } } }
const retry = { id: 'v4', retryOfVersionId: 'v2', state: 'evaluating', createdAt: '2026-09-28T02:00:00Z' }
const abstained = { id: 'v5', state: 'no_change', authorAbstention: { reason: 'insufficient_evidence', revisitWhen: [{ description: 'new data' }] } }
const project = { id: 'p', activeVersionId: 'v1', versions: [base, child, retry, abstained, { ...child, id: 'v3', sourceDeleted: true }], skillFoundation: { schemaVersion: 1, status: 'ready', sourceCount: 2, coverage: [{ id: 'a', status: 'selected', skillIds: ['x'] }] } }
const versions = [base, child, retry, abstained, {}, { source: 'skill-foundation' }]

describe('host presentation modules match the workbench ports', () => {
  it('exports the same evolution-evidence functions', () => {
    expect(Object.keys(host).sort()).toEqual(Object.keys(web).sort())
  })
  it('evolution evidence projections are identical', () => {
    const same = (name, ...args) => expect(JSON.stringify(web[name](...args)), name).toBe(JSON.stringify(host[name](...args)))
    same('evolutionFunnelDisplay', project)
    same('skillFoundationDisplay', project)
    same('projectExternalSkillsDisplay', project, {})
    for (const version of versions) {
      for (const name of ['evolutionSearchDisplay', 'evaluationMethodDisplay', 'evaluationProgressDisplay', 'authorAbstentionDisplay', 'evaluationBenefitDisplay']) same(name, version)
      same('versionChangeSummary', project, version)
      same('retryRelations', project, version)
    }
    for (const record of [{ text: '移动端首屏的按钮与标题重叠。需要调整间距。' }, { status: 'withdrawn', text: 'x' }, {}]) same('observationSummary', record)
    same('observationSummary', { action: 'wait' }, { kind: 'decision' })
  })
  it('observation source projection is identical', () => {
    for (const source of [{}, { id: 'ws', status: 'watching', enabled: true, stats: { received: 3 }, recent: [{ at: 'bad', kind: 'change', summary: 'a' }] }, { enabled: false }, { status: 'root_changed', label: 'x'.repeat(200) }]) {
      expect(JSON.stringify(webSource.observationSourceDisplay(source))).toBe(JSON.stringify(hostSource.observationSourceDisplay(source)))
    }
  })
  it('maintenance projections are identical', () => {
    const operations = [null, { kind: 'backup', phase: 'completed', status: 'completed', summary: 'ok' }, { kind: 'apply', phase: 'running', status: 'running', cancellable: true, questionHandoff: { capability: 'supported', suspended: [1], blocked: [] } }, { kind: 'restore', status: 'failed', attempts: [{ status: 'failed', code: 'E' }] }]
    for (const operation of operations) {
      for (const name of ['maintenanceOperationDisplay', 'maintenanceTerminal', 'maintenanceCancellable', 'formatMaintenanceAttemptHistory', 'maintenanceQuestionHandoffDisplay']) {
        expect(JSON.stringify(webMaintenance[name](operation)), name).toBe(JSON.stringify(hostMaintenance[name](operation)))
      }
    }
  })
})
