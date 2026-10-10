export function projectGenomeFixture({ candidate = false } = {}) {
  return {
    schemaVersion: 1,
    systemPrompt: candidate ? 'CANDIDATE_AGENT: use evidence_helper for each question, provide precise evidence and a useful conclusion.' : 'BASELINE_AGENT: use evidence_helper for each question, give a brief preliminary answer.',
    skills: [{ id: 'evidence_review', name: 'Evidence review', description: 'Verify current project evidence', instructions: candidate ? 'Read relevant evidence, invoke the helper, and connect results to the decision.' : 'Invoke the helper to inspect evidence.', resources: [{ path: 'references/guide.md', content: 'Project evidence requires a checked helper result.' }] }],
    tools: [{ id: 'evidence_helper', name: 'Evidence helper', description: 'Calculate project evidence deterministically', permission: 'read', parameters: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false }, script: candidate ? 'const doubled = input.value * 2; return { doubled };' : 'return { doubled: input.value * 2 };', smokeCases: [{ input: { value: 2 }, expected: { doubled: 4 } }] }],
    evaluationSuite: { version: candidate ? 'proposed-v2' : 'frozen-v1', criteria: [{ id: 'evidence', description: 'Answer grounded in the actually executed helper with an actionable conclusion.', weight: 1 }], cases: [1, 2, 3].map(value => ({ id: `case_${value}`, input: `Check project input ${value} using the evidence helper.`, requiredTerms: ['evidence'], forbiddenTerms: ['fabricated'], requiredToolIds: ['evidence_helper'], weight: 1 })), thresholds: { minImprovement: 0.1, maxRegression: 0, minScore: 0.7, maxTokenRatio: 2 } }
  };
}

export const diagnosisFixture = () => ({ cause: 'skill_method', evidenceIds: [], explanation: 'Observed answers stop at a helper result without applying it.', intervention: 'Teach interpretation and a bounded verification procedure.', validationPlan: 'Compare actual task outcomes against the frozen suite.', limitations: ['The model-authored suite is limited evidence.'] });

/** Fixture provider still runs the SDK tool loop and real generated child code. */
export function genomeEvaluationProvider({ candidate = projectGenomeFixture({ candidate: true }), calls = [], badCandidate = false, failJudge = false } = {}) {
  return async function* (request) {
    calls.push(request); const prompt = request.systemPrompt;
    if (prompt.includes('Create one improved executable project agent')) {
      yield { type: 'text_delta', delta: JSON.stringify({ summary: 'Evidence-based project revision', hypothesis: 'Explicit evidence interpretation improves task usefulness', diagnosis: diagnosisFixture(), changes: ['Refine system behavior, skill instructions, and automation implementation'], genome: candidate }) };
    } else if (prompt.includes('blind evaluator')) {
      const input = JSON.parse(request.messages[0].content[0].text);
      const ratings = { ratings: failJudge ? [] : input.criteria.map(criterion => ({ criterionId: criterion.id, left: input.left.answer.includes('precise') ? .9 : .5, right: input.right.answer.includes('precise') ? .9 : .5, reason: 'The precise response ties a real helper result to an explicit conclusion.' })) };
      if (request.tools?.[0]?.name === 'submit_evaluation_ratings') {
        yield { type: 'tool_call', id: `ratings-${calls.length}`, name: request.tools[0].name, arguments: ratings };
        yield { type: 'usage', usage: { input: 20, output: 10, totalTokens: 30 } }; yield { type: 'done', stopReason: 'toolUse' }; return;
      }
      yield { type: 'text_delta', delta: JSON.stringify(ratings) };
    } else if (!request.messages.some(message => message.role === 'toolResult')) {
      yield { type: 'tool_call', id: `helper-${calls.length}`, name: 'evidence_helper', arguments: { value: 2 } };
      yield { type: 'usage', usage: { input: 20, output: 10, totalTokens: 30 } }; yield { type: 'done', stopReason: 'toolUse' }; return;
    } else {
      const answer = prompt.includes('CANDIDATE_AGENT') ? badCandidate ? 'fabricated precise evidence' : 'precise evidence: the helper returned 4; use the checked result for the next project decision.' : 'preliminary evidence: the helper returned 4.';
      yield { type: 'text_delta', delta: answer };
    }
    yield { type: 'usage', usage: { input: 20, output: 10, totalTokens: 30 } }; yield { type: 'done', stopReason: 'stop' };
  };
}
