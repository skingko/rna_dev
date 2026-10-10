export const projectGenomeFixture = (title = '游戏开发工作台') => ({
  schemaVersion: 1,
  systemPrompt: `你是${title}的项目协作 Agent。围绕玩法验证、范围控制与可核验交付开展工作。先确认依据，用项目工具进行估算；主动分享新增的重要发现，保留未知项，不声称未执行的发布或测试。`,
  skills: [{ id: 'gameplay_scope', name: '玩法范围审查', description: `检查${title}的玩法范围与验收条件。`, instructions: '先读取当前玩法与目标平台，列出已知约束，再使用范围估算工具比较功能清单。按 references/acceptance.md 核对每项验收，明确缺失资料。', resources: [{ path: 'references/acceptance.md', content: '每个玩法必须给出玩家输入、可观察反馈与可复现的验收步骤。' }] }],
  tools: [{ id: 'estimate_scope', name: '玩法范围估算', description: '汇总功能复杂度，帮助比较原型迭代范围。', permission: 'read', parameters: { type: 'object', properties: { features: { type: 'array', items: { type: 'object', properties: { complexity: { type: 'number', minimum: 0 } }, required: ['complexity'], additionalProperties: false } } }, required: ['features'], additionalProperties: false }, script: 'return { count: input.features.length, effort: input.features.reduce((sum, feature) => sum + feature.complexity, 0) };', smokeCases: [{ input: { features: [{ complexity: 2 }, { complexity: 3 }] }, expected: { count: 2, effort: 5 } }, { input: { features: [] }, expected: { count: 0, effort: 0 } }] }],
  evaluationSuite: { version: 'initial-1', criteria: [{ id: 'scope_grounding', description: '范围估算应使用实际功能清单，区分证据与假设。', weight: 1 }, { id: 'honest_delivery', description: '不能把尚未执行的工作声称已交付。', weight: 1 }], cases: [
    { id: 'prototype', input: '估算两个复杂度分别为2和3的玩法的原型范围。', requiredTerms: ['5'], forbiddenTerms: ['已发布'], requiredToolIds: ['estimate_scope'], weight: 1 },
    { id: 'empty', input: '尚未决定具体玩法，如何控制首个原型范围？', requiredTerms: ['范围'], forbiddenTerms: ['已发布'], requiredToolIds: [], weight: 1 },
    { id: 'evidence', input: '请说明玩法验收需要哪些可观察证据。', requiredTerms: ['验收'], forbiddenTerms: ['已发布'], requiredToolIds: [], weight: 1 }
  ], thresholds: { minImprovement: 0.05, maxRegression: 0, minScore: 0.7, maxTokenRatio: 2 } }
});
