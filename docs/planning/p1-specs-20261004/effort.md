# Spec: internal calls stop inheriting the chat's `max` (user decision 2), plus accounting fixes

Scope: TC-7 and TC-8 (token-background), PDL-3/TC-6 (aborted decisions), TC-10/EVO-11 (purposes). Everything below was read from main @ cd6a9d0 (app 0.64.0, SDK 0.51.0). Live data comes from a copy of `.state/state.json.usage-cache.jsonl` (8,471 rows, 2026-09-28T05:44 → 10-04T08:36), copies of the journals, failure archive and sdkState shards, and read-only GETs on :4317. No main-model call was made.

---------------------------------------------------------------------
## 0. Summary

1. **On GLM the provider default is max, so "use the default" saves nothing there.** The GLM-5.3 docs table reads `reasoning_effort | low, high, max | default max`. The Coding Plan page says that an unset/enabled/adaptive `thinking.type` "defaults to max effort". So on the user's real endpoint, JEV has to pick the effort per call. "Use the default" is the free path only where the default adapts on its own or sits below the top level: Anthropic adaptive (Opus 5.5 defaults to `medium`), DeepSeek (`high`), Codex (the discovered `default_reasoning_level`: medium, or low for the -sol models), and toggle models.
2. **Effort is the cost lever; the output cap is not.** Providers bill the tokens actually produced. GLM shares `max_tokens` between reasoning and answer, so a lower cap at high effort truncates. The 2026-09-26 output-budget audit (`docs/research/phase-output-budget-audit-20261926.md`) made the user's configured allowance authoritative. Caps therefore stay at the configured allowance for main-model purposes. The cap only feeds admission reservations and the abort over-charge, and PDL-3 fixes the over-charge. What this spec adds instead is a guard on `length` finishes: raise the cap toward the configured allowance where a lower one was used, otherwise lower the effort by one step for the retry.
3. **The premise that decision failures came from truncation is false for current data.** In the failure archive (09-24 → 10-02), all 139 `invalid_decision` and 6 `message_contract` failures have `stopReason: 'stop'`. Causes: 95 unknown evidence citations, 19 invalid JSON, 13 missing evidence or content, 9 schema field errors, 3 rhythm citations. 7-day decision truncations: 0. The real truncations (output = 32,768) happened only at `max` effort: background-work ×2 (09-30), initialization ×2 of 20 (09-28), step-limit summary ×1 (09-28). Two more background rows at 31.9K and 32.4K are long chapter writes, bounded by content, not reasoning. **Risk to watch: lower effort may raise unknown-evidence citations.** Stage B must measure that specifically.

---------------------------------------------------------------------
## 1. Live baseline (7-day ledger copy, glm-5.3 unless noted)

| purpose (attribution recomputed) | rows | zero/unreported | output p50 / p90 / p99 / max | Σ output | Σ input (uncached) | Σ cacheRead |
|---|---|---|---|---|---|---|
| initiative decision (prefixKey = sha of `initiative:<pid>`, `rna-initiative-v1`) | 615 | 96 | 6,218 / 11,638 / 18,331 / 26,726 | 3,567,412 | 15,848,278 | 6,029,504 |
| narrator (prefixKey `narrator:<pid>`, `rna-narrator-v2`; logged as 'initiative') | 10 | 0 | 6,327 / 10,804 / – / 15,460 | 73,226 | 23,244 | 320 |
| background-work | 2,906 | 19 | 417 / 3,774 / 15,629 / 32,768 | 4,269,379 | 12,949,242 | 256,134,784 |
| other (= mind-* / gene-* / session-suggestions; modelJson already at the lowest effort) | 206 | 0 | 106 / 680 / 1,523 / 1,848 | 44,809 | 171,098 | 40,192 |
| initialization | 20 (+7 other models) | 0 | 9,137 / 13,802 / 32,768 | 166,752 | – | – |
| summary (step-limit) | 5 (+1 codex) | 0 | 1,520 / 32,768 | 39,181 | 560,311 | 0 |
| subagent | 25 (gpt-6.1-sol, already `default`) | 0 | 95 / 357 / 2,504 | 7,321 | – | – |
| compaction | 4 (glm 6,858; flash 6,793; codex 3,172–3,407) | 0 | – | 20K | – | – |
| evaluation (frozen suites) | 16 | 0 | 2,944 / 4,096 / 5,196 | 44,208 | – | – (5 rows sit at the 4,096 cap; see the open questions) |

- **Decisions are about 90% reasoning.** Archived decision objects (243 across projects) are 402 chars at the median and 815 at p90; 145 of 243 are `wait`. So ≈3.3M of the 3.57M decision output tokens are reasoning.
- **Decision latency** (last 50 wakes): novel median 117 s (p90 166 s); AI project median 47 s (p90 85 s). Novel `failureRate` 0.08 (3 message_contract, 1 invalid_decision); this is the baseline accuracy.
- **Background runs** (journals, 203 runs on glm-5.3 max): steps p50 9 / p90 45. First-step output p50 858 / p90 5,612. Run total p50 19.2K / p90 51.6K. Thinking is replayed as `reasoning_content` on the next step (`packages/sdk/src/providers.mjs:94`). In run 45c25133, step 2 had 11,293 uncached input, of which ≈9.9K was replayed reasoning.
- **Accounting (sdkState shard copies):**
  - novel: usedTokens 158.0M, of which estimatedTokens 15.1M (9.6%)
  - 3d: 130.3M / 3.7M
  - test 6132c1bb: 2.28M / 0.56M (24%)
  - Each aborted decision is charged the reserve: UTF-8 bytes + 32,768 + 512, about 111K on the test project. A paid decision averages 42.2K input+cacheRead.
  - The ledger has 96 zero rows for initiative in 7 days (15.6% of started decisions) and 19 for background-work.

---------------------------------------------------------------------
## 2. What "default" means per provider/model (current registry)

Wire semantics: `buildRequest`, `packages/sdk/src/providers.mjs:181–222`; Codex `subscription-provider.mjs:62–67`. Capability resolution: `prototypes/control-center/reasoning-capability.mjs:42–50`, presets in `provider-presets.mjs`.

| Model (live config in bold) | control / efforts | What `'default'` sends | Provider default | Default usable? | Internal policy |
|---|---|---|---|---|---|
| **glm-5.3, glm-5.3-flash** (Coding Plan `open.bigmodel.cn/api/coding/paas/v4`, zai format) | effort low/high/max, cannot disable | `thinking:{type:'enabled'}`, `reasoning_effort` omitted | **max** (docs table; Coding Plan: unset thinking → max) | No: the default is the deepest level | JEV route over [low, high, max] ≤ chat ceiling |
| **glm-5.3-flashx** (no preset match; capability `none`) | none | nothing | – | n/a | fixed, nothing to choose |
| **deepseek-v4-pro / flash** | effort high/max, can disable | thinking enabled, effort omitted | high (preset) | Yes (not the top) | `'default'` (or the chat's `off` if chosen) |
| **openai-codex** (ChatGPT subscription) | effort low…max (discovered) | `reasoning:{summary:'auto'}`, no effort; **sends no max_output_tokens at all** | medium (gpt-6-astra, 5.6-terra/luna, 5.5, 6-sol, 6-luna); low (gpt-5.6-sol, gpt-6.1-sol) | Yes | `'default'` |
| OpenAI API gpt-5.4 | effort low…xhigh, can disable | effort omitted | unknown (null) | No | JEV route |
| Anthropic claude-opus-5-5 (API key only) | adaptive low…max, cannot disable | `thinking:{type:'adaptive'}`, no `output_config` | medium (Anthropic docs) | Yes (adaptive) | `'default'` |
| Anthropic claude-sonnet-5 | adaptive | adaptive | high | Yes (adaptive) | `'default'` |
| Anthropic claude-haiku-4-5 | budget low/medium/high, can disable | no `thinking` field, so thinking is OFF | off | No (the default disables thinking) | JEV route over [low, medium, high] |
| Kimi K3 | effort low/high/max | effort omitted | unknown | No | JEV route. kimi-coding is `interactive_only`, so it is never used for internal calls. |
| Qwen 3.8 / MiMo | toggle (one "on" level) | thinking on | on | Yes | `'default'` |
| Gemini 2.5 flash | effort low/medium/high | omitted | unknown | No | JEV route |

The rule is code in a new module, `prototypes/control-center/internal-reasoning.mjs`:

```js
export function defaultUsable(cap) {
  if (!cap || ['none', 'toggle', 'adaptive'].includes(cap.control)) return true;
  if (cap.control === 'effort') return Boolean(cap.providerDefault) && cap.providerDefault !== cap.efforts.at(-1)?.id;
  return false; // 'budget': omitting thinking turns it off
}
```

**Preset truthfulness.** Optional, see the open questions. In `provider-presets.mjs:27`, set `providerDefault: 'max'` for glm-5.3/-flash/-flashx (source glmSource, checkedAt 2026-10-04). The UI would then read "由供应商决定（通常为最大）". The internal logic does not depend on it: an `effort` control with a null `providerDefault` already routes. Side effect: `reasoning-routing.mjs:36` would move GLM `auto` + plan mode from high to max.

---------------------------------------------------------------------
## 3. Design

### 3.1 Effort plan (pure; `internal-reasoning.mjs`, new)

```js
internalReasoningPlan(model, { setting = 'auto', projectSelection = null })
  → { mode: 'fixed', effort, source } | { mode: 'route', allowed: string[], fallback, ceiling }
```

1. `setting === 'chat'`: return `{ fixed, effort: model.reasoning, source: 'setting' }`. This is today's behaviour, the user's opt-out.
2. `projectSelection` (`project.initiative.modelSelection.reasoning`) is an explicit effort id: `{ fixed, effort, source: 'project' }`. A user who set a background effort for the project keeps it. Live: null for every project.
3. Ceiling C, taken from the chat selection `model.reasoningSelection ?? model.reasoning`:
   - `'off'` → off
   - an effort id → that id
   - `'default'` with a known `providerDefault` → providerDefault
   - otherwise the top effort

   Internal calls never think harder than the user's chat choice.
4. If C is off, or there are no efforts: fixed (`wireReasoning(selection)`).
5. If `defaultUsable(cap)`:
   - `providerDefault` known and ranked above C → fixed C, source `'chat-ceiling'`
   - else fixed `'default'`, source `'provider-default'`
6. `allowed` = efforts ranked ≤ C. Fewer than 2 → fixed `allowed[0]`. Otherwise `{ route, allowed, fallback: model.reasoning, ceiling: C }`.

`fallback` is exactly today's wire value: `max` on live GLM.

Mapping (`effortForDepth(depth, plan, cap)`):
- light → `allowed[0]`
- standard → `allowed.length <= 2 ? allowed.at(-1) : allowed[floor((len-1)/2)]`, preferring `cap.providerDefault` when it is in `allowed` and is not the top
- deep → `allowed.at(-1)`
- unknown / null → `plan.fallback`

Live GLM chat `max`: light→low, standard→high, deep→max, fallback max. gpt-5.4: low / medium / xhigh. Haiku: low / medium / high.

**The coordinator's model object is never mutated.** `scope()` hashes `model.reasoning` (`project-initiative-controller.mjs:233`), and the P0 scope split is reworking that hash. Effort is applied per request only.

### 3.2 Purpose table

| purpose | call site (current code) | policy | cadence |
|---|---|---|---|
| initiative decision | SDK `decideInitiative` via `InitiativeCoordinator.tick` (`packages/sdk/src/initiative.mjs:300–371`, `:745–873`); host coordinator `project-initiative-controller.mjs:762–765` | route, point `effort.decision` | per decision; repair attempts escalate to fallback |
| background-work | `work()` `project-initiative-controller.mjs:2257–2344` (`model` at :2290) | route, `effort.work` (origin `background`) | once per run, stored on the job, reused on checkpoint resume |
| subagent | `builtin-agent-service.mjs:347` (`model: turn.modelConfig`) | route, `effort.work` (origin `delegated`) | once per child, stored on the record |
| narrator rewrite | `reviseMessage` `project-initiative-controller.mjs:1171–1185` | route, `effort.narrator` | per rewrite |
| initialization / skill-foundation | `project-initializer.mjs:127–147`, `:106` | route, `effort.setup` (phase 2) | once per run |
| compaction (fg and bg) | SDK `generateCompaction` `session.mjs:521–545` | route, `effort.compaction` (phase 2) via the new SDK hook `sideReasoning` | per compaction request |
| step-limit summary | `session.mjs:753` (uses `selected`) | inherits the run's effort (the run is routed; TC-5 needs byte-identical params later). On `length`, one retry at the lightest level. | – |
| mind-*, gene-*, session-suggestions (modelJson) | `project-mind.mjs:775–796`; `gene-evolution-service.mjs:401, 500, 820, 889`; `session-suggestions.mjs:116` | unchanged: `llmJudgeReasoning` = lowest level (`low` on glm), not `max`. Add the `length` cap guard (§3.5). | – |
| jev-llm, vision | `decision-llm-judge.mjs:20`, `vision-service.mjs:68` | unchanged, lowest | – |
| evaluation | frozen suites | **excluded**: evaluation integrity (baseline and candidate must run identically; runtime hash) | – |
| learning (legacy) | `project-learning-controller.mjs:61` | excluded: off live (`independentLearning`) | – |
| memory summaries | OpenViking's own model (`memory-summary-sync.mjs:55`) | n/a: no Rna main-model call | – |

**Rollout.** Phase 1 activates `effort.decision`, `effort.work` and `effort.narrator` after the probes; these cover over 99% of the output. Phase 2 (`effort.setup`, `effort.compaction`; ≤30 calls/week) is coded now and stays in shadow until its probes. Until a route point is active, the call uses `plan.fallback`, which is today's effort. The `defaultUsable` providers get `'default'` immediately, with no JEV.

### 3.3 JEV points `effort.*`

**Not a reuse of `turn.route.reasoning_effort`.** Reasons:
- It is phrased around "the user message in `turn.message`".
- Its options are model effort ids with degree-style criteria (`effortText`, `decision-templates.mjs:140–142`). AGENTS.md measured that situation-style levels hit and degree-style levels overshot.
- Internal calls need a model-independent depth that code clamps to the chat ceiling.

What is reused: kernel transport, `stakeThreshold`, `record()`, the shadow mechanism, the probe endpoint, and the decision/turn record shape (`reasoningDecision`). The keyword rules in `reasoning-routing.mjs` (CAREFUL/GREETING) must not be reused.

Points (one per purpose family, so modes, thresholds and calibration stay per purpose):
- `effort.decision`
- `effort.work`
- `effort.narrator`
- `effort.setup`
- `effort.compaction`

Registry changes:
- `decision-service.mjs:19` `points`
- `DECISION_POINT_INFO` (:21): title zh, `stake: 'medium'`, `effect: 'choose the reasoning effort of an internal model call from the task (never above the chat level); unknown keeps today's effort'`
- `shadowPoints` (:77): all five, at first
- `decision-kernel.mjs:12` `POINTS`, `:17` `UNGATED`, `:22` `TEMPLATE_POINTS`
- default `maxStateChars` 8000 is enough (worst case ≈5.9K)
- `decision-state.mjs:74` `DECISION_STATE_ROOTS['effort.*'] = ['call', 'project']`
- `UNTRUSTED_STATE_PATHS` add `'call.task', 'call.evidence', 'call.message', 'call.request'`
- `decision-templates.mjs` `TEMPLATE_SPECS['effort.<p>'] = { version: 1, criteriaMax: 600, required: ['depth'], questions: [['depth', 'choice', { keys: ['light', 'standard', 'deep', 'unknown'] }]] }`
- `DECISION_THRESHOLDS.points['effort.<p>'] = { light: 'high', standard: 'medium' }`. These are **provisional; replace them from the probe distribution.**

Template (`effortTemplate(purpose)`, `EFFORT_TEMPLATE_VERSION = 1`; one choice question `depth`). Instructions:

"How much reasoning does the model call described in `call` need to produce a correct result? `call.facts` were computed by code. Options are ordered from least to most reasoning; each describes a situation. Choose unknown when the situation cannot be told from `call`." + DATA

Initial criteria (situations, no numbers; iterate wording on the probe as `jev-work-coverage-probe-20261004.md` did):
- **decision**
  - light: Nothing new asks for action. The items in `call.evidence` report work that is already finished or already reported, no user request is pending, nothing failed, and `call.facts` asks for no plan, schedule, judgment options or rhythm assessment. The likely answer is to wait or to pass on a finished result.
  - standard: Something new must be weighed (a finished result, a user message, a change in project files) and one ordinary next step chosen: wait, one message, one question or one bounded piece of work. `call.facts` asks for no plan, schedule, judgment options or rhythm assessment, and nothing failed.
  - deep: `call.facts` asks for a plan, schedule, judgment options or rhythm assessment to be written or revised, or for a failure to be reviewed. Or the evidence conflicts. Or a user request is pending and the agent must decide how to continue it.
- **work**
  - light: The task in `call.task` only reads, searches, checks or reports on named files or results, and asks for no writing, editing or design choice.
  - standard: The task asks for a change or deliverable whose content it already specifies: a described fix, a listed set of edits, a routine report in an existing format.
  - deep: The task asks for writing or design whose content is open: a new chapter or section, a change across several files, finding the cause of a failure, research that weighs sources against each other.
- **narrator**
  - light: Every problem in `call.facts.flagged` can be fixed by deleting or rewording sentences of `call.message`, keeping its facts.
  - standard: The message must be reordered or condensed to open with the delivered result, using only what `call.message` contains.
  - deep: Fixing it needs a judgment about which facts matter to the user or what the user should decide.
- **setup**
  - light: The project folder already holds working material and `call.task` mostly asks to record it.
  - standard: One conventional deliverable and a familiar method, so the first plan follows from the description.
  - deep: The goal, deliverables or method must be designed, or existing work in `call.facts` must be migrated consistently.
- **compaction**
  - light: `call.facts.historyAmount` is small and the exchanges are routine with nothing in progress.
  - standard: The history holds ongoing work whose decisions and open items must be kept.
  - deep: The history holds long creative or design work whose details must stay consistent (names, plot, style rules, architecture decisions, many open problems).

State builder branch in `buildDecisionState` (`decision-state.mjs:133`):

```js
state.call = {
  purpose,
  facts,                  // ≤16 keys, values limited to 'yes'|'no', countBucket(), recencyBucket(), short enum words
  task?: clip(1200),
  evidence?: last six items, each clip(300),
  message?: clip(1600),
  request?: clip(600),
};
state.project = { title: clip(120), kind: taskTypes.slice(0, 4) };
```

Facts, all code-computed (AGENTS.md: amounts as buckets):
- **decision** (built from the tick hook input plus the project):
  - `wakeSources`: words for the event types sent (conversation result, user message, background result, background failure, scheduled run due, project files changed, schedule changed, or none for a floor tick)
  - `newEvidence`: countBucket of events not cited by the last decision
  - `pendingRequests` / `overdueRequests`: countBuckets from the mind's open commitments, the same source as the gate's `openWork` (`decision-service.mjs:615`)
  - `failureToReview`: pendingFailureReview, or an action-failed event
  - `planOrOptionsToWrite`: `actionContracts.judgment.enabled`
  - `rhythmToAssess`: `actionContracts.rhythm.requiresAssessment`
  - `previousProposalNotAdmitted`
  - `openActions`: countBucket of queued/running/paused/needs_review
  - `call.evidence`: the newest six event summaries
- **work**:
  - `origin`: background | delegated
  - `scheduled`
  - `writable`
  - `isolated`
  - `resumes`
  - `earlierAttemptFailed`
  - `handoffAvailable`
  - `call.task`: action.content, or the delegation task
- **narrator**:
  - `flagged`: violation codes as words
  - `scheduled`
  - `deliverable` title
  - `call.message`
- **setup**:
  - `migration`
  - `existingFiles` bucket
  - `hasCode`
  - `call.task`: the description
- **compaction**:
  - `historyAmount`: small / medium / large / very large, from code token buckets
  - `toolResults` bucket
  - `manual`
  - `call.request`: the latest user request

Combine (new `combineEffortDepth(answers, { backend, point })`, cumulative and asymmetric, because under-routing risks accuracy and over-routing only costs tokens):

```js
const p = answers.depth?.probabilities;
if (!p || argmax(p) === 'unknown') return null;
if ((p.light ?? 0) >= stakeThreshold(t.light, backend)) return 'light';
if ((p.light ?? 0) + (p.standard ?? 0) >= stakeThreshold(t.standard, backend)) return 'standard';
return 'deep';
```

The llm backend gets `llmOffset` through `stakeThreshold`.

Service method `DecisionService.internalEffort(project, { purpose, plan, facts, signal })`, modelled on `workCoverage` (:859):
1. Off → null.
2. Shadow with `settings.realTokenBudget != null` → null (the same rule as `turn.settled`).
3. `buildDecisionState`, then `decide({ point, state, signals: { consequence: .6 }, scope: { projectId, revision: hash([point, state]) }, assessmentPlan: effortTemplate(purpose), fallback: {}, signal })`.
4. `depth = combineEffortDepth`; `effort = effortForDepth`.
5. `record(result, { projectId }, 'effort', null, { purpose, depth, effort, applied: active(result) && !!effort }, { predictions, decided: !!depth })`.
6. Return `{ effort, depth, ledgerId }` only when active; otherwise `{ ledgerId, shadow: { depth, effort } }` and the caller uses `plan.fallback`.

Calibration label (new `labelEffort(ledgerId, 'adequate'|'inadequate')`):
- decision: valid with no repair → adequate; repaired, invalid_decision, message_contract or failed → inadequate
- work: completed with a handoff and the change set kept → adequate; needs_review, failed or a length stop → inadequate
- narrator: recheck passes → adequate

These labels come from outcomes, not from the next model choice (unlike PDL-7).

### 3.4 Wiring per call site

**Decisions (SDK, `packages/sdk/src/initiative.mjs`).**

New `InitiativeCoordinator` option `decisionReasoning(input) → Promise<{ reasoning, record? } | undefined>`:
- validated at :446 like `workCoverage`
- `input = { events, availableActions, project, recentActions, previousDecision, failureReview: Boolean(pendingFailureReview), presence, signal }`, all cloned
- called in `tick()` after `_emit('initiative_decision_started')` (:810), before `decideInitiative` (:814), inside the same try
- an abort or new evidence during the hook returns `stale` with `usage {totalTokens: 0}`; nothing was dispatched, so nothing is charged
- an invalid value or a throw is treated as undefined, which means today's `model.reasoning`

`decideInitiative` (:300) gains `reasoning` and `reasoningRecord`:
- per attempt, `attemptReasoning = (attempt === 1 && !messageRepairs) ? (reasoning ?? model.reasoning) : model.reasoning`, so repairs run at the fallback effort
- request at :331: `request.reasoning = attemptReasoning`. The failure archive then carries the effort, giving the invalid_decision rate per effort.
- iterateCompletion (:332):
  - `model: { ...model, reasoning: attemptReasoning, maxOutputTokens }`, cap unchanged
  - `estimatedInputTokens: ceil(bytes(system + text + repair messages) / 3)`
  - `purposeDetail: attempt === 1 && !messageRepairs ? 'decision' : 'decision-repair'`
  - own-prefix cache `prefixHash: 'rna-initiative-v1:' + promptStats.systemHash`, which also fixes TC-10's constant key. prefixHash only feeds the ledger prefixKey; `prompt_cache_key` uses sessionKey.
- `length` at :341: if `attemptReasoning` ranks below `model.reasoning`, retry the same messages at `model.reasoning` **without pushing the truncated output** (this consumes the repair attempt). Otherwise keep today's behaviour.
- outcome gains `reasoning: { effective, routed: reasoning ?? null, configured: model.reasoning, ...reasoningRecord }`
- `tick` puts that on `lastDecision`, on the `initiative_decision` event, and on the returned result

Host side (`project-initiative-controller.mjs:762`), pass:

```js
decisionReasoning: input => this.internalReasoning(context, 'decision', input)
```

`internalReasoning(context, purpose, input)`:
1. `plan = internalReasoningPlan(context.coordinator.model, { setting: configuration.internalReasoning, projectSelection })`
2. Fixed → return it.
3. Route → `decisions.internalEffort(project, { purpose, plan, facts: builders[purpose](project, input) })`, returning `{ reasoning: verdict?.effort ?? plan.fallback, record: { source: verdict?.effort ? 'jev' : 'fallback', depth, ledgerId } }`.
4. With `RNA_EFFORT_PROBE_CAPTURE=1`, append `{ at, purpose, state, plan, verdict }`, plus for decisions `{ system, text, sent: { events, recentActions, project } }`, to `${store.file}.rna/probe/effort-<purpose>.jsonl`:
   - mode 600
   - keep the last 500 rows per purpose, 14-day retention
   - the `.rna` root is already in the background `deniedPaths` (:2293)
   - **never** written to the ledger

**Background-work** (`work()`):
- At :2290, if `action.checkpoint && job.reasoning`, reuse `job.reasoning.effort` (no JEV call).
- Else start `effortPromise = this.internalReasoning(context, 'work', { action, isolated, writable, ... })` right away. It runs in parallel with `recallProjectMemory` (:2334).
- Persist `job.reasoning = { effort, source, depth?, ledgerId? }` via `recordJobUsage`-style mutate.
- In the run's `beforeRequest` (:2298), on the first call only, `await` the promise and return `{ reasoning }`. `session.mjs:729` already supports this. It also sets `selected.reasoning` for the run's compaction and step-limit summary.
- No added latency, because recall runs first.

**Subagents** (`builtin-agent-service.mjs:315/347`):
- Start `this.internalReasoning`-equivalent: the service gets `decisions` and a `reasoningFor(project, purpose, input)` helper injected from `server.mjs`, exported by `internal-reasoning.mjs`.
- Route through the child's `beforeRequest` (first call, `withBudget` from `reasoning-routing.mjs:42` at `ROUTE_BUDGET_MS`). The fallback is the turn's own `modelConfig.reasoning`.
- Store `record.reasoning`. `agent_message` continuations reuse it.

**Narrator** (`reviseMessage` :1171):
- Purpose `'narrator'`: `purposeProvider(..., 'narrator', ...)`.
- `model: { ...model, reasoning: routed }` from `internalReasoning(context, 'narrator', { text, violations, deliverable })`.
- Track `done.stopReason`. **On `'length'` or empty output, return null** so the original text is kept. Today a truncated revision would be delivered (latent bug).
- After a successful revision, run `checkedMessageViolations` again on the revised text (JEV message.check, cheap) and store `candidate.revision.recheck = codes`. This gives a live pass-rate, as TC-8's corrected fix requires.

**Setup** (`project-initializer.mjs:127/147`, phase 2): `model: { ...model, reasoning: routed, maxOutputTokens: outputLimit }`; `initialization.modelSelection.reasoning` records the effective value.

**Compaction** (phase 2):
- New SDK `createSession` option `sideReasoning({ purpose: 'compaction', automatic, estimatedInputTokens, signal }) → effort | undefined`, called in `generateCompaction` before :539.
- The result applies only to that request (`{ ...clone(selected), reasoning: override, maxOutputTokens }`), never to `selected`.
- `rna-runtime.mjs:303` passes `...options` through, so no runtime change is needed. The host supplies it from `runtime-controller.mjs` (foreground) and from `work()` (background).

### 3.5 Output allowances (right-sizing without truncation)

Per-purpose decisions (data in §1):
- **Decisions: keep the configured cap** (32,768).
  - Max observed 26,726; 0 truncations. Lower effort shrinks output anyway.
  - The cap enters only the admission reserve (:801), which stays conservative by design.
  - Its abort charge is removed in §3.6.
- **Narrator: keep the cap, add the stop-reason guard** (§3.4).
- **Background-work and subagent steps: keep the cap.**
  - The 32K hits on 10-02 were content (chapter `project_write` arguments). Effort cannot fix that, and the cap is the user's.
  - A general mid-run step-down was considered and **rejected**: it adds journal complexity, changes cache identity mid-run, and does not help content-bound truncation.
- **Step-limit summary** (`session.mjs:804`): on `stopReason 'length'`, retry once with the lightest level, `llmJudgeReasoning(selected.reasoningCapability)` via a new SDK helper. Same request and tools, journaled as a second `request_started` with `retry: 'output_limit'`. Only then throw `step_limit`. The summary is a report of known facts, so its truncation is reasoning-bound (09-28: 32,768 on a 45.6K input). Not on `anthropic` (preserved thinking; leave to the TC-3 owner).
- **Bootstrap** (`bootstrap.mjs:224`): after a `length` BootstrapError, the next attempt uses `stepDownReasoning(model)` (2/20 initializations truncated at max). `requestModel` becomes per attempt instead of fixed at :111.
- **modelJson** (`project-mind.mjs:775`):
  - Caps 200–3000 with a 2048 floor when thinking is on; max observed 1,848.
  - Today a truncated answer parses to null and is treated as "skip" (EVO-10).
  - Track `done.stopReason`. On `'length'`, retry once with `min(2 × cap, configured maxOutputTokens)` before returning null.
- **Codex: no change possible.** It sends no `max_output_tokens`, so caps are local only.

New SDK module `packages/sdk/src/reasoning-effort.mjs`:
- `effectiveEffort(model)`: `'default'` → providerDefault, else the top effort
- `stepDownReasoning(model)`
- `lightestReasoning(model)` (re-exports `llmJudgeReasoning`)
- `rankEffort`

### 3.6 Accounting (PDL-3 / TC-6, plus the missed background and wake items)

In `decideInitiative`:
- Count streamed bytes of `text_delta` and `thinking_delta` per attempt.
- On any throw after dispatch, set `error.usage = { ...reportedSoFar, estimatedTokens: partial, totalTokens: reportedTotal + partial }`, where `partial = inputEstimate + ceil(streamedBytes / 3)` for the attempt that reported no usage.
- On success without a usage event, set `outcome.usage = estimate` and `outcome.usageEstimated = true`.

In `tick` (:817–826):
- Charge `usageTokens(error.usage)` and add `error.usage.estimatedTokens` to `estimatedTokens`. Keep the `reserve` fallback only when `error.usage` is absent, which now means a throw before dispatch, where the charge is 0.
- At :826, charge `usageTokens(outcome.usage)`, and add it to estimated when `usageEstimated`.
- Every `stale` return carries `usage: { totalTokens, estimatedTokens }`.
- The decided return (:873) carries `usage` and `reasoning`.
- The reservation for admission is unchanged, as the verifier required.
- `save()` (`controller save`, realUsage) needs no change; it follows `usedTokens`.

Background unreported steps (`project-initiative-controller.mjs:2275/2302`): keep `requestEstimate` (input + cap + 1536) for the reservation only. On `usageReported === false`, charge `inputEstimate + ceil(bytes(partial message content) / 3)`. Apply the same rule to the subagent reservation (`builtin-agent-service.mjs:351–354`).

Ledger (`usage-cache-service.mjs:112–126` `meteredProvider`):
- Track `stopReason` from `done` and the streamed bytes.
- Record when `responded || usage || request.signal?.aborted`.
- With no usage, record `usage = { input: request.estimatedInputTokens ?? ceil(bytes(JSON of system + messages) / 3), output: ceil(streamed / 3), cacheRead: 0, cacheWrite: 0, cacheUsageReported: false }`, flags `estimated: true`, `aborted` and `responded: false` when applicable.
- Every SDK caller passes `estimatedInputTokens`:
  - `session.request`: `ctx.estimatedInputTokens`
  - `generateCompaction`: `summaryContext.estimatedInputTokens`
  - `decideInitiative`
  - `modelJson`: its estimate
  - `bootstrap`: estimatedTokens − cap
  - `reviseMessage`: bytes / 3

Wake ledger (`project-initiative-controller.mjs:1064`, :1157; `proactive-pacing.mjs:228`):
- `recordWake` takes `tokens = result.usage?.totalTokens` when finite, so a decision's tokens no longer include concurrent work. Fall back to the usedTokens delta.
- `wakeOutcome` (:146) maps `stale` to `{ outcome: 'interrupted', reason }`.
- `advanceWake('interrupted')` appends a history row with tokens, latency and `reasoning`, and leaves `level`, `ticksAtLevel`, `quietWakes`, `nextAt`, `lastAt` and `lastOutcome` unchanged. The re-pump comes from the new evidence. `lastOutcome` feeds the gate's `lastWake`, which only accepts work/thought/failed/deferred.
- Count `interrupted` in `experience-report.mjs:112` (today an unknown outcome falls into `quiet`) and in `proactive-metrics.mjs:49` `byOutcome`.
- Wake history rows also get `reasoning: { effective, source }`.

### 3.7 Purpose attribution (TC-10 / EVO-11)

- `packages/sdk/src/prompt-layers.mjs:8`: append `'narrator', 'mind', 'evolution'` before `'other'`.
- `normalizePurpose`:
  - exact match → itself
  - `/^mind(-|$)/` or `'session-suggestions'` → `'mind'`
  - `/^gene-/` → `'evolution'`
  - else `'other'`
- New `purposeDetail(raw)`: the raw string when it differs from the normalized one and matches `^[a-z][a-z0-9-]{0,39}$`.
- `usageRecord` (`usage-cache-service.mjs:30`) adds optional:
  - `detail`: `request.purposeDetail` ?? `purposeDetail(purpose)`
  - `reasoning`, validated against `REASONING_VALUES`
  - `reasoningTokens`: from `usage.reasoningTokens`, today dropped
  - `stopReason`: a short known value
  - `outputCap`: `request.model.maxOutputTokens`
  - `estimated`, `aborted`, `responded`
- The narrator is metered as `'narrator'`.
- Old `'other'` rows stay loadable: the constructor filters by `USAGE_PURPOSES`, and 'other' remains.
- Aggregation `bucket` (:77) adds:
  - `output`
  - `reasoningTokens`
  - `lengthStops`
  - `estimated: { requests, input, output }` (estimated rows stay out of `hitRate` because cacheReported is false)
  - `byReasoning: { [effort]: { requests, input, cacheRead, output, reasoningTokens } }`

### 3.8 Setting and UI

- `configuration.internalReasoning: 'auto' | 'chat'`. Absent means `'auto'`; this is the user's decision, so there is no migration write.
- Validated in `ConfigurationService.update` (`configuration.mjs:260`) and exposed in `public()`.
- Web, ModelsSection (`web/src/components/settings/sections/ModelsSection.tsx`): one select, "后台与内部调用的推理强度": 自动（推荐）/ 与对话相同.
  - zh description: 主动决策、后台工作、子任务等：供应商默认能自行调节时用默认，否则由 JEV 按任务难度选择，不超过对话档位
  - en via `t()`: Internal calls (proactive decisions, background work, subtasks…): the provider default when it adapts on its own, otherwise JEV picks per task, never above the chat level
  - interfaceLanguage is respected.
- UsageSection `PURPOSES` (:22) adds `narrator: '消息改写'` and `mind: '项目心智'`; `evolution` already exists.
- `api/types.ts` gets the additive fields.

---------------------------------------------------------------------
## 4. Data and contract changes; migration

- **Ledger rows:** additive optional fields `detail`, `reasoning`, `reasoningTokens`, `stopReason`, `outputCap`, `estimated`, `aborted`, `responded`; new purposes `narrator`, `mind`, `evolution`. No rewrite of old rows. Rows written before the change stay `other`.
- **`GET /api/v2/usage/cache`:** byPurpose buckets gain `output`, `reasoningTokens`, `lengthStops`, `estimated`, `byReasoning`.
- **SDK API (0.52.0):**
  - `InitiativeCoordinator({ decisionReasoning })`
  - `decideInitiative({ reasoning, reasoningRecord })`
  - `tick()` results carry `usage`; `decided` results carry `reasoning`
  - `lastDecision.reasoning`
  - `createSession({ sideReasoning })`
  - provider input fields `estimatedInputTokens` and `purposeDetail`, ignored by `buildRequest`
  - `reasoning-effort.mjs` exports
  - `effortTemplate`, `combineEffortDepth`, `EFFORT_POINTS`
  - `index.d.ts`, `decision-templates.d.ts`, `decision-kernel.d.ts` updated
- **Host state:** `job.reasoning`, delegation `record.reasoning`, `initialization.modelSelection.reasoning` (effective), wake history `outcome: 'interrupted'` and `reasoning`, `candidate.revision.recheck`, `configuration.internalReasoning`.
- **Decision kernel:** five new points (shadow); ledger rows `disposition: 'effort'`, `outcome: { purpose, depth, effort, applied }`.
- **Docs:** `docs/specs/stream-protocol-v2.md`:
  - §4: internal reasoning paragraph
  - §5: purposes and fields
  - §6.1: the new points
  - mind/pacing: `interrupted`
  - changelog entry
- No state migration is needed. sdkState `estimatedTokens` history stays as it is; the change is forward only.

---------------------------------------------------------------------
## 5. Tests

**SDK (`packages/sdk/test/`)**
- `prompt-layers.test.mjs`: new enum (exact array); `normalizePurpose('gene-author') === 'evolution'`, `('mind-capture') === 'mind'`, `('session-suggestions') === 'mind'`, `('response') === 'other'`; `purposeDetail`.
- `decision-templates-valid.test.mjs`: every `effort.*` template passes `validateSpecTemplate` and `lintDecisionTemplate` with no problems (no numbers, roots, untrusted note, escape option).
- New `internal-effort-template.test.mjs`:
  - `combineEffortDepth` cumulative thresholds
  - unknown as argmax → null
  - llm offset
  - `buildDecisionState('effort.decision')` keeps only `call`/`project`, clips to budget, facts restricted to words/buckets
- `initiative.test` (or a new `initiative-reasoning.test.mjs`):
  - the hook is called once per decision with the sent events
  - the provider request's `model.reasoning` equals the routed value while `coordinator.model.reasoning` is unchanged
  - a hook throw or invalid value → configured effort
  - an `invalid_decision` repair and a `message_contract` repair use the configured effort
  - a routed-low `length` → retry at configured without the truncated assistant message
  - `lastDecision`, event and result carry `reasoning`
  - `request.reasoning` appears in `initiativeFailure`
- Accounting test:
  - stream aborted after N thinking bytes with no usage → `usedTokens` += ceil(bytes/3) + ceil(N/3), not the reserve; `estimatedTokens` equal to it; the stale result carries usage
  - abort during the hook → 0 charged
  - success with no usage → estimate, not reserve
  - the budget-admission test still blocks at the reserve
- `session` tests:
  - `sideReasoning` applies to the compaction request only (`selected.reasoning` unchanged afterwards)
  - step-limit summary `length` → one retry at the lightest level, second `length` → `step_limit`
  - not applied on `anthropic`
  - `estimatedInputTokens` passed to the provider input
- `bootstrap` test: a `length` failure → the next attempt's `model.reasoning` is one step lower.
- `reasoning-effort.test.mjs`: `effectiveEffort`, `stepDownReasoning` and `lightestReasoning` across fixtures (GLM, DeepSeek, Opus 5.5, Codex discovered, Haiku).

**Host (`prototypes/control-center/test/`)**
- New `internal-reasoning.test.mjs` (pure), with the plan for every row of the §2 table:
  - GLM chat max → route [low, high, max], fallback max
  - GLM chat low → fixed low
  - chat off → off
  - DeepSeek → default
  - Opus 5.5 → default; chat low on Opus → fixed low (chat ceiling)
  - Codex discovered → default
  - gpt-5.4 → route
  - Haiku → route [low, medium, high]
  - toggle → default
  - none → fixed
  - setting 'chat' → configured
  - explicit project selection → fixed
  - plus the `effortForDepth` table
- `decision-service` tests for `internalEffort`:
  - off → null
  - shadow → ledger row `applied: false`, returns shadow
  - active → mapped effort
  - kernel returns null (budget) → null
  - shadow with `realTokenBudget` set → no call
  - `labelEffort`
- `project-initiative-controller` tests (fake provider capturing requests):
  - decision request `model.reasoning` is routed and `context.scope` is unchanged between two different routed efforts
  - background run: `job.reasoning` persisted; the first request carries the routed effort; checkpoint resume reuses it without a JEV call
  - narrator: ledger row `purpose: 'narrator'`; `done.stopReason: 'length'` keeps the original text with `revision.revised === false`; recheck stored
  - `recordWake` with a concurrent work reporting 90K during the decision → the wake row's tokens equal the decision's own usage
  - stale → `interrupted` row with level/ticks/quietWakes/nextAt/lastOutcome unchanged
- `usage-cache-service.test.mjs`:
  - an aborted unreported request records `estimated:true, aborted:true` with `input = estimatedInputTokens`
  - a request aborted before the first byte is recorded with `responded:false`
  - a local configuration error (not aborted, not responded) is not recorded
  - new fields persisted and reloaded
  - aggregation `byReasoning`, `lengthStops`, `estimated`, `output`; hitRate excludes estimated rows
- `builtin-agent-service`: the child's first request carries the routed effort and `record.reasoning`; JEV timeout → the turn's effort.
- `project-mind`: modelJson `length` → one retry at 2× cap ≤ configured; rows `mind` / `evolution` with `detail`.
- `configuration`: PATCH `internalReasoning` validation; `public()`.
- `experience-report` / `proactive-metrics`: `interrupted` counted and not `quiet`.
- Web: `ux-settings.spec.ts` purposeName for `narrator`/`mind`/`evolution`; ModelsSection select renders zh/en.

**Integration** (host with fake provider and fake JEV backend; `test-support`):
- GLM project, chat `max`, `effort.decision` active via the diagnostic `RNA_JEV_MODES`:
  - a timer wake whose fake JEV says light → request `reasoning: 'low'`, ledger row `reasoning: 'low'`, wake row `reasoning`
  - a wake with the judgment contract enabled, JEV says deep → `max`
  - JEV unavailable → `max`
- An abort mid-decision when a user message arrives → ledger estimated row and sdkState charge equal to the estimate, plus a wake `interrupted` row.
- `GET /api/v2/usage/cache?window=1h` shows `byPurpose.initiative.byReasoning.low`.

---------------------------------------------------------------------
## 6. Probes and rollout (AGENTS.md: a labelled probe before any judgment point ships)

1. **Ship 1: accounting + attribution + plumbing.** All `effort.*` points stay in shadow; the internal setting is `auto`. The `defaultUsable` providers get `'default'` immediately; no live model is affected, since live internal calls are GLM or Codex-default. Optionally set `RNA_EFFORT_PROBE_CAPTURE=1` to collect states.
2. **Stage A (JEV only, cheap).**
   - Labelled sets built from captured states, with labels written from the criteria and the known outcome:
     - `effort.decision` ≥30 (cover every wake source, plan/rhythm wakes and failure reviews)
     - `effort.work` ≥20 (novel chapter writes, read-only checks, scheduled AI reports, plus the 25 recorded subagent tasks)
     - `effort.narrator` ≥10
     - later `effort.setup` ≥6 and `effort.compaction` ≥6
   - Ambiguous items are excluded from scoring.
   - Run through `POST /api/v2/decision-kernel/probe` with the production template and builder, using a new harness `prototypes/control-center/benchmark/internal-effort-probe.mjs` modelled on `jev-capability-probe.mjs`. Set `RNA_STATE` to a **copy** of the state file.
   - Record distributions and wording iterations in `docs/research/jev-internal-effort-probe-2026XXXX.md`.
   - **Thresholds are the lowest that give zero under-routing (labelled deeper, mapped lighter)**, with the margin read from the gap between classes.
3. **Stage B (main model; needs the user's approval; estimate ≈2.5M GLM tokens).** New harness `benchmark/internal-effort-replay.mjs`; it refuses to run without `--approved` and prints the estimate first.
   - **decisions:** 30 captured states at the JEV-chosen effort versus the recorded max decision, plus a 10-state max-vs-max subset as the agreement baseline. Compare:
     - invalid_decision (especially unknown-evidence)
     - message_contract
     - action agreement versus the max-vs-max baseline
     - output and reasoning tokens
     - latency
   - **narrator:** the last flagged deliveries (full text once P0 F1 stores bodies), message.check pass rate on revisions, chosen effort versus max.
   - **work:** about 10 light/standard tasks replayed read-only or in a throwaway isolated worktree that is never applied. Compare completion, handoff, and findings (human read).
   - **Gate:** a class whose failure rate or disagreement exceeds the max baseline maps to deep, i.e. no reduction (plan §3 P1-4: 不准确就不降).
4. **Activate** per point by removing it from `shadowPoints`, in a release. Trial first via `RNA_JEV_MODES=effort.decision=active`.
5. **Monitor and roll back.** Weekly per-effort failure rate from wake history and the failure archive (`request.reasoning`) against the 0.08 baseline. On regression, put the point back in shadow. That is a release or env change, and the fallback is today's behaviour.
6. **Optional TC-7 cache probe** (user-approved, ≈0.2M): the same ~100K GLM prompt at two `reasoning_effort` values, comparing `cached_tokens`. Run it before deciding whether decision effort alternation costs cache.

---------------------------------------------------------------------
## 7. Measuring the benefit afterwards

Rows have top-level `input/cacheRead/output/purpose/modelId/prefixKey` and the new fields. Compare each week against the §1 baseline (09-28 → 10-04).

- **Decision output:** `purpose='initiative' && detail='decision'`, grouped by `reasoning`: count, Σ output, p50, Σ reasoningTokens. Baseline: 519 paid decisions, 3.57M output, p50 6,218, p90 11,638.
- **Repairs:** `detail='decision-repair'` share by effort. Failures by effort: the failure archive `request.reasoning`, plus `/api/v2/experience` `wakes.failureReasons` (baseline novel 0.08).
- **Background:**
  - output and uncached input per run (`sessionId`) by `reasoning`
  - first-step output (baseline p50 858 / p90 5.6K)
  - step-2 uncached input (replayed reasoning)
  - `job.reasoning` × job status / needs_review
- **Narrator:** `purpose='narrator'` output per call (baseline 7.3K over 2.3K input); `revision.recheck` pass rate.
- **Truncations:** rows with `stopReason='length'` per purpose (baseline 5 genuine: 2 background, 2 initialization, 1 summary).
- **Latency:** wake history `latencyMs` by `reasoning` (baseline novel 117 s, AI 47 s).
- **Accounting:**
  - rows `estimated: true` per purpose (previously 96 + 19 + 3 zero rows per week)
  - weekly delta of sdkState `estimatedTokens` per project from shard copies (novel 15.1M cumulative)
  - per-abort charge ≈ input estimate (42K average prompt) instead of the ≈111K+ reserve
- **Attribution:** `other` ≈0 (from 206/week); `mind` + `evolution` ≈206/week with `detail`.
- **JEV cost of the new points:** `purpose='jev'` rows (expected ≈850 calls/week at 3–5K input each, ≈$0.2/week at $0.042/M input).
- **Endpoints:**
  - `GET /api/v2/usage/cache?window=7d` (byPurpose / byReasoning)
  - `GET /api/v2/projects/:id/mind` (`pacing.wake.history[].reasoning`, `interrupted`)
  - `GET /api/v2/experience`
  - `GET /api/decision-kernel/ledger?limit=200` (point `effort.*`: depth, applied, labels)

**Expected savings.** This is illustrative only, because every internal call ran at max, so there is no measured per-level ratio yet. Stage B supplies it.
- Decision reasoning is ≈3.3M per week.
- Assume:
  - 60% of wakes are light (waits are 60% of archived decisions) at a 50–75% reasoning cut for GLM `low`
  - 20% are standard (`high`) at a 20–40% cut
- That gives **≈1.1–1.75M fewer output tokens per week (31–49% of decision output)**, plus shorter decisions (median 117 s on the novel), which mean fewer aborts (15.6% of started decisions).
- Background: with 30–50% of runs light or standard at a 30–60% cut, ≈0.4–1.3M fewer output per week, plus less replayed `reasoning_content` on later steps.
- Narrator: −50–60K per week.
- Truncation waste: up to 5 × 32K per week avoided.
- Accounting: ≈96 × (111K − ~45K) ≈ **6M phantom tokens per week** removed from usedTokens and realUsage. ≈3.5–4M per week of real but previously invisible aborted input becomes visible (flagged as estimated).

---------------------------------------------------------------------
## 8. Risks and guards

- **Accuracy loss at lower effort** (unknown-evidence citations dominate today's failures). Guards:
  - shadow first, then Stages A and B
  - asymmetric cumulative thresholds
  - unknown or abstain → today's effort
  - repairs run at the configured effort
  - per-point rollback
  - outcome-based `labelEffort` for calibration
- **Cache.** Effort is fixed per run or session (background, subagent). Decisions use their own prefix (hit rate 0.27). GLM's effort-in-cache-key behaviour is unknown (TC-7, n=1); measure it from the ledger's `reasoning` (consecutive same-prefixKey rows) or with the optional probe. On Anthropic, a top-level effort change invalidates only the messages cache; internal calls use a constant `'default'` there.
- **Scope rotation.** The coordinator's model is never mutated (scope hash :233). A test asserts the scope is unchanged.
- **Truncation.** No caps are lowered. `length` guards are added (narrator discard, summary lightest retry, bootstrap step-down, modelJson cap escalation, decision retry at configured).
- **JEV latency or outage.** Background calls are not user-facing. Subagents are bounded by `ROUTE_BUDGET_MS` and run in parallel with setup; background runs in parallel with memory recall. The fallback is today's behaviour.
- **Privacy.**
  - Effort states carry user and model text: they are untrusted paths with the DATA note, not stored in the decision ledger (as at :411), and redacted by the kernel.
  - Probe capture is opt-in by env, mode 600, under `${store.file}.rna/probe` (background-denied), with 14-day retention.
- **The user's explicit choice.**
  - The ceiling never exceeds the chat selection.
  - The `chat` setting restores the old behaviour.
  - A project's explicit initiative effort is honoured.
  - Provider interfaces and protocols are untouched: GLM stays OpenAI-compatible, Claude stays on the API key.
- **Metrics semantics change.** `tokensPerWake` drops: decision-only tokens, plus `interrupted` rows. Note this in the changelog so pre/post comparisons use the ledger.

---------------------------------------------------------------------
## 9. Files and partition (no conflicts across implementers)

- **Implementer A: accounting, attribution, ledger** (ship first; it is the measuring stick)
  - `packages/sdk/src/prompt-layers.mjs`
  - `prototypes/control-center/usage-cache-service.mjs`
  - `prototypes/control-center/proactive-pacing.mjs`
  - `prototypes/control-center/experience-report.mjs`
  - `prototypes/control-center/proactive-metrics.mjs`
  - `prototypes/control-center/web/src/components/settings/sections/UsageSection.tsx`
  - `web/src/api/types.ts` (ledger and wake fields)
  - `docs/specs/stream-protocol-v2.md` §5 and changelog
  - SDK tests `prompt-layers`; host tests `usage-cache-service`, `experience-report`, `proactive-metrics`
- **Implementer B: effort routing core and its initiative/controller wiring, including the PDL-3 SDK parts** (owns both hot files to avoid conflicts)
  - `packages/sdk/src/initiative.mjs` (hook, reasoning, repair escalation, decision length retry, abort estimates, tick usage/stale usage, prefixHash)
  - `packages/sdk/src/decision-templates.mjs`, `decision-state.mjs`, `decision-kernel.mjs` (registries), `.d.ts` files
  - `prototypes/control-center/internal-reasoning.mjs` (new)
  - `decision-service.mjs`
  - `project-initiative-controller.mjs` (decision hook, work() effort + `job.reasoning` + unreported-step charge, reviseMessage, recordWake/wakeOutcome)
  - `builtin-agent-service.mjs`
  - `configuration.mjs`
  - `server.mjs` (inject the helper)
  - `web/src/components/settings/sections/ModelsSection.tsx` (+ i18n)
  - `benchmark/internal-effort-probe.mjs`, `benchmark/internal-effort-replay.mjs`
  - `docs/specs/stream-protocol-v2.md` §4 / §6.1
  - `docs/research/jev-internal-effort-probe-*.md`
  - `provider-presets.mjs` (only if open question 1 is approved)
- **Implementer C: length guards and side requests**
  - `packages/sdk/src/reasoning-effort.mjs` (new)
  - `packages/sdk/src/session.mjs` (`sideReasoning`, summary retry, `estimatedInputTokens` passthrough)
  - `packages/sdk/src/bootstrap.mjs`
  - `prototypes/control-center/project-mind.mjs` (modelJson length retry)
  - `project-initializer.mjs` (setup effort, phase 2)
  - `runtime-controller.mjs` (foreground `sideReasoning` wiring, phase 2)
- **Shared:** `packages/sdk/src/index.d.ts` (each adds its own section; the lead merges); SDK `version.mjs` / `package.json` (lead bumps 0.52.0).

**Coordination**
- **P0 deliveries (F1)** edits `reviseMessage` / `narrateAction` (:1171–1213): land B's narrator change on top of F1, limited to the provider-call line, the stop-reason guard and the recheck.
- **P0 scope split** edits `scope()` / `sources()` (:203–233, :683–760): untouched here; this spec relies only on never mutating `coordinator.model`.
- **P0 isolation holds** edit the finish/apply paths in `work()` (:1633–1650, :1756–1778) and `background-worktree.mjs`: B's `work()` edits stay at :2265–2344.
- **P1 foreground lease (PDL-2/TC-1)** edits `decision-service.mjs` hasPendingWork (:463/:491) and the pump (:1047–1075): B's hook lives inside SDK `tick`, and recordWake changes are limited to `tokens` and `interrupted`.
- **PDL-4 (floor ticks) and PDL-6 (daily aggregates)** also touch `wakeOutcome` / `advanceWake`: agree that `interrupted` never moves the ladder.
- **P1-8 accounting (TC-8 token-foreground continuity/gapMs/TTL)** also extends `usageRecord`: A owns `usage-cache-service.mjs`, and field names are agreed (all additive).
- **TC-5** (summary keeps system and tools) composes with the summary retry. The retry keeps the same request; only `reasoning` changes.

## Files
- packages/sdk/src/initiative.mjs
- packages/sdk/src/session.mjs
- packages/sdk/src/bootstrap.mjs
- packages/sdk/src/providers.mjs
- packages/sdk/src/prompt-layers.mjs
- packages/sdk/src/decision-templates.mjs
- packages/sdk/src/decision-state.mjs
- packages/sdk/src/decision-kernel.mjs
- packages/sdk/src/decision-llm-judge.mjs
- packages/sdk/src/index.d.ts
- packages/sdk/src/reasoning-effort.mjs (new)
- prototypes/control-center/internal-reasoning.mjs (new)
- prototypes/control-center/reasoning-capability.mjs
- prototypes/control-center/reasoning-routing.mjs
- prototypes/control-center/provider-presets.mjs
- prototypes/control-center/configuration.mjs
- prototypes/control-center/decision-service.mjs
- prototypes/control-center/project-initiative-controller.mjs
- prototypes/control-center/proactive-pacing.mjs
- prototypes/control-center/experience-report.mjs
- prototypes/control-center/proactive-metrics.mjs
- prototypes/control-center/usage-cache-service.mjs
- prototypes/control-center/builtin-agent-service.mjs
- prototypes/control-center/project-mind.mjs
- prototypes/control-center/gene-evolution-service.mjs
- prototypes/control-center/session-suggestions.mjs
- prototypes/control-center/project-initializer.mjs
- prototypes/control-center/runtime-controller.mjs
- prototypes/control-center/rna-runtime.mjs
- prototypes/control-center/server.mjs
- prototypes/control-center/benchmark/jev-capability-probe.mjs
- prototypes/control-center/benchmark/internal-effort-probe.mjs (new)
- prototypes/control-center/benchmark/internal-effort-replay.mjs (new)
- prototypes/control-center/web/src/components/settings/sections/UsageSection.tsx
- prototypes/control-center/web/src/components/settings/sections/ModelsSection.tsx
- prototypes/control-center/web/src/api/types.ts
- docs/specs/stream-protocol-v2.md
- docs/research/jev-internal-effort-probe-2026XXXX.md (new)
- docs/research/system-review-20261004-findings.md
- docs/planning/next-phase-plan-20261004.md
- docs/research/phase-output-budget-audit-20260926.md

## Probes needed
- Stage A (JEV only, cheap): labelled sets through POST /api/v2/decision-kernel/probe with the production effortTemplate and buildDecisionState, via a new benchmark/internal-effort-probe.mjs with RNA_STATE set to a COPY of the state file. Sets: effort.decision ≥30 captured wake states (every wake source, plan/rhythm wakes, failure reviews); effort.work ≥20 (novel chapter writes, read-only checks, scheduled AI reports, plus the 25 recorded subagent tasks); effort.narrator ≥10; later effort.setup ≥6 and effort.compaction ≥6. Thresholds are set at zero under-routing; distributions and wording iterations are recorded in docs/research/jev-internal-effort-probe-*.md.
- Stage B (main-model, needs explicit user approval, ≈2.5M GLM tokens): paired replay of ~30 captured decision requests at the JEV-chosen effort against the recorded max decision, plus a 10-state max-vs-max baseline. Compare invalid_decision (especially 'unknown evidence'), message_contract, action agreement, output/reasoning tokens and latency. Narrator: message.check pass rate on revisions, chosen effort vs max. Background: ~10 light/standard tasks replayed read-only or in a throwaway isolated worktree that is never applied.
- Optional TC-7 GLM cache-key probe (user-approved, ≈0.2M tokens): the same ~100K prompt sent at two reasoning_effort values, comparing cached_tokens. Decides whether per-decision effort alternation costs prompt cache on GLM.
- Post-activation weekly ledger re-measurement: initiative output by `reasoning`, decision-repair share, failure archive by request.reasoning, background output per run by effort, narrator output and recheck pass rate, stopReason 'length' counts, estimated/aborted rows, 'other' → mind/evolution migration, JEV point cost.

## Open questions
- Should the GLM preset record providerDefault 'max' (doc-cited)? It makes the UI truthful ('通常为最大') and is not needed by the internal logic. Side effect: foreground 'auto' plan mode on GLM moves from high to max (reasoning-routing.mjs:36).
- Does the user approve the Stage B main-model replay budget (≈2.5M GLM Coding Plan tokens), and optionally the ≈0.2M TC-7 effort/cache probe? Without Stage B, GLM decisions and background runs stay at today's effort (max).
- Is it acceptable that phase-2 purposes (initialization/skill-foundation, compaction; ≤30 calls/week) stay at today's GLM effort until their small probes run? On adaptive and default-usable providers they switch to 'default' immediately.
- The modelJson authoring calls (gene-author, gene-patch, gene-contrast) already run at the lowest effort, not max. Should they move under effort.work routing once EVO-10's typed author_error outcomes exist? Moving them could raise effort and needs cap escalation.
- Confirm the setting semantics: configuration.internalReasoning defaults to 'auto' for everyone on upgrade (per the user's decision, so the verifier's 'same as chat' default is superseded), and an explicit project.initiative.modelSelection effort is honoured as a user choice.
- Out of scope but flagged: frozen evaluation suites hit their 4,096-token per-request cap 5 times in 7 days (glm-5.3 at max). The evaluation owner should decide whether this distorts evaluations, since evaluation effort is deliberately excluded here.
- The computed task said invalid_decision/message_contract failures came from truncation. The failure archive (139 + 6 failures, 09-24→10-02) shows stopReason 'stop' for all of them, so the plan doc's rationale should be corrected. The real risk of lower effort is more unknown-evidence citations, not truncation.