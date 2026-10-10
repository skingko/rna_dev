import { createProjectEvaluationExposurePlan, observeProjectEvaluationExposure, summarizeProjectEvaluationExposure, type ProjectEvaluationExposureStatus } from '../src/project-evaluation-exposure.js';
import type { ProjectGenome } from '@rna-agent/sdk';
declare const baseline: ProjectGenome, candidate: ProjectGenome;
const plan = createProjectEvaluationExposurePlan({ baseline, candidate });
const receipt = { toolName: 'skill_load', toolCallId: 'load-1', isError: false, output: '{}' };
const exposure = observeProjectEvaluationExposure({ plan, genome: candidate, side: 'candidate', contextExposed: true, receiptsComplete: true,
  execution: { calls: [{ id: 'load-1', name: 'skill_load', arguments: { id: 'review' } }], toolResults: [receipt], submittedToolResults: [receipt] } });
const summary = summarizeProjectEvaluationExposure({ plan, cases: [{ id: 'first', candidate: { exposure } }], expectedCaseIds: ['first', 'second'] });
const status: ProjectEvaluationExposureStatus = summary.candidate.changes[0].status;
const observed: number = exposure.counts.observed;
const causal: 'none' = summary.causalClaim;
void [status, observed, causal];
// @ts-expect-error a model string is not a host context attestation
observeProjectEvaluationExposure({ plan, genome: candidate, side: 'candidate', contextExposed: 'true' });
// @ts-expect-error frozen plan identities are immutable
plan.planHash = 'replacement';
// @ts-expect-error exposure is not a quality score
const score = exposure.score;
void score;
