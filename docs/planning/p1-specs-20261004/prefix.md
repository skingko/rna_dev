# P1 implementation spec — stable genome names, shared prefix, foreground lease, purpose projections

Code baseline: main @ cd6a9d0 (app 0.64.0 / SDK 0.51.0). Target: app 0.66.x / SDK 0.52.0. All line numbers are current code.

## 0. Live baseline (measured read-only, 2026-10-04)

Usage ledger copy (`state.json.usage-cache.jsonl`, 8,471 rows, 09-28T05:44Z → 10-04T08:36Z = 6.1 days). Per-week figures below are ×1.148.

| purpose | calls | uncached | cacheRead | hit | output |
|---|---|---|---|---|---|
| initiative | 641 (100 zero-token) | 16.35M | 6.03M | 0.269 | 3.71M |
| foreground | 1,518 | 17.75M | 481.0M | 0.964 | 2.28M |
| background-work | 2,906 steps / 152 runs | 12.95M | 256.1M | 0.952 | 4.27M |

- Paid initiative decisions: 535. Average 30.0K uncached + 11.3K cached + 6.9K output.
- Decision cacheRead by gap since the project's previous decision:
  - under 5 min: 15.6K
  - 5–20 min: 10.1K
  - 20–40 min: 12.0K
  - over 40 min: 4.6K
- Background runs: median 9 steps (p90 50). First request median 34.4K uncached + 11.5K cached. Later steps median 90.2K cacheRead.
- Wake history `prompt.divergedIn` (GET `/api/v2/projects/:id/mind` → `pacing.wake.history`): every `hostActionContracts.work` divergence (novel 5, AI 6) dates from 10-02. Since 0.63.3 (10-04 05:40Z) there are none, because git projects no longer flip backgroundLevel.

---

## 1. EVO-3 / TC-1 — stable genome tool and skill names

### 1.1 Why
- `genomeToolName` (packages/sdk/src/project-genome.mjs:47) hashes `namespace`.
- `genomeSkillId` (prototypes/control-center/project-genome-store.mjs:11) hashes `namespace`.
- `namespace = projectGenomeNamespace(projectId, versionId)` (:12, used at :20/:37/:41).
- Every generation therefore renames every generated tool. That changes `digest({systemPrompt, tools})` (packages/sdk/src/context.mjs:112) and the published cross-purpose prefix (rna-runtime.mjs:302).

Live measurements:
- **Novel generations:** 26 generations; the genome systemPrompt never changed and tool declarations changed in only 8.
- **Ledger join:** two foreground prefix misses followed skills-only generations inside the cache window:
  - session 4ed897f8, 09-30 22:14, gap 2.5 min: 359,898 uncached
  - 10-01 18:51, gap 15.6 min: 563,586 uncached
  - Total: 923,484 in 6.1 days.
- **TC-1 journal replay:** 6 version-only misses, 1.47M.
- **Two further misses under 20 min:** 256K. Those generations changed tool declarations, so they stay misses after this fix.

### 1.2 Changes

1. **SDK naming.** packages/sdk/src/project-genome.mjs:47: keep `genomeToolName(namespace, localId)` unchanged. Add:
   ```js
   /** Model-facing identity of a project's generated capabilities (EVO-3): stable across generations. Which version runs is pinned by the handle's bundle, never by the name. */
   export const genomeNamespace = projectId => String(projectId);
   ```
   - Export it from packages/sdk/src/index.mjs:22 and declare it in index.d.ts:780.
   - Result: `gen_<sha256(projectId)[0:8]>_<localId>` for tools and `gen-<sha256(projectId)[0:16]>-<localId>` for skills.
   - The formats are unchanged, so these regexes keep matching without edits:
     - rna-runtime.mjs:57 (`managedSkill`, `managedTool`)
     - project-initializer.mjs:30
     - capability-install-service.mjs:87
     - project-initiative-controller.mjs:2161-2162
     - web `skill-names.ts:9`
   - No content or definition hash (corrected fix). A changed description or parameter set still changes the tools array.

2. **Genome store.** prototypes/control-center/project-genome-store.mjs:
   - Keep `projectGenomeNamespace(projectId, versionId)` for `record.namespace`. It is the storage identity: record.json, bundle hashes and `ProjectGenomeStore.read` stay valid.
   - Add `export const genomeIdentity = projectId => genomeNamespace(projectId)`.
   - :37 `genomeSkillId(genomeIdentity(projectId), skill.id)`.
   - :41 `genomeToolName(genomeIdentity(projectId), tool.id)`.

3. **Pinned execution, unchanged.** rna-runtime.mjs:
   - :55 `createGenomeTools(bundle.genome, { namespace: genomeIdentity(bundle.projectId), workspace: options.cwd, signal, deniedPaths })`.
   - :56 and :150: `genomeSkillId(genomeIdentity(bundle.projectId), skill.id)`.
   - Execution stays pinned:
     - `generated` closures come from the handle's verified bundle (:42-54).
     - `candidate.skills.set(skill.id, skill)` (:105) overrides the registry entry with the pinned bundle path.
     - skill_load verifies hashes against `bundle.files` (:139, :146-149).

4. **Controller call sites.** project-initiative-controller.mjs:
   - :579 (`planningCapabilities`) and :2165 (`assigned`): pass `namespace: genomeIdentity(project.id)`. These are the only two edits item 1 makes in this file.

5. **Background runs pin their version** (same guarantee as foreground turns, runtime-controller.mjs:939-940).
   - In `work()` (controller:2257): on first start record `job.projectVersionId = project.trialVersionId ?? project.activeVersionId` in the `startJob` mutation (:2170).
   - On checkpoint resume (`action.checkpoint`), pass `projectVersionId: job.projectVersionId` to `this.factory` (:2293).
   - rna-runtime.mjs:39-40 already throws if that version is gone.
   - Without this, a resumed run would silently execute a newer script under an unchanged name.
   - **Owner:** whoever edits `work()` for item 4, to avoid conflicts. See §5.

6. **commitGeneration keeps assignments byte-stable** (project-genes.mjs:262-270). Equal ids would otherwise still rewrite `reasons` with `第 ${n} 代项目能力。` for every id.
   - Let `newSkill` / `newTool` be the sets of prepared ids.
   - `skillIds = [...previous.skillIds.filter(id => !oldSkills.has(id) || newSkill.has(id)), ...preparedIds.filter(id => !kept.has(id))]`. Same for `toolIds`. Order is preserved; only added ids are appended.
   - `reasons`: keep previous rows whose id is not old or is still present. Add the `第 n 代` rows only for added ids, and drop rows of removed ids.
   - Assign `target.assignments` only when it is not deep-equal to the previous value.
   - `state.capabilities.skills = [...skills.filter(row => !oldSkills.has(row.id) && !newSkill.has(row.id)), ...copy(prepared.skillManifests)]`. This replaces by id.
   - A skills-only generation now leaves `project.assignments` unchanged. That also stops the rhythm evidence key (project-rhythm.mjs:14) and learning drift (project-learning-scope.mjs:80) from moving.

7. **Invariant: at most one `state.capabilities.skills` manifest per id.** `CapabilityRegistry.registerSkill` (packages/sdk/src/capabilities.mjs:158) throws `Duplicate skill id`, which would fail every turn. Make every other writer replace instead of throwing:
   - **project-initializer.mjs:210.**
     - Throw `version_conflict` only when an existing row with an incoming id is not `managed === 'project-genome' && row.projectId === project.id`.
     - Otherwise filter those same-id rows out and push.
   - **project-skill-foundation-service.mjs:188-189:** same rule; `foundation_version_conflict` only for another project's row.
     - The publication check at :203 already compares by id plus hash and still holds.
     - `nextAssignments` (:57-64) works with equal ids (filter, then add).

### 1.3 Migration (one time, idempotent)

New module prototypes/control-center/genome-identity.mjs exporting `migrateGenomeIdentities(state) → { changed, projects, remapped }`. Call it in the Store constructor right after `migrateRealBudgets(this.state)` (store.mjs:523) and do `if (result.changed) this.state.revision++`.

For each `state.projects[]` entry (archived included):
1. **Old-id map.** For every version, over `generatedSkills`, `skillManifests`, `generatedTools` and `toolDescriptors`:
   - `localId = row.localId ?? row.id.replace(/^gen-[a-f0-9]{16}-|^gen_[a-f0-9]{8}_/, '')`.
   - `stable` is the stable name for that localId.
   - If `row.id !== stable`: `map.set(row.id, stable)`, set `row.id = stable`, and set `row.toolName = stable` for tools.
2. **Remap with order-preserving dedupe:**
   - `project.assignments.{skillIds,toolIds}`
   - `project.assignments.reasons[].id` (dedupe by kind+id, keep the last)
   - `versions[].assignments`
   - `project.capabilitySnapshot.skillHashes` keys (on a collision keep the active or trial version's hash)
   - `project.capabilitySnapshot.tools[].id`
3. **`state.capabilities.skills`.** Group managed rows (`managed === 'project-genome'`) of existing projects by (projectId, localId):
   - Keep the row whose `versionId === (trialVersionId ?? activeVersionId)`; otherwise keep the last in array order.
   - Set its id to stable and drop the rest.
   - Rows of deleted projects (projectId not in state.projects) are left untouched. Their old ids stay unique, and the deletion work owns them.
   - Live today:
     - project d4ed6510 has 2 `project-workflow` manifests (bb3b76a8, 0ef32f0c).
     - project 2ba45503 has 2 each of `daily-research-workflow` and `source-verification`.
     - Without dedupe these would collide.
4. Bump `capabilities.revision` once if anything changed. A second run must change nothing.

Session journals and old tool calls in history are not rewritten (immutable history). The migration costs one last rename, the same as one generation today.

**Ordering dependency.** Ship after the P0 scope split (PDL-1/MEM-1/MEM-2). Today `scope()` (controller:233) hashes `project.assignments` and `store.state.capabilities`, so this migration would revoke receipts and delete memory evidence in every project, which is exactly the P0 bug.

### 1.4 Tests
- **packages/sdk/test/project-genome.test.mjs:**
  - `genomeToolName(genomeNamespace('p'), 'x') === 'gen_' + sha256('p').slice(0,8) + '_x'`.
  - `createGenomeTools` with the same projectId gives equal names for different genomes.
- **test/project-genome-store.test.mjs:** two `prepare()` calls for versions V1 and V2 of one project:
  - give equal manifest and tool ids;
  - keep `record.namespace === 'project:V1'` / `'project:V2'`.
- **test/project-version-runtime.test.mjs**, rewrite `exercise` and the fixture:
  - The fixture replaces manifests by id; pushing both versions' manifests must throw in the registry, which proves the invariant.
  - V1 and V2 handles declare the same `estimate_scope` name but return `{version:'V1', effort:2}` and `{version:'V2', effort:20}` respectively.
  - `skill_load` with the same id returns `资源内容_V1` on the V1 handle and `资源内容_V2` on the V2 handle.
  - A resumed old handle still runs V1.
- **test/gene-tree.test.mjs** (commitGeneration):
  - A skill-only change leaves `project.assignments` deep-equal and keeps one manifest per id.
  - A tool description change keeps the name and changes the declaration.
  - A new tool appends one id and one reason.
- **test/prompt-cache-prefix-sharing.test.mjs:** `sharedPrefixFor(project).tools` names and `digest({systemPrompt, tools})` are identical before and after a skill-only generation.
- **New test/genome-identity-migration.test.mjs**, on a fixture shaped like live data (two versions, duplicate (project, localId) manifests, versioned assignments with reasons, capabilitySnapshot, plus a deleted project's manifests):
  - stable ids are written;
  - dedupe keeps the active version's manifest;
  - a `CapabilityRegistry` built from the migrated `capabilities.skills` does not throw;
  - the deleted project's rows are untouched;
  - a second run reports `changed: false`.
- **test/project-initializer.test.mjs and the skill-foundation tests:** a re-initialization or foundation publish on a project that already has managed manifests replaces them instead of throwing; another project's row with the same id still throws.
- **Background pin** (project-initiative-background-context.test.mjs): commit a generation between start and checkpoint resume; the factory receives the original `projectVersionId`.

### 1.5 Measure after shipping
New read-only script prototypes/control-center/benchmark/prefix-miss-attribution.mjs:
- **Inputs:** a ledger copy plus GET `/api/projects`.
- **Join:** for each foreground and background-work stream (sessionId), list the prefixKey changes. Classify each by:
  - a generation between the two rows: skills-only, or declarations or system changed (diff `versions[].bundle.genome.tools` description, parameters and permission against the parent);
  - the gap: under 20 min, 20–40 min, over 40 min.
- **KPI:** uncached input on prefix changes within 40 min after a skills-only generation. Today 0.92M per 6.1 days; target 0.
- **Secondary:** count of `host-authorization` context messages per session journal after skills-only generations. Today the novel history has 19 copies; target: no new copy per skills-only generation.

### 1.6 Risks and guards
- **Duplicate manifest ids would break every turn.** Guarded by the invariant at all three writers, the migration dedupe, and registry-construction tests.
- **The migration rotates the initiative scope.** Guarded by the sequencing after P0.
- **Same name, different behaviour across turns** (a script-only fix). This is intended: each handle and resumed run is pinned to its version (item 1.2.5).
- **A trial version and the active version share manifest ids.** Only display reads the state manifest; runtime always overrides from the bundle (rna-runtime:105).

---

## 2. Initiative decisions sharing the foreground prefix (GLM tool_choice)

### 2.1 Finding (documentation)
- **Zhipu's official chat-completions reference** (https://docs.bigmodel.cn/api-reference/模型-api/对话补全, `POST /paas/v4/chat/completions`) describes `tool_choice` with "默认auto且仅支持auto". The same page lists the GLM-5.3, 5.2, 5.1, 5, 4.7 and 4.6 text models.
- **Z.AI English reference** (https://docs.z.ai/api-reference/llm/chat-completion) says the same: the default is `auto`, and only `auto` is supported.
- **OpenAI-compatibility guide** (https://docs.bigmodel.cn/cn/guide/develop/openai/introduction) documents no `none` or `required`.
- **The app uses the coding endpoint** (`https://open.bigmodel.cn/api/coding/paas/v4`, see turn.modelConfig). No document gives it different parameters. Nothing documents `none` there, so it must be treated as unsupported.
- **Conclusion:** `compat.supportsToolChoiceNone` must stay unset or false for GLM. `outputCapabilities` (packages/sdk/src/providers.mjs:122-130) is correct as is.
- **Related, for P1 item 4:** the Z.AI page gives GLM-5.3 `reasoning_effort` values low, high and max, with default **max**. "Use the provider default" therefore means max on GLM.

### 2.2 Sharing would not reduce uncached input anyway (measured)
`sharedPrefixRequest` (context.mjs:155-160) sends:

`[agent system + tools ≈13.7K] [skill-catalog, orientation] [decision instructions as host message] [request]`

The decision-specific part still comes after the shared part, so it is cached only when a previous decision with the same bytes ran inside the cache window. That is exactly as today.

The only gain is that the ~14–20K agent prefix tokens become cache reads. These tokens are not sent at all today.

| | per decision |
|---|---|
| Own prefix (today) | 30.0K uncached + 11.3K cached |
| Shared prefix, best case | ≥30.0K uncached (the ~4K cross-project decision prefix becomes uncached) + ~25–31K cached |

- The hit rate rises (0.27 → ~0.45), but uncached input does not fall.
- Total input grows by about +14–20K per decision, roughly **+8–12M cached tokens per week**.
- On Anthropic, changing `tool_choice` keeps the tools and system cache but invalidates the messages tier (claude-api skill, prompt-caching "Invalidation hierarchy"). Only system and tools would be shared there, with the same conclusion.

The 0.27 hit rate is addressed by items 3 and 4 (fewer decisions, shorter volatile tail), not by sharing.

### 2.3 Changes
1. GLM: no compat change. Record §2.1 and §2.2 in the existing compat comment at providers.mjs:123-127, with the two URLs and the date.
2. **Make decisions use their own prefix explicitly.** Remove `sharedPrefix: () => sharedPrefixFor(project.id, model)` from the coordinator construction (project-initiative-controller.mjs:762), and remove the now-unused import at :14.
   - Today this path is live only for verified DeepSeek (2 ledger calls in 7 days).
   - Without this change, the planned Claude work (TC-3, Anthropic `tool_choice:{type:'none'}`) would switch decisions to the shared path automatically, with no saving.
   - project-learning-controller.mjs:180 has the same wiring and the same analysis applies. It is not in this item; see open questions.
3. **For the Claude-readiness owner, not this item:** Anthropic documents `tool_choice:{type:'none'}`. In providers.mjs, `outputCapabilities` may return `toolChoiceNone:true` for protocol `anthropic`, and the anthropic branch of `buildRequest` (:203-223) should then send `body.tool_choice = { type: 'none' }`. Its real users are forked side calls over the conversation (TC-5 step-limit summary, TC-6 compaction), where the conversation is the cached prefix.
4. **Optional one-time GLM check: not needed and not run.**
   - Design: through a new daemon-internal command, so the key never leaves the app:
     - 3 × `POST {baseUrl}/chat/completions`;
     - `glm-5.3`, `reasoning_effort: 'low'`, `max_tokens: 64`;
     - one trivial `ping` tool, `tool_choice: 'none'`;
     - message "Call the ping tool now.".
   - Outcomes:
     - **400:** rejected.
     - **tool_calls returned:** ignored, which is unsafe.
     - **3/3 text:** the behaviour is undocumented, so still not relied on.
   - Cost under 2K tokens, with user approval. Recommendation: skip unless Zhipu documents `none`.

### 2.4 Tests
- test/project-initiative-controller.test.mjs: with a fake verified provider (DeepSeek-shaped model), the decision request system prompt equals the decision prompt (`wake.prompt.prefix === 'own'`), and `tools` is empty.
- Keep the existing SDK test for the shared path; it is still used by learning.

### 2.5 Measure
- Wake history `prompt.prefix` is `own` on all wakes.
- Initiative uncached per paid decision does not rise. Baseline 30.0K.

---

## 3. PDL-2 / token-background TC-1 — foreground lease

### 3.1 Why
Live join of decisions and ledger rows with session turn windows, over 6.1 days:
- **Paid decisions that ended inside a running foreground turn:** 90.
  - 2.997M uncached + 0.730M cached + 0.595M output: 18.7% of initiative uncached input.
  - Novel 58, 3d 14, AI 13, test 5.
- **Aborted (zero-token) decisions** that started mid-turn: 39 inside a turn and 34 within 5 s after the turn's end. The provider billed their input; the ledger shows 0.
- **What the in-turn decisions cited** (68 retained):
  - 64 cite only messages, turns and schedule state, i.e. the turn's own user messages;
  - 3 cite observations;
  - 22 novel decisions were `wait` with reasons like "前台回合正在执行".

Mechanism:
- A user message is a fresh `message:` source (controller:651, :988-990), and it sets `notBefore = 0`.
- `projection().signals.hasPendingWork` includes `running` (decision-service.mjs:453, :477), so `reviewScored` returns `main_review_required` before calling JEV (:522, :550).
- The pump skips the gate entirely while actions are queued or running (controller:1053).

### 3.2 Design (structural rules, no text heuristics)

**Progress key.** New controller helper `progressLease(projectId, live)`, next to `foregroundBusy` (:483):
- `foreground`: non-archived, non-side sessions whose `activeTurnId` turn has status `running`, given as `{ turnIds, sessionIds, startedAt, request }`. `request` is the text of the turn's `userItemId`, which store.mjs:268 always creates.
- `work`: SDK actions with action ∈ {work, learn} and status ∈ {queued, running}.
- `key`: hash of the sorted turn ids and sorted running action ids.

**Lease-owned sources** (`leaseOwnedIds`), computed exactly in code:
- (a) `message:<itemId>` where the item's `turnId` is in `foreground.turnIds`. `sessionItem` stamps `turnId: session.activeTurnId` (store.mjs:64); steers are included.
- (b) `observation:<id>` of kind `workspace_change` where every `data.changes[].path` equals a path written in that running turn. "Written" means session items with that `turnId`, `tool.name ∈ {project_write, project_edit}` and `tool.args.path`, compared as normalized project-relative POSIX paths. This applies to direct-mode turns; worktree turns write to S.

**Independent evidence.** Everything else that is fresh, except `schedule_state`. That includes SDK-internal `action_completed` events of background runs: take `live.events` of type `action_completed` whose id is not yet in `context.sdkSeen` (new Set on the context).

**Pump changes** (project-initiative-controller.mjs):
1. **:988-992.** Compute `lease` and `independent`.
   - If initialized and `independent.length`: keep today's `invalidateDecision` + `notBefore = 0`, and clear `context.progressHold`.
   - If only lease-owned sources are fresh: still `observe()` them. Observing aborts a stale in-flight decision (SDK initiative.mjs:682). Do not reset `notBefore`.
2. **New hold check right after `if (await this.scheduledWork(context)) continue;` (:1022)**, so schedules still claim:
   ```js
   const progress = this.progressLease(project.id, live);
   if (context.progressHold && context.progressHold !== progress.key) { context.progressHold = null; context.notBefore = 0; } // turn ended, stopped or paused, or the work ended: review what was held
   if (progress.foreground && !independentThisPump && !live.pendingFailureReview) {
     context.progressHold = progress.key; this.decisions?.recordLeaseHold?.(project, progress.key);   // one rule row per key
     if (live.actions.some(a => a.status === 'queued')) await context.coordinator.tick({ presence: this.presence(this.project(project.id)), decisionEnabled: false }); // deliveries and recovery drain
     continue;   // no snapshot(), no gate, no decision, no wake row
   }
   ```
   - Stopped and paused turns produce no `conversation_result` (`terminalTurns` :56 takes only completed and failed turns). The key-change rule handles them.
   - A turn that completes or fails emits its `conversation_result`, which is the normal wake (gated as today).
3. **Gate call (:1053).** Drop the `!saved.actions.some(queued|running)` precondition. Keep `!saved.pendingFailureReview && wakeEligible`. Pass:
   - `evidence: independent.length ? independent : (saved.events ?? []).slice(-6)`
   - `freshCount: independent.length`
   - `progress: { key: progress.key, foreground: progress.foreground, work: progress.work }`
4. **On deferral (:1059).**
   - If `gate.holdUntilProgressEnd`: `context.progressHold = progress.key`.
   - Else: `context.notBefore = gate.retryAt`.
   - In both cases, when queued actions exist, run `tick({ ..., decisionEnabled: false })` first. This is the corrected fix #3: deliveries keep draining.
   - Return `{ status: 'judgment_deferred', reason }`.
5. **`wakeOutcome`** (:146): unchanged for `judgment_deferred` (one `deferred` row). Lease holds never reach it.
   - Coordinate with the PDL-4 owner, who edits the same line. The hold path above never calls tick with a floor result, so it adds no zero-token `thought` rows.

**decision-service.mjs changes:**
1. **`projection()`, :450-480.** Add the signals:
   - `pendingReview: actions.some(status === 'needs_review')`
   - `activeWork: pending.some(status ∈ queued|running)`
   - `foregroundRunning: running`

   Keep `hasPendingWork` unchanged. It feeds kernel policy (decision-kernel.mjs:60, :497, :501) and must not move thresholds silently.
2. **`reviewScored`, :522 and :550.** Replace `hasPendingWork` with `pendingReview`.
   - When `options.progress?.foreground` is set, `deliveryJustCompleted` does not bypass; a background completion during a turn is judged.
   - The remaining bypasses each write one rule ledger row: dueSchedule, pendingReview, unansweredQuestion, deliveryJustCompleted (outside a lease), severeFailure, and overdue commitments at :526.
   - Rule row: `this.record({ ledgerId: randomUUID(), point, backend: 'rule', source: 'rule', mode: 'active', reason: 'bypass_<signal>', policy: null, latencyMs: 0, networkAttempted: false }, { projectId }, 'main_review', judgmentPolicy)`. The same shape as `nothing_actionable` at :538.
3. **New method `recordLeaseHold(project, key)`.**
   - Writes `reason: 'foreground_lease'`, disposition `deferred`, `decided: true`, `savings: { mainModelCalls: 1 }`.
   - At most once per (project, key), tracked in a Map pruned when the key changes.
4. **`initiativeGateState` (:604).** When `progress` is given, add code-built fields:
   - `foregroundTurn: { since, request }`
   - `backgroundWork: [{ status, intent }]` (at most 3)
5. **Deferral with progress.** If `combineInitiativeGate` returns `wake:false` with reason `in_progress_covers`:
   - `this.deferrals.set(key, { identity: hash([identity, progress.key]), until: Infinity, count: 0, ledgerIds })`
   - return `{ review: false, holdUntilProgressEnd: true, reason: 'in_progress_covers', ledgerId }`
   - The two-pass forced review does not count these. The progress ending always produces a fresh source or a key change, so evidence is delayed, never discarded.

**SDK templates** (packages/sdk/src/decision-templates.mjs):
- `INITIATIVE_GATE_TEMPLATE_VERSION = 3` (:380).
- `initiativeGateTemplate({ inProgress = false } = {})` adds the question below only when in progress, so wakes outside a lease keep today's questions and calibration:
  ```js
  in_progress_covers: noul('Work is in progress now: `review.foregroundTurn` (the reply the assistant is writing in the conversation) and/or `review.backgroundWork`. Is every item in `review.newEvidence` about the same task as that work in progress?', 'Every new item is about the task the work in progress is already doing.', 'At least one new item is about something the work in progress is not doing.')
  ```
- `TEMPLATE_SPECS['initiative.review'].questions` (:513): add `['in_progress_covers', B]`. Required by AGENTS.md; otherwise `invalid_assessment_plan`.
- `DECISION_THRESHOLDS.points['initiative.review']` (:19): add `in_progress: <stake chosen from the probe>`.
- `combineInitiativeGate(answers, { backend, inProgress })` (:1061): when `inProgress` and `stakeVerdict(answers.in_progress_covers, t.in_progress) === true`, return `{ wake: false, reason: 'in_progress_covers', ... }`. Otherwise use today's logic. An abstention falls through, so JEV unavailable means fail-open: today's behaviour and cost.
- decisionService passes `initiativeGateTemplate({ inProgress: Boolean(progress?.foreground || progress?.work?.length) })` at :543.

**SDK state** (packages/sdk/src/decision-state.mjs:144-155):
- Put `foregroundTurn` (`{ running, since: recencyBucket(...), request: clip(...,400) }`) and `backgroundWork` (`clip(status + ': ' + intent, 240)` × ≤3) first inside `review`, before `recentReports`.
- `minimizeDecisionState` (decision-kernel.mjs:89-130) spends its 8,000-char budget on `userMessage` (2,400) and evidence first. A test must prove the new fields survive a maximal state.

**Not added:** no new routing for user messages during background work. The foreground already receives `project-background-actions` with the steer instruction (rna-runtime.mjs:269-270) and `project_background_control`.

### 3.3 Labelled probe (before choosing `in_progress`)
New prototypes/control-center/benchmark/initiative-lease-probe.mjs, read-only, using `readStateFile` on a state copy and the live probe endpoint:
1. **Extract cases.**
   - Every decision or zero-token row in a turn window: novel 39 + 37, test 4 + 5, 3d 12, AI 13.
   - Every decision made while a background action ran (novel 24).
   - Keep the ones with independent evidence under the §3.2 rules. Rebuild the v3 state: `newEvidence` = independent items as of that time, `foregroundTurn` = the turn request, `backgroundWork` = running actions.
2. **Labels.** A human writes `expected: defer|wake` per case. The main model's action is not the label (PDL-7).
3. **Probe.** POST `/api/v2/decision-kernel/probe` with `{ state, questions }`. Record the `in_progress_covers` distribution per label, choose the stake (low .6 / medium .75 / high .85) that gives no `wake` case deferred, and record the confusion matrix in docs/research/jev-initiative-lease-probe-<date>.md.
4. **Cost and approval.** JEV only (~0.04 USD/M input), with user approval to run.

### 3.4 Tests
- **decision-service.test.mjs:**
  - The `pending` case (:108-114) splits: queued work now calls JEV once; `needs_review` still bypasses and writes a `bypass_pending_review` rule row.
  - The `active_session` and `queued_work` live-recheck cases (:222-231) are no longer forced.
  - Each bypass writes exactly one rule row.
  - In-progress deferral returns `holdUntilProgressEnd` and is not forced after two passes.
  - An abstention wakes.
- **packages/sdk/test:**
  - `validateHostTemplatePlan(initiativeGateTemplate({ inProgress: true }))` passes, also as a supplement.
  - `combineInitiativeGate` covers in-progress, abstention and not-in-progress.
  - The decision-state fields survive minimization with a 2,400-char userMessage and 6×600 evidence.
- **New test/project-initiative-lease.test.mjs** (fake clock, fake provider counting calls, fake JEV):
  1. A user message starts a turn: 0 main-model calls while it runs, 0 zero-token rows. Its `conversation_result` leads to exactly one gated review.
  2. A 2-hour turn with the floor eligible every 10 min: no tick with decisions, no wake rows, one `foreground_lease` ledger row.
  3. An unrelated user edit (workspace_change) during the turn reaches the gate with `progress`:
     - covers → held until the turn ends, with no forced review;
     - not covers + needs_main_model → one decision mid-turn.
  4. A workspace_change whose paths ⊆ the running turn's `project_write` paths: no gate call.
  5. A queued share during the lease drains with `decisionEnabled:false`.
  6. A background `action_completed` during the lease is gated, not bypassed.
  7. A turn stopped or paused (no conversation_result): the key change resets `notBefore` and one review follows.
  8. Running background work with no foreground, plus new evidence: the gate runs; covers → held until the action completes.
  9. A gate deferral with queued actions drains and records one `deferred` wake.
  10. `pendingFailureReview` during the lease is not held.

### 3.5 Measure after shipping
New read-only script benchmark/initiative-lease-report.mjs (ledger copy + GET `/api/state` sessions + GET `/api/decision-kernel/ledger`), per day and project:

| metric | today (6.1 d) | target |
|---|---|---|
| paid initiative rows inside a turn window | 90 (3.0M uncached / 0.73M cached / 0.60M output) | ≈ 0, plus JEV-woken cases |
| zero-token rows inside a turn or ≤5 s after its end | 73 | ≈ 0 (turn-start aborts, 17 on the novel, remain) |
| paid decisions per completed user turn | — | ≤ 1 |
| ledger `foreground_lease` and `bypass_*` rows | none | visible |
| `in_progress_covers` distribution | none | vs probe |

**Expected saving:** about 3.4M uncached + 0.8M cached + 0.7M output per week recorded. In addition, about 84 aborted decisions per week stop being started, ≈1.7–2.5M billed but unrecorded input.

### 3.6 Risks
- **Delayed reaction to independent evidence during long turns.** Mitigated: JEV judges it, an abstention wakes, and the hold ends on key change.
- **A turn stuck in `running`** holds decisions only. Schedules (`scheduledWork`) and queued deliveries keep draining, and a restart pauses running sessions (store.mjs:528-535).
- **Ledger rows from rule decisions** displace JEV rows in the 200-row `recent` window (F8). They are 1 per lease key and 1 per bypass, and carry `networkAttempted:false` with no predictions, so calibration ignores them.
- **Corrected-fix conflict, resolved here.** TC-1 (background) kept queued and running actions in the bypass; PDL-2 #3 needs the gate for them. Only `needs_review` stays a bypass.

---

## 4. Purpose projections (token-background TC-2, TC-3) and PDL-5 / TC-4

### 4.1 TC-2 — worker brief instead of the decision snapshot
**Why.** Live worker attachments (state.json.rna/initiative copies) are 48.9K, 51.6K and 50.1K chars, i.e. 67–75K UTF-8 bytes, ≈22–25K tokens by bytes/3.

Decision-only parts take 65–67% of them:
- capabilityContext 7.1K
- non-work contracts 4.1K
- scheduleContext 4.6K + schedules 3.8K
- projectVersion 2.4–3.7K
- mind 1.6–3.2K (a duplicate of the `project-mind` attachment)
- assignments 2.3K
- communication 1.5–5.8K
- rhythmStatus 1.0K
- recentConversation 0.7–1.3K
- turns duplicated with `evidence` 2.0–2.6K

The attachment is read uncached on step 1 and then re-read as cache on every later step.

**Changes** (project-initiative-controller.mjs):
1. **Refactor `snapshot()` (:587-645)** into reusable builders (no behaviour change for decisions): `projectIdentity(project)`, `workContract(project, ctx)`, `continuityView(project, sessions, { snapshotAt, reversions, eventIds, receiptIds })`.
2. **New `workerBrief(project, model, { evidence })`** returning:
   - `stable`: `{ id, title, description, overview, focus, constraints, openQuestions, milestones, work: { authorization, scope, continuation, permissions: { settings, workspace, revision, description } } }`
   - `volatile`: `{ clock, work: { backgroundLevel, effects, planning?, foregroundBusy?, effective: permissions.effective }, workspaceEvents?, continuity, pendingJobs }`
   - In `continuity.recentTurns`, every turn whose `terminalSourceId(project, turn)` (:75-82) is among `evidence[].id` becomes `{ evidence: <id>, ...(undone ? { undone } : {}) }`.
   - Keep `unfinishedTurns`, `awaitingUserRetry`, `actionReceipts` (with handoffs, execution, changesReverted) and `history`.
   - Dropped: capabilityContext, non-work contracts, communication, scheduleContext, schedules, scheduleDeliveryPolicy, rhythmStatus, learningStatus, learningPolicy, learningEnabled, assignments, projectVersion, recentConversation, handoffs, mind.
3. **`work()` (:2338).**
   - Attachment becomes `[{ source: 'project-evidence', text: JSON.stringify({ project: volatile, evidence }) }]`; `project-memory` and `project-mind` are unchanged.
   - Pass `initialContextTail: [{ key: 'project-brief', source: 'project-brief', text: JSON.stringify(stable) }]` to `this.factory` (:2293).
   - Record `job.briefStats = { stableChars, volatileChars, evidenceChars }` for attribution.
4. **rna-runtime.mjs:303-304.** Accept `options.initialContextTail` (≤4 items, same validation as `initialContext`) and pass `initialContext: [...sharedContext(), ...(options.initialContextTail ?? [])]`.
   - `publish()` (:302) still publishes only `sharedContext()`, so the foreground, background and subagent shared prefix is unchanged.
   - Consecutive runs now also share `[system, tools, catalog, orientation, brief]`.
   - The brief gets the generic reference label (context.mjs:106-108), the same as `project-evidence` today.

### 4.2 TC-3 — each turn and action once in the decision request
Pass `{ eventIds: new Set(context.coordinator.state.events.map(e => e.id)), liveActions: context.coordinator.state.actions }` to `snapshot()` at controller:1043 and :762.
- The SDK trims events only on append (initiative.mjs:687); `_compactHistory` keeps them.
- Any observation between snapshot and tick makes the tick stale (:795), so the references cannot dangle.

1. **`continuity.recentTurns`.** A turn whose terminal source id is in `eventIds` becomes `{ evidence: id, ...(undone ? { undone } : {}) }`. `evidenceAliases.alias` (initiative.mjs:225-230) rewrites it to `E#`.
2. **`recentConversation`.** Drop messages whose `turnId`'s terminal source id is in `eventIds`. The event carries the same requests and final text, at 1,000 and 2,000 chars.
3. **Shared receipt predicate.** Export from initiative.mjs `export const RECENT_RECEIPTS = 20; export function receiptEligible(action)`. This is the predicate at :789 (`['queued','running','paused','completed','needs_review']` or failed and not `contextRevoked`), and tick uses it too.
4. **Host `continuity.actionReceipts` (:123-134).**
   - For ids in `liveActions.filter(receiptEligible).slice(-RECENT_RECEIPTS)`, emit only `{ actionId, ...(execution), ...(changesReverted), endedAt }`.
   - Other actions (cancelled) keep the full receipt.
5. **Drop `handoffs`** from the decision snapshot (:643, `handoffLines`). The SDK receipts carry `handoff`, and `endedAt` keeps the time.
6. **`communication.recentWorkNotReferencedByDelivery`** (:173): drop `summary` when the action is receipt-eligible or `action:<id>:completed` is in `eventIds`.
7. **Send schedules once.** When `scheduleContext` exists, emit `scheduleContext` without its `schedules` and keep top-level `schedules`. The SDK validates `project.schedules` (initiative.mjs:149, :291).
   - Change the schedule contract scope text (:619) from "use scheduleContext actual records and cancellations" to "use project.schedules (actual records) and scheduleContext.cancelled". This is the only wording change in item 4; it goes into the replay below.

**Size.** From the snapshot parts, this saves about 11–17K chars (≈3–6K tokens) per decision in the uncached tail.

### 4.3 PDL-5 / bg TC-4 — volatile contract fields to the request tail
**Phase 1 (now; position only, no wording change).** In packages/sdk/src/initiative.mjs:
- `VOLATILE_CONTRACT_FIELDS` (:236) becomes:
  ```js
  { work: ['foregroundBusy','planning','effects','backgroundLevel','permissions.effective'], learn: [...], rhythm: [...], judgment: [...], ask: ['pending'], share: ['reach.quietNow','reach.notificationsMuted'] }
  ```
- `splitContracts` (:247-256) supports dotted paths: delete from the contract, nest into `conditions`.
- `withConditions` (:258-262) deep-merges nested fields back, so validation sees exactly what the model saw.
- In `requestText` (:274), move `communicationPolicy` (it holds `notificationMuted`) from the head to just before `presence`.

In the controller:
- Stop overriding `work.permissions` (:624 planning branch, :627 busy branch). Always send `permissionView`; its `effective` goes to the tail.
- Add `work.backgroundLevel` (effective).
- `ask.pending` (:613) and `share.reach.{quietNow,notificationsMuted}` (:621) are unchanged in content.

**Phase 2 (deferred, measurement-gated).** Make `work.authorization` and `work.scope` independent of the level (both variants, keyed on `hostConditions.work.backgroundLevel`). Do this only if `divergedIn = hostActionContracts.work` keeps appearing on 0.66 wakes. Today it is 0 since 0.63.3, because only plan mode and non-git projects flip. Run the decision replay first.

### 4.4 Tests
- **project-initiative-background-context.test.mjs** (fake provider captures request bodies):
  - The first worker request has a `project-brief` context before the task and a `project-evidence` without any dropped key.
  - Evidence turns appear as `{evidence}` references.
  - Two consecutive runs' requests are byte-identical up to and including the brief block.
  - `job.briefStats` is set.
- **project-initiative-continuity.test.mjs:**
  - recentTurns references become `E#` in the request.
  - recentConversation excludes those turns.
  - Receipts are slim for eligible actions and full for cancelled ones.
  - `handoffs` is absent.
  - `summary` is dropped only when eligible.
  - schedules are sent once.
  - `undone` survives.
- **packages/sdk/test** (extend initiative-work-coverage.test.mjs or initiative-contract.test.mjs, following the existing hostConditions test at :203-227):
  - Toggling each of `ask.pending`, `share.reach.quietNow`, `share.reach.notificationsMuted`, `communicationPolicy.notificationMuted` and `work.permissions.effective` leaves the request bytes identical up to `events`.
  - `withConditions` restores them for validation.
  - `receiptEligible` is used by tick.
- **prompt-cache-prefix-sharing.test.mjs:** the foreground and background shared prefix stays identical when `initialContextTail` is used.

### 4.5 Accuracy gates (no accuracy trade)
- **Decision replay** (main model; needs user approval to spend tokens, ~50K per case). Run the same labelled decision states before and after §4.2 and §4.3 phase 1 on ≥20 live states (novel and AI, including schedule-bearing ones). Compare:
  - action agreement;
  - `invalid_decision` rate;
  - unknown-evidence citation errors.

  Ship only with no regression.
- **Worker** (§4.1). Compare a few before and after runs on the same actions (user-approved), and monitor after shipping from `project.jobs`:
  - handoff present;
  - `needs_review` rate;
  - `work.coverage` not-admitted rate.

### 4.6 Measure after shipping
- **Wake history `prompt.chars` median.** Novel ≈100–120K and AI ≈88–109K today; expect −11–17K.
- **Ledger initiative uncached per paid decision.** 30.0K today; expect −3–6K.
- **Background-work first-request uncached median.** 34.4K today; expect −7–12K real tokens. `briefStats` attributes it.
- **Later-step cacheRead median.** 90.2K today; expect −7–12K.
- **`divergedIn` starting `hostActionContracts.`.** Expect 0 except plan mode.

### 4.7 Risks
- **A worker loses context it used**, for example what was already delivered. Kept: receipts, handoffs, continuity, workspaceEvents and the mind attachment; the outcome metrics above are the guard.
- **Dangling `{evidence}` references.** Computed from the live event set; tested.
- **Drift between the host and SDK receipt predicate.** Removed by exporting the predicate.
- **The single wording change** (schedule scope). It is in the replay.

---

## 5. Partition, sequencing, P0 overlaps

**Implementer A — item 1:**
- packages/sdk/src/project-genome.mjs, index.mjs, index.d.ts
- prototypes/control-center/project-genome-store.mjs
- rna-runtime.mjs:55-57,150
- project-initiative-controller.mjs:579,2165 only
- project-genes.mjs:262-270
- project-initializer.mjs:210
- project-skill-foundation-service.mjs:188-189
- new genome-identity.mjs
- store.mjs (one call after :523)
- tests, benchmark/prefix-miss-attribution.mjs, docs/specs/project-genome-lifecycle.md

Must merge after P0 #1 (scope split).

**Implementer B — items 3 and 2:**
- decision-service.mjs
- packages/sdk/src/decision-templates.mjs, decision-state.mjs
- project-initiative-controller.mjs: pump :968-1080, wakeOutcome :146, helpers next to :483, :762 sharedPrefix removal, import :14
- providers.mjs comment only
- tests, benchmark/initiative-lease-probe.mjs, benchmark/initiative-lease-report.mjs, docs/research probe note

**Implementer C — item 4:**
- project-initiative-controller.mjs: helpers :89-178, snapshot :587-645, `snapshot()` arguments at :762 and :1043, work() :2257-2340 (including item 1.2.5's version pin)
- packages/sdk/src/initiative.mjs: :236-274, :789
- rna-runtime.mjs:302-304
- tests

**Shared lines:**
- B and C both touch the line at controller :762 (B removes `sharedPrefix`; C adds `eventIds` and `liveActions`) and the pump around :1043. Land B first, then C rebases.
- A's controller edits are two one-line call-site changes.

**P0 overlaps:**
- The scope split edits controller `scope()`, `valid()` and `invalidate()` (:203-233, :454-470). It is adjacent to B's pump edits.
- Deliveries (F1) edits the action_completed excerpt and narrator (controller ~:2305 onwards, proactive-narrator.mjs). It is adjacent to C's work() edits.
- PDL-4 (if assigned separately) shares `wakeOutcome` and pump :1034 with B.

**Contracts, versions and docs:**
- docs/specs/stream-protocol-v2.md §变更记录 needs entries for:
  - stable genome names and the one-time migration;
  - JEV `initiative.review` v3 `in_progress_covers` and the ledger reasons `foreground_lease` / `bypass_*`;
  - decision snapshot reference forms;
  - hostConditions additions.
- docs/specs/project-proactive-system.md documents the lease and the worker brief.
- SDK 0.52.0, app 0.66.x.
- No new user-facing text is added. Any host line added later uses `inLanguage(interfaceLanguageOf(state), …)`.

## 6. Expected weekly savings (at 09-28→10-04 volume)

| item | uncached input | cache reads | output |
|---|---|---|---|
| 1 stable names | −0.9 to −1.5M foreground per week at the observed generation rate; 0 while evolution is idle; scales with generations × live session context | fewer authorization copies in long histories | — |
| 2 shared prefix | 0 (avoids +8–12M cached if enabled) | — | — |
| 3 foreground lease | −3.4M recorded, plus ~1.7–2.5M billed-but-unrecorded aborts | −0.8M | −0.7M |
| 4a TC-3 decisions | −1.5 to −3.5M | — | — |
| 4b TC-2 workers | −1.2 to −2.4M | −22 to −38M | — |
| 4c PDL-5 | ≈0 now on git projects; 2–4K per avoided plan-mode or question-card flip | — | — |

## Files
- packages/sdk/src/project-genome.mjs
- packages/sdk/src/index.mjs
- packages/sdk/src/index.d.ts
- prototypes/control-center/project-genome-store.mjs
- prototypes/control-center/rna-runtime.mjs
- prototypes/control-center/project-genes.mjs
- prototypes/control-center/project-initializer.mjs
- prototypes/control-center/project-skill-foundation-service.mjs
- prototypes/control-center/genome-identity.mjs (new)
- prototypes/control-center/store.mjs
- prototypes/control-center/project-initiative-controller.mjs
- prototypes/control-center/decision-service.mjs
- packages/sdk/src/decision-templates.mjs
- packages/sdk/src/decision-state.mjs
- packages/sdk/src/initiative.mjs
- packages/sdk/src/providers.mjs (comment only)
- prototypes/control-center/benchmark/prefix-miss-attribution.mjs (new)
- prototypes/control-center/benchmark/initiative-lease-probe.mjs (new)
- prototypes/control-center/benchmark/initiative-lease-report.mjs (new)
- prototypes/control-center/test/project-version-runtime.test.mjs
- prototypes/control-center/test/project-genome-store.test.mjs
- prototypes/control-center/test/gene-tree.test.mjs
- prototypes/control-center/test/prompt-cache-prefix-sharing.test.mjs
- prototypes/control-center/test/project-initializer.test.mjs
- prototypes/control-center/test/genome-identity-migration.test.mjs (new)
- prototypes/control-center/test/decision-service.test.mjs
- prototypes/control-center/test/project-initiative-lease.test.mjs (new)
- prototypes/control-center/test/project-initiative-controller.test.mjs
- prototypes/control-center/test/project-initiative-background-context.test.mjs
- prototypes/control-center/test/project-initiative-continuity.test.mjs
- packages/sdk/test/project-genome.test.mjs
- packages/sdk/test/decision-templates-valid.test.mjs
- packages/sdk/test/decision-templates.test.mjs
- packages/sdk/test/initiative-work-coverage.test.mjs
- docs/specs/stream-protocol-v2.md
- docs/specs/project-genome-lifecycle.md
- docs/specs/project-proactive-system.md

## Probes needed
- JEV labelled probe for initiative.review v3 `in_progress_covers`.
- Build cases with benchmark/initiative-lease-probe.mjs from the live in-turn cases: novel 39 decisions + 37 aborted rows, test 4+5, 3d 12, AI 13, plus the 24 novel decisions made during running background actions.
- Keep only cases with independent evidence; a human labels each defer or wake.
- Run them through the live POST /api/v2/decision-kernel/probe.
- Choose the stake from the distribution.
- Record it in docs/research/jev-initiative-lease-probe-<date>.md.
- JEV cost only; needs user approval to run.
- Decision replay, main model (user approval required, ~50K tokens per case).
- Set: ≥20 live decision states (novel and AI, including schedule-bearing ones).
- Before/after: TC-3 dedupe, the schedule-scope wording change, and PDL-5 phase 1.
- Compare: action agreement, invalid_decision rate, unknown-evidence citation errors.
- Worker outcome check for TC-2 (user-approved main-model runs on a few actions, or post-ship monitoring of project.jobs).
- Handoff present.
- needs_review rate.
- work.coverage not-admitted rate.
- Post-ship ledger measurement, no model cost:
- benchmark/prefix-miss-attribution.mjs: item 1 KPI = uncached input on prefix changes within 40 min after a skills-only generation.
- benchmark/initiative-lease-report.mjs: in-turn paid and aborted initiative rows per day, decisions per user turn.
- Wake history prompt.chars and divergedIn from GET /api/v2/projects/:id/mind.
- Background-work first-request uncached and later-step cacheRead medians.
- Optional, not recommended: a one-time GLM tool_choice:'none' check.
- 3 tiny requests, under 2K tokens.
- Would need a new daemon-internal command so the key stays in the app.
- User approval required.
- Not needed: Zhipu and Z.AI docs state that only 'auto' is supported.

## Open questions
- Item 2: removing `sharedPrefix` from the initiative coordinator (controller:762) also turns sharing off for verified DeepSeek, which had 2 decisions in 7 days.
- The analysis says sharing can only add tokens for this request shape.
- Confirm the removal rather than leaving the dormant path. Once Anthropic tool_choice none lands, that path would auto-enable for Claude.
- project-learning-controller.mjs:180 has the same wiring. Same treatment?
- Item 1 is sequenced after the P0 scope split. Without that split, the one-time migration (assignments and state.capabilities change) rotates every project's initiative scope, wipes receipts and deletes memory evidence (PDL-1). Confirm the merge order.
- Item 3 fail policy: when JEV abstains or is unavailable during a lease, the spec fails open (wake, today's cost). The alternative is holding until the turn ends (cheaper, but delays reaction). Confirm fail-open.
- Item 3 resolves a conflict between the corrected fixes:
- Only `needs_review` stays a JEV bypass.
- Queued or running actions now go through the gate (PDL-2 #3), not the bypass that TC-1 (background) kept.
- deliveryJustCompleted is judged rather than bypassed during a foreground lease.
Confirm.
- Item 4: the worker brief drops `communication` (what was already delivered) and the schedule views. Accept, subject to the outcome monitoring, or keep a slim `recentDeliveries` (3×600 chars) for workers?
- PDL-5 phase 2 (level-independent wording for work.authorization and work.scope) is deferred: since 0.63.3 there are 0 hostActionContracts.work divergences. Agree to re-measure on 0.66 wakes before doing it?
- Pre-existing, not in scope: minimizeDecisionState spends its 8,000-char budget on userMessage (2,400) and evidence before built roots such as `review`. The initiative gate's `review` may already be truncated on busy projects. Should someone check this with a probe?
- For P1 item 4 (reasoning effort): the Z.AI docs give GLM-5.3 reasoning_effort default = max. For GLM, 'use the provider default' is therefore max, so JEV routing is the only way to lower internal effort there.