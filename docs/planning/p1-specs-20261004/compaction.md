# Implementation spec — Cold-break context economy (0.66 / SDK 0.52)

Covers: user decision 3 (idle + >50% window → background compaction), TC-2 (fold superseded keyed context), TC-4 (settle/forget only at cold breaks), TC-5 (step-limit summary keeps system+tools), TC-6 (compaction request reuses the cached prefix), MIND-6 (stable vs per-turn mind context, `usedAt`, collaboration only new entries). All line numbers are against main `cd6a9d0`.

One rule ties them together: **Rna edits or replaces model history only at a cache break that is already cold, or when a compaction trigger is about to break the cache anyway. Generating a summary never blocks a turn.**

---

## 0. Evidence (live data, read-only, 2026-10-04)

Method: copied ledger and journals to the scratchpad, replayed the journals with the SDK's own `prepareContext`, and joined each request to the usage reported on its response.

### 0.1 GLM cache survival (the basis for "idle a long time")

- Criterion: same session, same `prefixHash` and model, and this request's projected messages are a byte-exact extension of the previous request's (continuous). Samples where the previous prompt was ≥ 20K tokens, all 8 foreground journals.
- glm-5.3, gap → share of previous prompt served from cache:

| Gap | Warm samples | Cold samples |
|---|---|---|
| <1 min | 1340 | 7 |
| 1–3 min | 105 | 1 |
| 3–5 min | 38 | 0 |
| 5–10 min | 19 | 0 |
| 10–15 min | 9 | 0 |
| 15–20 min | 6 | 0 |
| 20–30 min | 1 | 1 (25.7 m) |
| 30–45 min | 5 | 1 (38.1 m) |
| 60–90 min | 1 (60.4 m) | 0 |
| 90–120 min | 1 (107.1 m) | 0 |
| ≥120 min | 0 | 5 (137.3, 194, 360.7, 719.5, 857.8 m) |

- The distribution is bimodal: 0 of 1,745 continuous samples fall between 0.1 and 0.9.
- So for glm-5.3: largest warm gap 107 min, smallest cold gap above it 137 min. Learned "cold after" = **137 min**.
- The ledger alone cannot show this. Its `prefixKey` hashes the project `cacheScope`, not the session (usage-cache-service.mjs:18), and history rewrites count as misses. In the ledger, 15 of 22 rows at 15–20 min look like misses.
- `cacheTtlMs` returns null for GLM (usage-cache-service.mjs:12-17).

### 0.2 Novel session 4ed897f8 (glm-5.3, 1M window)

- Current state: idle since 10-02 18:46 (last request read 578,496 cached).
  - Store: `context.tokens` 578,867 = 58% of the window; `inputTrigger` is 767,232.
  - One earlier compaction on 09-30 20:30: 772,886 → 131,935 tokens. The summary was 2,996 chars and the request cost 848,065 uncached input + 6,858 output, in 104 s.
- Last 3.5 days: 853 foreground requests, 13.70M uncached input and 341.2M cache reads.
  - 8 idle gaps exceeded 137 min. Each first request after one was a full miss of 0.42–0.68M uncached.
- First-token latency (journal: request_started → first delta):
  - cold ≥400K: p50 24 s, p90 35 s;
  - cold 100–400K: p50 13 s;
  - warm: p50 5–6 s.
  - turn.timing.request after the 10-02 idle break was 32.5 s.
- Projection now: 2,467,835 bytes.
  - Superseded keyed copies are 630,643 bytes (25.6%). By key: project-mind 31 copies, working-state 22, collaboration 21, skill-catalog 14, user-feedback 17, authorization 14.
  - Folding them gives 578.9K → **393.5K tokens (−32%)**.
- Idle compaction now, keeping the last real user turn verbatim:
  - after: ≈32–34K message tokens + system/tools (≈12–20K) ≈ **35–50K**;
  - summary source: 550K flattened tokens (×0.88 calibration from the 09-30 compaction: estimate 963K vs reported 848K);
  - keeping 2 user turns instead: ≈126–129K after, 463K source.
- MIND-6, post-boundary (31 turns):
  - project-mind copies are 226.5 KB.
  - A three-key split (rules / notes / per-turn) re-sends rules 8×. Total 116 KB (**−49%**).
  - project-collaboration: 21 copies, 87.3 KB. As per-entry keys: 30.4 KB (**−65%**).

### 0.3 Counterfactual over the novel's 853 requests

Same requests and timeline, policy applied, cold gap = 137 min:

| World | Uncached | Cache reads | Weighted (cache read 0.2, output 4) |
|---|---|---|---|
| A, today (reproduces the ledger within 0.8%) | 13.81M | 341.1M | — |
| B, idle compaction only | 8.24M (−40%) | 248.1M (−27%) | −29% |
| C, fold at cold breaks only | 11.23M (−19%) | 299.3M (−12%) | −13% |
| F, full design (idle compaction + fold + settle/prune at cold breaks) | 8.55M (−38%) | 255.6M (−25%) | −27% |

- Sensitivity (cold gap 107/240 min, summary 3K/12K chars, keep 1/2 turns): B between −26% and −30% weighted. The combined result moves between −22% and −41% depending on whether a fold keeps the context just under 50% at a break.
- 3D game 01d4dc84 never crossed 50%. Fold + settle at cold breaks alone: uncached −42% (3.01M → 1.76M), cache reads −41% (119.8M → 70.8M).
- At the novel's activity level, the full design is ≈ **−10M uncached and −170M cache-read tokens per week**.

---

## 1. Work package A — cache survival estimate (prerequisite)

### A1. SDK: structural continuity and ledger metadata (session.mjs)

- Assistant messages already carry `contextPrefixHash`, `contextCompactionId`, `contextForgetSeq`, `contextImageOffloadId`, `model`, `provider`, `timestamp` (request start) and `usage` (session.mjs:762).
- Add `contextHistoryImages`: a stable signature of `ctx.imageHistory` keys, i.e. the sorted message-id/index pairs that planHistoryImages turned to text.
- New pure helper, `packages/sdk/src/cache-survival.mjs`:

```js
export function structuralContinuity(prev, cur) // prev: last assistant message with usageReported && contextPrefixHash
  // true iff prefixHash, model, provider, compactionId, forgetSeq (fold/settle/forget/prune all bump it),
  // imageOffloadId and historyImages signature are all equal
```

- In `request()`, just before `iterateCompletion` (session.mjs:773), set:

```js
requestOptions.ledger = {
  continuity: prev ? { continuous, gapMs: clock() - prev.timestamp,
                       previousPromptTokens: prev.usage.input + prev.usage.cacheRead + prev.usage.cacheWrite } : null,
  ...(trigger ? { trigger } : {})
}
```

  Compaction requests pass `ledger: { trigger }`.
- New `createSession` option `clock = Date.now` (test seam).
- Property test, required: for every projection path (append, steer, tool result, context update) a structurally continuous projection is a byte-prefix extension of the previous one. Edits (fold, settle, forget, prune, compaction, image offload, model change) must break structural continuity. This is why structural continuity is enough (no per-message digests).

### A2. Ledger rows (usage-cache-service.mjs)

- `meteredProvider` (lines 112-126) reads `request.ledger` in `finally` and passes `continuity` and `trigger` to `ledger.record`.
- `usageRecord` (lines 30-37) keeps:
  - `continuity: { continuous: bool, gapMs: int ≥ 0, previousPromptTokens: int ≥ 0 }`, validated;
  - `trigger ∈ {'idle','after_response','before_request','overflow','manual'}`, compaction rows only.
- `UsageLedger.remember` (line 48) also keeps `lastSession: Map(sessionId → { at, providerId, modelId })`, skipping `CACHE_EXEMPT_PURPOSES`.
- New method `lastSessionRequest(sessionId)`. Its `at` is the end of the response, which makes idle decisions conservative.
- TC-8 (P1 item 8) owns the full miss-cause telemetry. This row contract is the shared part; whoever lands first defines it as written here.

### A3. Survival store and estimator

New `CacheSurvival` class in usage-cache-service.mjs; pure math in `packages/sdk/src/cache-survival.mjs`.

- File: `${stateFile}.usage-cache.survival.json` (mode 600, atomic write, debounced). It holds derived observations, so state-checkpoint.mjs `excludedSibling` (line 131) is extended:

```js
/^\.usage-cache(?:\.survival\.json|\.jsonl)(?:\.\d+\.tmp)?$/
```

  This avoids `checkpoint_unknown_sidecar` (deploy gotcha 0.43.0). Extend test/checkpoint-sidecar-inventory.test.mjs.
- `observe(row)` is called from `UsageLedger.record`. Store a sample only when:
  - `row.continuity?.continuous === true`, `row.cacheReported`, `gapMs ≥ 60 s`;
  - sample = `{ gapMs, warm: row.cacheRead ≥ 0.5 × previousPromptTokens, prompt: previousPromptTokens, at }`;
  - keyed by `providerId|modelId`; samples kept for 30 days.
- Why these numbers:
  - Under 1 min, 1340 of 1347 samples are warm, so short gaps carry no information.
  - 0.5 is the middle of the empty band (0.1–0.9) in the bimodal distribution, not a tuning knob.
  - 30 days is an evidence window, like the ledger's 7 days.
- `survivalFromSamples(samples, { now })`:
  - `minWarmPrompt` = minimum `prompt` among warm samples. Cold samples below it are dropped (provider minimum cacheable size).
  - `warmMax` = maximum gap among warm samples.
  - `coldAfterMs` = minimum gap among cold samples with `gapMs > warmMax`, or null.
  - Returns `{ coldAfterMs, warmMaxMs, samples }`.
- `estimate(model)`:
  - if `cacheTtlMs(model)` is non-null and `warmMax ≤ ttl` → `{ coldAfterMs: ttl, source: 'documented' }`;
  - else the learned value, `source: 'learned'`;
  - if both are null, there are no idle actions for that model.
- Cold samples below `warmMax` (provider-side evictions, e.g. 25.7 m and 38.1 m) never lower the estimate. This is conservative by construction.
- One-time backfill at service start, when `backfilledAt` is absent:
  - add `export function* readJournalRecords(file)` to journal.mjs: O_RDONLY, no lock, wraps `verifiedRecords`;
  - iterate `${stateFile}.rna/<sessionId>/*.rna.jsonl`, skipping `initiative/`;
  - yield to the event loop every 20 ms (same slicing as replay, session.mjs:50);
  - build samples from consecutive `request_completed` assistant messages with `structuralContinuity`;
  - expected on today's data: glm-5.3 cold after 137 min.

### A4. Exposure

`aggregateCacheUsage` (lines 90-102) adds:

```js
cacheSurvival: { '<providerId>|<modelId>': { coldAfterMs, warmMaxMs, documentedTtlMs, samples, source } }
byPurpose.compaction.byTrigger: { <trigger>: { requests, input, output } }
```

---

## 2. Work package B — SDK economy point, fold, scopes (TC-2, TC-4)

### B1. Context scope

- `addContextUpdate` (session.mjs:236-242) accepts `update.scope ∈ {'conversation' (default), 'window', 'turn'}`. It stores `message.contextScope` only when not 'conversation'.
- Validation in the request-hook branch (line 734) and `initialContext` (line 174, always conversation). Raise the per-hook update cap from 16 to 64; the 256 KiB byte cap is unchanged. Per-entry collaboration keys and the three mind keys push a turn past 16.
- Compaction restore (context.mjs:74-78) adds `&& !['window','turn'].includes(message.contextScope)`.
- Meaning of each scope:
  - **conversation**: latest wins; restored at compaction.
  - **window**: not restored; the host re-offers while relevant; folded only when superseded.
  - **turn**: not restored; folded at the first cold break after its turn. "After its turn" = a later turn-start user message exists: role user, `source ∈ {'user','followUp'}`.

### B2. Visible-revision dedupe

- `contextRevisions` (built at line 173) dedupes against the latest copy, even after compaction hides that copy. Fix: after replay and after any `context_compaction`, rebuild the map from visible copies only — post-boundary copies plus restored ones.
- Then a window-scoped key whose last copy fell behind the boundary is appended again when the host offers it. Conversation keys are restored, so they stay deduped.
- Do not dedupe against older revisions (the A,B,A case). TC-2's corrected fix explains why: the model must see the current value last.

### B3. Fold (`context_fold`)

- New journal record:

```js
{ id, reason: 'prefix_change'|'model_change'|'idle'|'compaction', targets: [{ messageId, contextKey }], at }
```

- Replay (session.mjs:66-127) adds `state.folded = Map(messageId → { contextKey, seq })` and shares `forgetSeq`, so `contextForgetSeq` breaks structural continuity.
- Targets, computed at the economy point over the current messages:
  - (a) every `source:'context'` message whose `contextKey` has a later copy, including restored copies from before the boundary;
  - (b) every turn-scoped context message that belongs to an earlier turn;
  - never the latest copy of a conversation or window key.
- `prepareContext` (context.mjs:62, new `folded` input):
  - a folded message keeps its role and lead text;
  - its attachment becomes one line, no label: `[Superseded: a later update of "<key>" appears further down; use the latest one.]`;
  - add `folded` to the `changed` set in the anchor estimate (context.mjs:135-141), so `estimatedInputTokens` drops right away.
- This is the latest-wins contract compaction restore already applies. It adds no new semantics. No delta encoding (TC-2 corrected fix (b)).
- Event: `context_economy { reason, folded, settled, pruned, forgotten, preparedCommitted, freedTokens }`.

### B4. Economy point (first request of every run)

- `runLoop` (session.mjs:854) sets `economyDue = true`.
- `request()` runs `economyPoint(signal)` once, after the `beforeRequest` block (after line 741, before `prepareRequestImages()` at 745). By then this run's tool and context updates are in.

```js
const last = lastServedAssistant();            // usageReported && contextPrefixHash
if (!last) return;
const ctx = context();
const reason = ctx.cache.prefixHash !== last.contextPrefixHash ? 'prefix_change'
  : (last.model !== selected.modelId || last.provider !== selected.providerId) ? 'model_change'
  : (cacheSurvivalMs != null && clock() - last.timestamp > cacheSurvivalMs) ? 'idle'
  : ((last.contextCompactionId ?? null) !== (state.compaction?.id ?? null)) ? 'compaction' : null;
if (reason && state.preparedCompaction) commitPrepared(reason);   // C5; projection is rebuilt
if (!historyEditsAllowed(selected)) return;                       // B7
const plan = economyPlan();                                       // settle + prune (deterministic), fold targets, forget (B5)
if (reason) commit settle/prune/forget/fold, each when it frees anything
else if (settle+prune+forget frees ≥ SETTLE_SHARE × ctx.estimatedInputTokens) commit those three (no fold)  // today's warm rule
```

- New `createSession` option `cacheSurvivalMs` (number|null, default null).
- A `beforeRequest` change may also return `cacheSurvivalMs`.

### B5. Settle/forget relocation (TC-4)

- Remove the after-run `settleWrites` call (session.mjs:931-932).
- `settleWrites` (605-641) becomes `economyPlan().settle/prune`. Same targets (outside the last two real user turns), same `SETTLE_MIN_BYTES`, same records (`context_settle`).
- Forget (`forgetSuperseded`, 571-596):
  - the JEV call starts at `runLoop` start in parallel with `beforeRequest`, which already waits for routing (≤900 ms) and the mind context;
  - the economy point awaits it within a 1200 ms budget (`PREFLIGHT_BUDGET_MS`); if it isn't ready, skip forget this time;
  - this replaces the after-run work, which sits on the turn-completion path anyway because handles are disposed at turn end.
- `compactAutomatically` (642-677), both deferred and blocking triggers, now runs in this order before any summary:
  1. prepared compaction (C5);
  2. economies with any positive saving (settle + prune + forget + fold), because the cache is about to break;
  3. a summary only if still above the threshold.

  This keeps today's property that settle can prevent a compaction.

### B6. Background and other purposes

- Hosts that don't pass `cacheSurvivalMs` (initiative, subagents) get cold breaks only on prefix/model/compaction changes.
- The initiative cache-aligned wake (project-initiative-controller.mjs:1032) can later use `CacheSurvival.estimate`. That is a follow-up: the file is P0-owned.

### B7. Anthropic gate (TC-3 dependency)

- `historyEditsAllowed(model)` = `model.protocol !== 'anthropic' || model.historyEdits === 'drop_block'`. The flag is set by the TC-3 implementation.
- Until then, Anthropic sessions get no fold/settle/forget at economy points and no idle compaction. The documented 5-min TTL would otherwise trigger them constantly, and every edit is a preserved-thinking 400.

---

## 3. Work package C — SDK prepared (detached) compaction

The summary is generated with no journal lock held. It is committed later by whichever session handle meets a cold break first.

### C1. Journal records (additive; older SDKs ignore unknown types — replay has no else branch)

- `compaction_prepared`:

```js
{ id, trigger: 'idle', previousCompactionId: string|null, throughMessageId, sourceDigest, summary,
  archivedMessages, retainedMessages, requestId, usage, usageReported, model: { providerId, modelId },
  startedAt, completedAt, beforeTokens }
```

  Replay: `state.preparedCompaction = data`; push the usage into `state.compactionUsage`, deduped by `requestId`.
- `compaction_prepared_discarded { id, code: 'stale_base'|'not_smaller'|'superseded' }` — replay clears it.
- `context_compaction` gains `trigger` and optional `preparedId`. `compaction_request_started` gains `detached: true` only on the path that never ran inside a session.

### C2. Plan: `handle.prepareCompaction({ keepUserTurns = 1, instructions = '' })`

- Idle only: no active run, no pending/uncertain calls, empty inbox, no continuation or boundary request. Writes nothing.
- Candidate: `idleCompactionCandidate(messages, { previousCompaction, keepUserTurns, maxSourceTokens: window − maxOutput − 1024 })`.
  - It is `automaticCompactionCandidate` (context.mjs:225) with `before` = index of the `keepUserTurns`-th last turn-start user message.
  - Complete groups only. When the source exceeds the budget it picks the largest prefix that fits (partial; the next idle cycle continues).
- Returns:

```js
{ previousCompactionId, throughMessageId, sourceDigest, archivedMessages, retainedMessages, beforeTokens,
  request: summaryRequest(candidate, instructions) }
```

  `summaryRequest`, session.mjs:517: move it and `summaryPrompt` (515) to context.mjs as exported `SUMMARY_PROMPT` / `summaryRequestFor`.
- Why keep the last real user turn instead of 2 groups: the user asked for continuity ("保持写作连续性"). For the novel this keeps ≈25K tokens of the latest exchange verbatim. After compaction the context is ≈35–50K, versus ≈126K when keeping 2 turns.

### C3. `generateSummary` (new `packages/sdk/src/compaction-request.mjs`)

```js
generateSummary({ provider, model, apiKey, request, maxOutputTokens, signal, redactValues, ledger })
  → { summary, usage, usageReported, requestId, startedAt, completedAt }
```

- Extract the stream loop of `generateCompaction` (session.mjs:539-547) unchanged: reject tool calls, `stopReason 'length'`, empty output and anything over 128 KiB. Redact with `createRedactor`.
- `generateCompaction` calls this helper.

### C4. Sidecar hand-off

- The host writes the result to `${sessionFile}.idle-summary.json` (mode 600, atomic, inside `.rna/<sessionId>/`). Session deletion purges it with the directory. No new state sidecar.
- `createSession` (option `preparedCompactionFile`, default exactly that path) consumes it at open:
  1. read and validate the shape;
  2. append `compaction_prepared`;
  3. only then unlink the file.

  A crash between steps 2 and 3 is idempotent because replay dedupes by `id`.

### C5. Commit: `commitPrepared(reason)` and `handle.commitPreparedCompaction()`

- Valid when all of:
  - `(state.compaction?.id ?? null) === p.previousCompactionId`;
  - `throughMessageId` exists after the previous boundary;
  - `digest({ previousSummary, messages: archivedSlice }) === p.sourceDigest` — the same definition as automaticCompactionCandidate (context.mjs:255);
  - the projected `heuristicTokens` shrinks (same check as session.mjs:551).
- On success append `context_compaction` with `{ ...p, trigger: 'idle', preparedId: p.id, automatic: true, afterTokens }` and emit `auto_compaction_end`.
- Otherwise append `compaction_prepared_discarded`.
- Commit points:
  - (i) economy point on a cold break;
  - (ii) `compactAutomatically` step 0;
  - (iii) `handle.commitPreparedCompaction()` on an idle handle — the host's brief maintenance claim.
- Never on a warm break. Even a mistaken warm commit is net-positive whenever `after < cacheRatio × before` (50K uncached < 578K × 0.2), so misestimating survival is cheap.

### C6. `handle.offerCompaction(prepared)`

- Any phase. Appends `compaction_prepared` (single-threaded append; it only closes an open stream segment) and sets `state.preparedCompaction`. It does not change the projection.
- Used when the summary finishes while a turn runs.

---

## 4. Work package D — host `IdleCompactionService` (new idle-compaction-service.mjs)

### D1. Wiring (server.mjs, next to line 150)

```js
new IdleCompactionService(store, { executor, ledger: store.usageLedger, survival, decisions, gate: maintenanceGate, factory: createSession })
```

- Add `idleCompaction.inFlight.size` to `hasOtherActiveWork` (line 251).
- Close it in `RuntimeController.close` (1495-1507) or in the server shutdown path.

### D2. Trigger loop (event-driven, no polling interval)

- Subscribe to the store (`display:false`, coalesced with `setImmediate` like runtime-controller.mjs:191-195) and to `ledger.record`.
- For each candidate session:

```js
dueAt = (ledger.lastSessionRequest(id)?.at ?? last turn completedAt) + survival.estimate(lastModel).coldAfterMs
```

- Keep one `setTimeout` (unref) for the earliest `dueAt`. Re-plan on any change. Run one generation at a time globally (resource scheduling, not a frequency cap).

### D3. Eligibility at `dueAt` (all computed in code)

- `settings.idleCompaction !== false`.
- `!state.emergency`, `!gate.held`.
- Session: `kind === 'main'`, `runtime.engine === 'rna'`, `sessionFile` exists, not archived, project not archived, not in `state.sessionDeletions`, no `appRecovery.required`.
- `status === 'idle'`, `!activeTurnId`, not in `executor.running` or `executor.maintenance`, not in `memorySync.drainingSessions`.
- `(context.usage?.estimatedInputTokens ?? context.tokens) ≥ 0.5 × (context.usage?.capacity ?? modelConfig.contextWindow)`.
- `now − lastRequestAt ≥ coldAfterMs`, where `coldAfterMs` is non-null.
- `historyEditsAllowed(model)` (B7).
- `realBudgetRemaining(state) > estimatedInputTokens + maxOutputTokens`.
- No prepared compaction pending (`session.context.idleCompaction.status !== 'prepared'`).
- The model is configured (`resolveModel(configuration, session.modelSelection)`).

### D4. Flow and concurrency

1. **Plan.**
   - `executor.runMaintenance(id, signal => …)` (runtime-controller.mjs:452).
   - Open a bare `createSession({ sessionId, projectId, cwd: stateDir, stateDir, sessionFile, model, tools: [] })` (same pattern as rewind, line 824); `prepareCompaction({ keepUserTurns: 1 })`; dispose.
   - The claim lasts about the journal open time: live `turn.timing.journal` is 116–146 ms for the 37 MB novel journal.
   - If `prepareCompaction` returns null, mark `skipped`.
2. **JEV shadow** `session.resume` (D7). Record only; never gates in v1.
3. **Generate**, with no claim and no lock:
   - reserve budget (key `idle-compaction:<sessionId>:<requestId>`);
   - provider = `meteredProvider(streamCompletion, { ledger, purpose: 'compaction', projectId, sessionId })` with `request.ledger.trigger = 'idle'`;
   - reasoning = the decision-2 internal-purpose policy if it exists, else the session's;
   - set `session.context.idleCompaction = { status: 'preparing', requestId, at }`.
4. **Persist** to the sidecar (C4). Set `status: 'prepared'`.
5. **Commit**:
   - idle and still cold → `runMaintenance(commit)`: bare open (consumes the sidecar) → `commitPreparedCompaction()` → dispose → store update (D5);
   - a turn is running → `executor.running.get(id)?.handle?.offerCompaction(sidecarContent)`, then unlink; if no live handle, leave the sidecar for the next open;
   - idle but warm, because a turn ran meanwhile → reschedule the commit at `lastRequestAt + coldAfter`.
- Guarantees:
  - A user turn never waits for the summary. While the summary is generated, `executor.maintenance` holds nothing for the session, so pump (runtime-controller.mjs:445) starts the turn at once and it runs uncompacted, with fold/settle applied at its cold economy point.
  - Only a turn that arrives during a ~0.2 s claim waits. Pump aborts the claim (413-416); an aborted commit leaves the sidecar for the turn's own handle, whose economy point commits it on that cold break.
  - The turn's handle uses a generation that finished mid-turn at its deferred trigger, or at the next cold break. It never pays twice unless the deferred 80% trigger fires before the summary is ready.
- Other actors:
  - **Deletion**: `drainMaintenance` (459-464) also aborts and awaits this service for the session. Deletion already calls it (session-deletion.mjs:111).
  - **Rewind**: in `rewind()` after `memorySync.drainSession` (runtime-controller.mjs:821), call `await this.idleCompaction?.quiesce(sessionId)`. A prepared summary that rewind made stale is discarded at commit (`stale_base`).
  - **Manual /compact** (session-command-service.mjs:196 `compact`): quiesce first. Then call `handle.commitPreparedCompaction()`; if it reports a valid prepared summary, use it as the first batch, else discard and run as today.
  - **Emergency, maintenance gate held, archive**: abort generation (the provider bills partial input; acceptable, and it frees the drain).
  - **Restart**: an in-memory 'preparing' is stale; re-plan (pays again; rare). 'prepared' survives in the sidecar or journal.
- **Worktree conversations**: the journal is independent of S→P hand-back (afterTurn, 1255-1268, never opens the journal). The real interaction is that per-turn worktree notes are restored at every compaction. Fixed by scope 'turn':
  - `worktree-start-sync:<turnId>` and `worktree-markers:<turnId>` (runtime-controller.mjs:1174);
  - `turn-route-hints` (247), `user-feedback` (252), `turn-steering` / `turn-rewind` (turn-watch.mjs:78,87);
  - `stopped-background` (270), `continued-task:*` (272);
  - `workspace-reversions` stays conversation (designed to restore its settled value).
- **Memory checkpoints**: memory writes read Store items, not the SDK journal (store.mjs:1309; memory-sync.mjs), so there is no coupling. Only skip sessions in `drainingSessions`.
- **journal-compaction.mjs**: offline telemetry merge, CLI only (journal-maintenance.mjs). It renumbers seqs, so prepared validation uses message ids and `sourceDigest`, never seq.

### D5. Store, notice, accounting

- On commit, in `store.mutate`:
  - `session.context.compactions++`, `lastCompactionId`;
  - delete `context.usage` and set `measurementScope = 'maintenance'` (same as session-command-service);
  - `idleCompaction = { status: 'committed', at, beforeTokens, afterTokens }`.
- Add a notice item (`source: 'idle-compaction'`) via `inLanguage(interfaceLanguageOf(state), …)`:
  - zh: 「这个对话空闲期间，已在后台把较早的上下文整理成摘要，下一轮会更快开始；原始记录和完整的工具结果都还保存在会话日志里。」
  - en: "While this conversation was idle, earlier context was summarized in the background so the next turn starts faster; the original record and full tool results are still in the conversation log."
- A commit inside a running turn emits `auto_compaction_end` with `result.trigger === 'idle'`. runtime-controller.mjs:776-777 shows the same text for that trigger.
- Budget: charge actual usage, as session-command-service.mjs:230-240.

### D6. Runtime-controller hooks (owned by the host implementer)

- Factory options (around line 955): `cacheSurvivalMs: this.survival?.estimate(turn.modelConfig).coldAfterMs ?? null`.
- `drainMaintenance` + `rewind` quiesce (D4).
- Scope flags on the hints listed in D4.
- Mind and collaboration wiring (G3).
- Legacy-key tombstones (G4).

### D7. JEV `session.resume` (new point, shadow in v1)

- Registration: `POINTS` / `UNGATED` / `TEMPLATE_POINTS` (decision-kernel.mjs:12-22), `TEMPLATE_SPECS` (decision-templates.mjs:473) and `DECISION_THRESHOLDS.points`. The state builder goes in decision-state.mjs; the host call is `decisionService.sessionResume(project, { state, signal })`.
- Three noul questions, each a literal situation:
  - `work_left`: the last reply leaves part of the requested work unfinished, or asks the user something;
  - `iterating`: the user has sent a series of related requests revising, continuing or extending the same work;
  - `closed`: the user's last message closes the topic.
- Combined in code: `likely = (work_left ∨ iterating) ∧ ¬closed`.
- State is code-computed and labelled as data:
  - bucketed idle duration;
  - this conversation's user turns in 7 days;
  - whether it is the project's most recent conversation;
  - project user turns in 7 days;
  - last user message (≤600 chars) and the end of the last reply (≤400 chars);
  - up to 4 open plan items sourced from this session.
- Label, automatic: a user turn in the session within 7 days of the decision.
- Gate only after the probe and shadow data show that abandoned-session compactions cross break-even. Break-even P ≈ cost/benefit ≈ 0.2 for one returning turn at a 0.2 cache-price ratio.
- When JEV is unavailable, follow the user's rule (compact).

---

## 5. Work package E — TC-5: step-limit summary keeps system+tools

- In `request()` (session.mjs:753), when `stepLimitSummary && stepLimitResponseFormat !== 'json_object'`:

```js
addContextUpdate({ key: 'execution-boundary', source: 'host-purpose-instructions', scope: 'turn',
  text: JSON.stringify({ boundary: hostFinalResponse ? 'host_closed_tool_phase' : 'step_allowance_reached',
    rule: 'All previously admitted tool batches have finished. Do not call tools in this response.',
    task: clean(stepLimitInstructions ?? DEFAULT_STEP_LIMIT_INSTRUCTIONS),
    constraints: 'Do not claim unfinished work succeeded, broaden authorization, issue tool calls, or describe this limit as a provider failure.' }) });
ctx = context();                 // byte-identical system + tools
toolChoice = supportsToolChoiceNone(selected) ? 'none' : undefined   // export from providers.mjs (outputCapabilities, line 122)
```

- If the response contains tool calls: append `tool_calls_rejected` with `retry: true`, then retry once in the same `request()` with the legacy tool-free projection (today's extended system prompt and `tools: []`). A second violation keeps today's `step_limit` error.
- The `json_object` path is unchanged (session-host-final-response, learning/reference authoring).
- At `runLoop` start, if the latest `execution-boundary` copy is active and belongs to an earlier run, append a cleared revision (`{"boundary":"cleared"}`) so a resumed run is not told tools are off.
- Live: 6 summary rows cost 591K uncached in 7 days, each with cache read 0 right after a request that read 31–167K cached. Expect most of that as cache reads if GLM complies (probe P2).

## 6. Work package F — TC-6: compaction fork (measured option, off by default)

- In `generateCompaction` (session.mjs:521), for automatic triggers except `idle`, when `selected.compat?.compactionFork === true` (set per model only after probe P3):
  - request = `context()` system + tools + projected messages, plus one host-instruction message: "Summarize the conversation above up to and including the message that begins «excerpt of the last archived message»; the messages after it stay verbatim";
  - `toolChoice` 'none' only where verified;
  - if a tool call, an empty answer, or `estimatedInputTokens + maxOutput > window` → fall back once to today's flattened request and journal `compaction_fork_rejected`.
- Idle compaction stays flattened. Its cache is cold, so the fork costs ≈ the same input (projection 669K vs flattened 645K bytes/3 for the novel) and risks a second paid request.
- Benefit at warm deferred triggers: the 09-30 novel compaction would read ≈770K cached instead of 848K uncached.

## 7. Work package G — MIND-6 and collaboration (project-mind.mjs, project-conversation-context.mjs)

### G1. Selection by stable rank (project-mind.mjs:351-361)

- `rank = max(createdAt, confirmedAt, editedAt)`. Membership is top 8 (user scope) and top 10 (standing kinds) by rank.
- Output order is `createdAt` ascending, ties broken by id.
- Overflow standing rules go to `candidates` ahead of BM25 hits, without the `score > 0` prefilter, so JEV `mind.judge` sees them.
- Set `editedAt` on user edit (line 484) and `confirmedAt` on merge/duplicate confirmation (634, 913).

### G2. Accounting stops reordering

- Lines 853 and 1379: `lesson.usedAt = iso(now)` instead of `updatedAt`.
- `feedback()` (1374-1381) only touches active lessons.

### G3. Three keys

`mindContextUpdates({ rules, notes, relevant, commitments, plan, now })` replaces `mindContextText` (367-373). `foregroundContext` (1050-1071) returns an array.

| Key | Source | Scope | Content |
|---|---|---|---|
| `project-mind-rules` | `host-project-mind` | conversation | `{ rules: [{id,kind,scope,text}], instruction }`. `FOREGROUND_INSTRUCTION` (365) is reworded to name the three keys. |
| `project-mind-notes` | | conversation | `{ notes: { facts, preferences } }` |
| `project-mind-turn` | | conversation | `{ relevantLessons, commitments, plan }` |

- runtime-controller.mjs:250 pushes all of them.
- `turn.mindContext.lessonIds` = rules ∪ relevant, unchanged semantics.
- `mindBackgroundView` keeps its shape but uses the new ordering.

### G4. Collaboration

`projectConversationUpdates(session, project, { visibleKeys })` replaces runtime-controller.mjs:274-280.

| Key | Scope | Content |
|---|---|---|
| `project-collaboration:<itemId>` | window | One update per delivered entry in the last 4, same per-entry projection as today. A visible key whose entry is no longer retained gets `{ withdrawn: true, instruction }`. |
| `project-collaboration-pending` | conversation | `{ pendingQuestions, coverage }` |
| `project-collaboration-guide` | conversation | The constant instruction, sent once. |

- Each entry is complete and immutable: no patches, so this is not delta encoding.
- After a compaction the last 4 entries are re-attached automatically (B2).
- Tombstones: the host sends `project-mind` and `project-collaboration` once with `{"moved": "<new keys>"}` (exported constants), so the old windows stop being restored. The SDK dedupes them after the first send.

---

## 8. Contract and protocol changes

| Where | Change |
|---|---|
| SDK journal | Records: `context_fold`, `compaction_prepared`, `compaction_prepared_discarded`, `compaction_fork_rejected`. New fields: `context_compaction.trigger`/`preparedId`, `compaction_request_started.detached`, context messages `contextScope`, assistant `contextHistoryImages`, `tool_calls_rejected.retry`. |
| SDK API | `createSession({ cacheSurvivalMs, clock, preparedCompactionFile })`; `addContextUpdate.scope`; update cap 64. Handle: `prepareCompaction`, `commitPreparedCompaction`, `offerCompaction`. Exports: `generateSummary`, `SUMMARY_PROMPT`, `summaryRequestFor`, `idleCompactionCandidate`, `structuralContinuity`, `survivalFromSamples`, `readJournalRecords`, `supportsToolChoiceNone`. Event: `context_economy`. Update index.mjs / index.d.ts; SDK_VERSION 0.52.0. |
| Provider request | `requestOptions.ledger = { continuity, trigger }` (ignored by providers). |
| Ledger row (§5) | `continuity { continuous, gapMs, previousPromptTokens }`, `trigger`. |
| `/api/v2/usage/cache` (§5) | `cacheSurvival`, `byPurpose.compaction.byTrigger`. |
| Store/bootstrap (§1/§3) | `session.context.idleCompaction { status: preparing\|prepared\|committed\|discarded\|failed\|skipped, at, requestId?, beforeTokens?, afterTokens?, code? }`; notice `source: 'idle-compaction'`; `settings.idleCompaction` (default true). |
| JEV (§6.1) | Point `session.resume` (shadow). |
| Files | `${stateFile}.usage-cache.survival.json` (excluded sibling); `${sessionFile}.idle-summary.json` (inside `.rna/<id>/`). |
| Docs | stream-protocol-v2.md changelog line; docs/research/cache-survival-idle-compaction-20261004.md with §0 and the probe results. |

## 9. Migration

- No Store migration.
- Old journals replay unchanged.
- First request after deploy:
  - mind and collaboration keys switch, and the tombstones are sent once;
  - old superseded copies fold at the first cold break.
- `lesson.updatedAt` keeps its old values; ordering no longer uses it.
- Survival: one-time journal backfill (A3). Without it, idle compaction stays off for GLM until long-gap samples accumulate.
- Version bump: app 0.66.0, SDK 0.52.0.

## 10. Tests

### SDK (packages/sdk/test)

- **cache-survival.test.mjs** (new): warm max / cold above; no cold above → null; documented TTL precedence and override when warm > TTL; minimum-cacheable filter; cold below warm max ignored; 30-day aging.
- **session-continuity.test.mjs** (new):
  - `ledger.continuity` is passed to the provider (fake provider captures it);
  - continuous within a run, and across dispose/reopen via replayed messages;
  - false after settle, fold, forget, compaction, image offload, model change and prefix change;
  - `gapMs` from the clock;
  - property: structurally continuous ⇒ byte-prefix extension over randomized append sequences.
- **context-fold.test.mjs** (new):
  - fold at an idle break (clock > `cacheSurvivalMs`), on a prefix change, after a compaction;
  - no fold on a warm break;
  - A,B,A keeps the last A;
  - turn scope folded after its turn and never restored; window scope not restored and re-sent after compaction (B2);
  - `estimatedInputTokens` drops; replay reproduces the projection;
  - Anthropic without `drop_block`: no fold.
- **context-settle.test.mjs / context-forget.test.mjs** (update):
  - nothing is committed in the run's `finally`;
  - next-run warm and below `SETTLE_SHARE` → nothing; warm and above → settle + forget; cold → any positive saving;
  - forget JEV started at run start and skipped past its budget;
  - deferred compaction tries economies before the summary.
- **session-idle-compaction.test.mjs** (new):
  - `prepareCompaction` keeps the last real user turn and writes nothing (journal bytes unchanged);
  - `generateSummary` rejects tool calls, truncation and >128 KiB;
  - the sidecar is consumed at open and unlinked only after the append; a crash re-open is idempotent;
  - commit validation: stale after rewind → discarded; a newer compaction → superseded; not smaller → discarded;
  - the economy point commits on a cold break and not on a warm one;
  - `compactAutomatically` deferred uses the prepared summary with 0 provider calls;
  - `offerCompaction` mid-run leaves the projection unchanged;
  - usage is counted once.
- **session-step-limit-prefix.test.mjs** (new):
  - summary request `prefixHash` equals the previous request's;
  - boundary message is a host-instruction context;
  - `toolChoice` 'none' only for the verified DeepSeek fake;
  - a tool call triggers one retry on the tool-free projection;
  - the next run appends a cleared boundary.
  - Update session-step-limit-instructions.test.mjs: fakes decide by `tools.length`; the non-JSON cases now see tools. session-host-final-response.test.mjs keeps the json_object path.
- **context-compaction-fork.test.mjs** (new): with `compat.compactionFork`, the fork shares `prefixHash`; a tool call or an over-window request falls back to flattened; never used for idle.
- **decision-templates-valid.test.mjs**: covers the `session.resume` spec.

### Host (prototypes/control-center/test)

- **idle-compaction-service.test.mjs** (new; fake clock, fake provider, real SDK on a temp state):
  - `dueAt = last + coldAfter`;
  - not due below 50%, archived, side, deleting, emergency, gate held, budget, no estimate, Anthropic before TC-3;
  - generation tagged `purpose 'compaction'`, `trigger 'idle'`;
  - a turn arriving mid-generation starts immediately: assert the factory is called before the provider resolves and that `executor.maintenance` does not hold the session;
  - a summary finished mid-turn is offered to the live handle; committed at the next cold break, never on a warm one;
  - commit via maintenance claim when idle and cold;
  - notice in zh and en; `session.context` updated;
  - deletion aborts (`drainMaintenance`); rewind discards; manual `/compact` reuses or discards; restart path.
- **cache-survival-store.test.mjs** (new): `observe` filters; persistence; backfill from journal fixtures (structural); excluded sibling.
- **usage-cache-service.test.mjs**: continuity and trigger fields; `cacheSurvival` and `byTrigger` in the aggregate.
- **runtime-controller.test.mjs**: `cacheSurvivalMs` option; scope flags; three mind updates; collaboration updates; tombstones once.
- **project-mind.test.mjs**:
  - rules text byte-identical across turns when nothing changes (accounting runs between turns);
  - `usedAt` set, `updatedAt` untouched;
  - rank by `confirmedAt`/`editedAt`/`createdAt`;
  - overflow standing rules reach JEV without BM25.
- **project-conversation-context.test.mjs** and **background-collaboration-integration.test.mjs**: per-entry keys, withdrawn revision, pending key, guide once.
- **checkpoint-sidecar-inventory.test.mjs**: the survival file is excluded.
- **prompt-cache-prefix-sharing.test.mjs**: still byte-identical prefixes.

### Integration

Novel-shaped fixture (>50%, several turns, keyed contexts):
1. advance the clock past `coldAfter` → the service compacts;
2. the next turn's first request carries ≤ summary + restored + last turn;
3. no superseded copies remain;
4. `turn.timing.compaction` is 0, i.e. no blocking.

## 11. Measuring the benefit after release

- **Ledger** (`state.json.usage-cache.jsonl`):
  - (a) `purpose:'compaction', trigger:'idle'` rows: count, input, output.
  - (b) Foreground rows with `continuity.gapMs ≥ coldAfter`: `input` per session against the pre-release baseline. Novel expectation: 0.42–0.68M → ≈35–50K once a commit happened.
  - (c) Mean foreground `cacheRead` per request for sessions ≥50% of the window.
  - (d) `purpose:'summary'` hit rate: 0 → ≥0.8.
  - (e) The weekly totals in §0.3, recomputed with the same scripts.
- **Endpoints**:
  - `GET /api/v2/usage/cache?window=7d` (`cacheSurvival`, `byTrigger`);
  - `GET /api/v2/sessions/:id` (`turn.timing.request` / `firstToken` of the first turn after idle: 24–32 s → expected single digits; `context.idleCompaction`);
  - `GET /api/v2/decision-kernel/calibration?point=session.resume`.
- **Journal replay**: `benchmark/context-economy-replay.mjs` (new, read-only, run on copies) reports:
  - superseded keyed bytes at the last request (novel 25.6% → expected <5%);
  - `context_fold` / `context_economy` counts and freed tokens;
  - project-mind-* and collaboration bytes per turn (226.5 KB/31 turns → ≈116 KB; 87 KB → ≈30 KB);
  - `tool_calls_rejected` with reason `step-limit-summary`;
  - the counterfactual (§0.3).
- **Accuracy guard**: correction rate (`capture.correction` on the first 2 user messages after an idle compaction) against the same sessions' baseline. Roll back keep-tail to 2 turns, or gate with `session.resume`, if it rises.

## 12. Risks and guards

| Risk | Guard |
|---|---|
| Summary loses continuity (more compactions) | The last real user turn stays verbatim; conversation keys (mind rules, notes, plan, working state) are restored; files are on disk; correction-rate guard; manual tail = 2 as a fallback. |
| Paying for summaries of abandoned sessions (3D game: 484K, idle 3 days, just under 50%) | `session.resume` shadow, automatic labels; gate once waste crosses break-even. |
| Survival misestimate | `coldAfter` = smallest cold gap above the largest warm gap (conservative); a warm commit is still net-positive (C5); background generation never touches the conversation's cache. |
| Journal-lock race between the commit claim and a turn | Only ~0.2 s `runMaintenance` claims; pump aborts them; the sidecar is consumed by the turn's handle. |
| Double summary (deferred trigger during generation) | `offerCompaction` to the live handle; deferred uses the prepared summary first; one global generation at a time. |
| Anthropic preserved thinking | B7 gate until TC-3. |
| TC-5 non-compliance on GLM | One retry on the legacy projection; worst case today's cost plus one cached request; measured via `tool_calls_rejected`. |
| Update cap and sizes | Cap 64; byte cap 256 KiB unchanged; per-entry collaboration ≤ ~13 KB. |
| Deploy | Survival file registered as an excluded sibling; the idle-summary file lives inside `.rna`. |

## 13. Partition and order

1. **S — SDK** (first; defines the contracts): session.mjs, context.mjs, journal.mjs (`readJournalRecords`), compaction-request.mjs (new), cache-survival.mjs (new), providers.mjs (export `supportsToolChoiceNone`), index.mjs, index.d.ts, version.mjs, SDK tests.
2. **H — host** (after S's API; may stub it): idle-compaction-service.mjs (new), usage-cache-service.mjs, state-checkpoint.mjs, server.mjs, runtime-controller.mjs (all edits in that file), session-command-service.mjs, turn-watch.mjs, decision-service.mjs + decision-templates.mjs / decision-kernel.mjs / decision-state.mjs (`session.resume`), benchmark/context-economy-replay.mjs, host tests, docs.
3. **M — mind** (parallel with S; pure functions only): project-mind.mjs, project-conversation-context.mjs and their tests. H wires the call sites.

Conflicts with P0 work:
- runtime-controller.mjs: deletion X-2 edits `rewind`'s finally; isolation holds touch agent_merge. H's edits are small and localized: rewind before line 824, `drainMaintenance`, factory options, prepareRequest hints, startGate 1174.
- project-mind.mjs: MIND-8 / MIND-1 / X-5 cleanup and settlement. M's functions differ; rebase after P0.
- decision-templates.mjs: P1 item 4 (JEV reasoning routing) also edits it; add `session.resume` in a separate block.
- No edits to project-initiative-controller.mjs, session-deletion.mjs or memory-sync.mjs.


## Files
- packages/sdk/src/session.mjs
- packages/sdk/src/context.mjs
- packages/sdk/src/journal.mjs
- packages/sdk/src/journal-compaction.mjs
- packages/sdk/src/providers.mjs
- packages/sdk/src/prompt-layers.mjs
- packages/sdk/src/index.mjs
- packages/sdk/src/index.d.ts
- packages/sdk/src/version.mjs
- packages/sdk/src/decision-templates.mjs
- packages/sdk/src/decision-kernel.mjs
- packages/sdk/src/decision-state.mjs
- packages/sdk/src/compaction-request.mjs (new)
- packages/sdk/src/cache-survival.mjs (new)
- prototypes/control-center/idle-compaction-service.mjs (new)
- prototypes/control-center/usage-cache-service.mjs
- prototypes/control-center/state-checkpoint.mjs
- prototypes/control-center/server.mjs
- prototypes/control-center/runtime-controller.mjs
- prototypes/control-center/rna-runtime.mjs (read only: passes options through to createSession)
- prototypes/control-center/session-command-service.mjs
- prototypes/control-center/turn-watch.mjs
- prototypes/control-center/decision-service.mjs
- prototypes/control-center/project-mind.mjs
- prototypes/control-center/project-conversation-context.mjs
- prototypes/control-center/settled-writes.mjs (read only: settle hook semantics)
- prototypes/control-center/benchmark/context-economy-replay.mjs (new)
- docs/specs/stream-protocol-v2.md
- docs/research/cache-survival-idle-compaction-20261004.md (new)
- packages/sdk/test/context-settle.test.mjs
- packages/sdk/test/context-forget.test.mjs
- packages/sdk/test/session-step-limit-instructions.test.mjs
- packages/sdk/test/session-host-final-response.test.mjs
- packages/sdk/test/decision-templates-valid.test.mjs
- prototypes/control-center/test/usage-cache-service.test.mjs
- prototypes/control-center/test/runtime-controller.test.mjs
- prototypes/control-center/test/project-mind.test.mjs
- prototypes/control-center/test/project-conversation-context.test.mjs
- prototypes/control-center/test/background-collaboration-integration.test.mjs
- prototypes/control-center/test/prompt-cache-prefix-sharing.test.mjs
- prototypes/control-center/test/checkpoint-sidecar-inventory.test.mjs
- references/pi/packages/coding-agent/src/core/cache-warmer.ts (reference)
- references/zcode/apps/zcode-cli/packages/core/src/compact/microcompact.ts (reference: time-based clear at cold cache)
- references/deepseek-harness/.agents/notes/implemented/feature/2026-07-30-queued-manual-compaction.md (reference: selected-span stability)

## Probes needed
- Survival estimator replay (done read-only in this analysis; record it in docs/research/cache-survival-idle-compaction-20261004.md). Method: continuity-aware samples over all 8 foreground journals. Result for glm-5.3: warm up to 107 min, cold from 137 min, 0 of 1,745 samples between 0.1 and 0.9 hit share. Re-run with benchmark/context-economy-replay.mjs after the backfill, to check the persisted estimate matches.
- JEV session.resume labelled probe, before shadow. Run on POST /api/v2/decision-kernel/probe. Labels from the journals and Store: past idle breaks (>137 min) where the user came back are positives (novel ×8, 3D game, 1484f7e9); final idle periods of conversations still dormant after 7+ days are negatives. Record the distribution of the three questions (work_left, iterating, closed) and choose thresholds from it, never copied. Shadow only until automatic labels accumulate.
- GLM TC-5 compliance probe (main-model calls; needs the user's approval). Step-limit final request with tools declared, no tool_choice, and the host execution-boundary instruction at the tail. Measure: tool calls vs text-only on about 10 historical background-run prefixes (30–170K, mostly cached), and the hit rate of the summary request.
- GLM TC-6 fork probe (main-model calls; needs the user's approval). (a) With tools declared and no verified tool_choice none: does GLM summarize the transcript instead of continuing it with tool calls? (b) Summary quality, fork vs flattened, on 5–10 historical compaction points. Score with JEV coverage questions, one per archived user request: 'does the summary preserve this requirement or state it is done'. Enable compat.compactionFork per model only if both pass.
- Post-release accuracy check for idle compaction. Compare capture.correction rate on the first 2 user messages after an idle compaction against the same sessions' baseline, and compare the turns' 👍/👎. This is not a JEV point but it decides keepUserTurns (1 vs 2).

## Open questions
- Gate on session.resume from day one, or shadow first? The user's rule (idle + over 50% → compact) is implemented ungated, and session.resume is shadow-only. An abandoned session above 50% would cost about 0.4–0.55M uncached tokens per idle compaction. Today only the novel is above 50%; the 3D game is at 48.4% and has been dormant for 3 days.
- Keep-tail for idle compaction: the last real user turn (novel ≈35–50K after compaction) or two turns (≈126K)? The spec picks 1 for size and keeps 2 as the rollback if the correction rate rises. Does the user's 写作连续性 condition need 2?
- Anthropic ordering: idle compaction and fold/settle/forget at economy points stay off for Anthropic until TC-3 (drop_block / strip-and-retry) lands. TC-3 is now P1, so should TC-3 ship before this item or together with it?
- Running the survival backfill once at daemon start means reading all foreground journals, about 160 MB today, sliced and read-only. Is that acceptable, or should it ship without a backfill? Without it, GLM idle compaction stays off until long-gap samples accumulate, roughly 1–2 days of normal use.
- Who owns the ledger row contract (continuity, trigger)? The TC-8 implementer (P1 item 8) or this item? The spec defines it so both can share it.
- Collaboration per-entry keys change what the model sees: each delivered message once, instead of a sliding 4-message window repeated on every change. Entries are complete and immutable (not delta encoding). Confirm this is acceptable under the no-accuracy-trade rule.
- The SDK request-hook context update cap goes from 16 to 64 per request; the 256 KiB byte cap is unchanged. Confirm, since it is a validation guard.
- Decision 2 (internal reasoning effort) also applies to the idle summary request. The spec defers to that item's helper if it exists, else uses the session's reasoning (live: max). Confirm which one the implementer should use if both items land in the same release.