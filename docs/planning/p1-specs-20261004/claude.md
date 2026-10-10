# Implementation spec: Claude through the Anthropic API key, made safe and cache-efficient

Repository: `<local path> at `cd6a9d0` (app 0.64.0 / SDK 0.51.0). Line numbers refer to that commit.
Items covered:
- user decision 4 (Claude only through the API key; TC-3 moves up to P1);
- TC-3 (preserved thinking versus Rna's history rewrites);
- the verifier's MISSED item (a model switch strips another model's thinking from the middle of the history);
- three new defects found while writing this spec (§1.1–1.3). Without fixing them, Claude would fail on most agentic steps even if TC-3 were fixed.

## 0. Sources and what is verified

Authoritative sources used:
- **Bundled claude-api skill** (v2.1.286):
  - `shared/model-migration.md`: Fable 5.1 "Breaking change 2/3" (the mechanics) and "Migrating to Claude Opus 5.5" (specifics);
  - `shared/prompt-caching.md`: Invalidation hierarchy, Choosing the TTL, 20-block lookback, Mid-conversation system messages;
  - `shared/tool-use-concepts.md`: Mid-conversation tool changes.
- **Live docs fetched today (2026-10-04):**
  - `platform.claude.com/docs/en/build-with-claude/preserved-thinking.md`
  - `.../thinking.md`
  - `.../thinking-tool-workflows.md`
  - `.../extended-thinking.md`
  - `.../effort.md`
  - `.../mid-conversation-system-messages.md`
- **Reference code:** `references/pi/packages/ai/src/api/anthropic-messages.ts`, specifically:
  - per-block assembly (:598-735);
  - `block_binding: drop_block` (:1160-1167);
  - effort markers derived from `providerThinkingLevel` (:1370-1455);
  - `test/anthropic-thinking-binding-e2e.test.ts`: removing an effort marker gives "Invalid `signature`".

Facts this spec relies on (all from live docs unless marked):
1. **The conversation check.**
   - The checked prefix is: the top-level `system`, the *set* of `tools`, and every message before the block. Each block also records the previous block.
   - "You can remove thinking blocks from the start of the history (oldest first), from the end, or all of them. What fails is a gap."
   - Also invalid: "Put back a `thinking` block you removed on an earlier request".
   - Also invalid: editing, reordering or deleting earlier user/assistant/system messages; re-encoding an earlier image; shortening a tool_result; changing a tool_use input; changing `system` or `tools`.
   - Valid: appending; changing `effort`, `output_config`, `tool_choice` or `thinking.display`; moving `cache_control`; adding a `defer_loading` tool.
2. **Enforcement.** The check is enforced by default for accounts created on or after 2026-08-31 00:00 UTC. A new Claude account would be enforced. Older accounts are enforced only when `prefix_mismatch_behavior` is set.
3. **`thinking.block_binding.prefix_mismatch_behavior`.**
   - Values are `error` or `drop_block`, and the field needs the `anthropic-beta: thinking-binding-controls-2026-08-01` header. Without the header, the field is a 400.
   - `drop_block` "drops each failing block and every thinking block after it", per request, unbilled.
   - `input_transformations` holds `{type: thinking_dropped|thinking_mismatch_allowed, path: "messages.N.content.M", reason: prefix_binding_mismatch|model_binding_mismatch|organization_binding_mismatch}`. When streaming it is on `message_start.message` (and the final `message_delta` after a server fallback).
   - Exact 400 text: ``messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set …``. A tampered or undecryptable signature gives the same leading clause without "bound to a different conversation", and `drop_block` does not apply to it.
4. **Within an assistant message.** The sequence of thinking blocks "must match what the model generated … you can't rearrange, edit, or partially drop them. This includes `redacted_thinking`". Filtering out `redacted_thinking` "triggers a 400".
5. **Streaming.**
   - Each thinking block streams `thinking_delta` events, then one `signature_delta` just before its own `content_block_stop`.
   - Under `display: omitted`, one empty `thinking_delta` then the `signature_delta`.
   - On Opus 5.5 there can be several thinking blocks per response: progress-update blocks, "at most one before each tool call", each with its own signature.
6. **Model switching.**
   - Keep sending all blocks; the API drops unreadable ones unbilled (`model_binding_mismatch`).
   - Opus 5.5 reads Sonnet 5.5 blocks (Claude API and Google Cloud); nothing else reads Opus 5.5 blocks except Fable 5.1 / Mythos 5.1.
7. **Effort.**
   - Levels are `low|medium|high|xhigh|max` (no `minimal`). The Opus 5.5 default is `medium`, and setting the default explicitly is identical to omitting it. Thinking cannot be disabled on Opus 5.5 (`disabled` is a 400 at every level).
   - A top-level effort change restarts the messages cache but does not invalidate thinking.
   - Per-message effort is `{role:"system", content:[], output_config:{effort}}` under the beta `mid-conversation-output-config-2026-07-01`. It may sit anywhere, takes effect from the next user turn, and preserves the cache.
8. **Mid-conversation `role:"system"` text messages.**
   - GA, no header, on Opus 5.5 / Opus 5 / Opus 4.8 / Fable 5.1 / Sonnet 5.5; not on Sonnet 5.
   - Must follow a user turn (incl. tool_result). May be followed by an assistant turn, the end of the array, or another system message ("consecutive system messages … treated as a single system section").
   - Cannot be `messages[0]`. Editing or removing one already sent invalidates later thinking.
9. **Caching.**
   - Max 4 breakpoints. Writes cost 1.25× (5 min) or 2× (1 h); reads cost 0.05× on Opus 5.5 ($0.20/MTok).
   - `tool_choice` or images invalidate the messages tier.
   - Each breakpoint looks back at most 20 positions; runs of consecutive tool_use or tool_result blocks count as one position.
   - Prior-turn thinking on 4.6+ models stays in context and is billed as input.
   - `usage.output_tokens_details.thinking_tokens` arrives on the final `message_delta`.

**Not verified** (each has a probe in `probesNeeded`):
- the effort-marker and text-system adjacency on the real API;
- whether marking the previous request's tail as an extra breakpoint (B_prev) restores reads beyond 20 positions;
- whether adding a `defer_loading` tool keeps the cache;
- the shape of the `inline-tools-2026-09-15` beta (live mid-conversation page) and of the `compact-2026-09-04` on-demand compaction;
- server-side fallbacks.

## 1. Defects in current code (beyond TC-3 as written)

### 1.1 Multiple thinking blocks per response are merged and their signatures concatenated (critical)
- **Where:**
  - `packages/sdk/src/providers.mjs:459` keeps one `thinkingSignature` for the whole response;
  - `:519` appends every `signature_delta` to it;
  - `:539` emits it once at the end;
  - `packages/sdk/src/session.mjs:775-781` merges consecutive `thinking_delta`s into the last part. `tool_use` parts are only pushed when the stream ends (`:792`), so thinking deltas from blocks on both sides of a tool_use merge into one part;
  - `session.mjs:786-788` puts the concatenated signature on the *last* thinking part.
- **Example:** an Opus 5.5 response `[thinking#0, text#1, thinking#2 (progress), tool_use#3, thinking#4 (progress), tool_use#5]` is journaled as `[thinking#0 (no signature), text, thinking#2+#4 (signature #0+#2+#4), toolCall, toolCall]`.
- **Replay** (`providers.mjs:113` drops unsigned thinking): the first block is dropped from the middle (a gap). The merged block carries an invalid signature, which is the tampered variant: a 400 that `drop_block` cannot absorb.
- **Effect:** every agentic step whose response has two or more thinking blocks fails on its next request, on any account.

### 1.2 `redacted_thinking` blocks are discarded
`providers.mjs:509-514` ignores `content_block_start` of type `redacted_thinking`, so the block is never stored or replayed. The docs say filtering it triggers a 400.

### 1.3 The effort mapping can 400 or silently think
- `buildRequest` (`providers.mjs:181-222`):
  - `minimal` is sent as `output_config.effort:"minimal"`, which is not a level (400);
  - `off` sends no `thinking` field, so Opus 5.5 still thinks at medium. No `block_binding` can be attached either, so enforced accounts get no drop path.
- The preset (`prototypes/control-center/provider-presets.mjs:53`) gives Opus 5.5 `maxOutputTokens = min(8192, 128000) = 8192`. Thinking counts toward `max_tokens`, so at `max` effort replies hit `length`. A tool response cut by `length` is `provider_protocol` (`providers.mjs:530`). The docs recommend 64K.

### 1.4 TC-3 mechanisms
These are confirmed on current code, plus the verifier's MISSED item:
- **settle / forget / prune rewrite earlier turns:**
  - projection at `context.mjs:84-89`;
  - commits: `session.mjs:591` (forget), `:633` (settle), and `forgetSuperseded` inside `compactAutomatically` at `:658`.
- **History-image flips** (`image-offload.mjs:106-127`, used at `context.mjs:82-83`): an image flips to text once it is older than 2 user turns.
- **Durable image offload** at `session.mjs:709-720`.
- **Keep-tail compaction** (`context.mjs:65-80`, `automaticCompactionCandidate` with `keepLastGroups=2`) replays signed thinking in the retained tail.
- **The step-limit / host-final request** (`session.mjs:753`) changes `system` and sends `tools: []`.
- **System and tools are rebuilt per turn** (`prototypes/control-center/rna-runtime.mjs:296`), and tools can change mid-run (`session.mjs:735`).
- **Cross-model strip** (`context.mjs:94`). With Opus→Sonnet 5.5→Opus on one provider, Rna strips Opus's blocks for Sonnet and then *puts them back* for Opus. The live docs list "put back a thinking block you removed on an earlier request" as invalid. It also discards Sonnet 5.5 blocks that Opus 5.5 can read.
- **No recovery path.** A provider 400 becomes `Model request failed` (`session.mjs:824-839`); `streamCompletion` retries only `retryable` statuses (`providers.mjs:438-446`).
- **Interjection** (`session.mjs:820-823`) keeps signed thinking from a partial response. With per-block signatures (after §1.1) this becomes possible.

## 2. Live data and expected impact

Scripts are in the scratchpad (`stats.py`, `ttl.py`, `keepalive.py`, `journals.py`, `positions.py`). They read copies of `.state/state.json.usage-cache.jsonl` and the session journals; no Store was opened. No Claude provider is configured live, so all Claude figures are projections at Opus 5.5 prices ($4 in, writes 1.25×/2×, reads 0.05×) on current GLM traffic shapes.

- **Ledger window:** 2026-09-28T05:44Z → 2026-10-04T09:30Z, 8,473 rows.
  - Foreground: 1,518 requests. Prompt = 17.75M uncached + 481.0M cached; output 2.28M.
  - Consecutive same-session foreground gaps (end-to-end): ≤5 min 1,428 (474.7M prompt); 5–60 min 56 (15.5M); >60 min 23 (8.4M).
- **TTL choice (input-equivalent tokens/week at Opus 5.5 prices):**

  | Traffic | 5-minute TTL | 1-hour TTL | Change with 1 h |
  |---|---|---|---|
  | Foreground | 99.8M (≈$399) | 121.3M (≈$485) | +22% |
  | Background-work + subagent | 35.4M ($142) | 47.3M ($189) | +34% |

  The 2× write on every request's tail costs more than the few 5–60 min gaps save. **Keep the 5-minute TTL** (`cache.retention` stays `short`).
- **Optional keep-alive:** a `max_tokens:0` re-send just before expiry, while idle, with a 15–45 min horizon. Foreground drops to 86.8M (≈$347, −11%); horizon 60 min gives $352, 120 min gives $372. This spends money while the user is away, so it is an open question.
- **Journals since 2026-09-27T09:30Z (4,444 requests):** events that would break preserved thinking on an enforced Claude account with today's code:

  | Event | Count |
  |---|---|
  | System/tools byte changes (excl. step-limit) | 32 |
  | Step-limit summaries | 5 |
  | History-image flips (approx.) | ~7 |
  | Durable image offloads | 6 |
  | Keep-tail compactions | 3 |
  | settle + forget | 2 |
  | **Total** | **≈55/week (1.2% of requests)** |

  Each is a hard 400 that ends the turn. Separately, the §1.1 merge breaks every response with two or more thinking blocks. After this spec:
  - zero hard 400s;
  - rebases (§4.E) happen only at compactions, forced image offloads and tool-set changes;
  - system-prompt changes no longer cost a miss (the pin saves 1.7M eq/week, about $7, in foreground warm windows). Its main value is that reasoning is kept.
- **Settle on Claude at a warm break:** break-even ≈ 1.2×context / (0.05×freed). The novel example has context 567K and frees 184K, so it breaks even after about 74 requests. Hence: no warm settle on Claude (§4.E).
- **Appended cache positions per request** (GLM-shaped content): 0 of 4,279 requests exceeded 20 positions, and 5 exceeded 15. Opus 5.5 progress blocks interleave with tool_use and may roughly double this, so the extra breakpoint (B_prev, §4.H) is cheap insurance at low priority.

## 3. Design invariants (what implementers must preserve)

**I1. Append-only on the Anthropic path.** Take two consecutive Anthropic requests of one session with no rebase journaled between them. With `cache_control` stripped:
- `system` and `tools` must be byte-identical;
- `messages[0..k-2]` must be deep-equal;
- `messages[k-1]` (the previous last message) may only gain trailing blocks;
- the previous response must appear verbatim as the next assistant message.

**I2. Thinking floor (rebase).**
- A journaled `thinking_rebase {throughMessageId}` strips every `thinking` and `redacted_thinking` block in messages up to and including that id, on Anthropic targets. That is "removing from the start / all of them", which is valid.
- The floor only moves forward. A stripped block is never put back.
- Every projection-changing record (settle, forget, prune, image offload, image-history flip, fold from TC-2, compaction) is journaled together with a rebase in the same step, and only touches messages at or before the floor.

**I3. Rebase points on Anthropic are only:**
- compaction (any path);
- forced image-budget offload;
- forget at context pressure;
- tool-set change;
- binding recovery.

Economies (settle, prune, TC-2 fold, history-image flips) never trigger a rebase on their own. They are committed at the next rebase point.

**I4. Block-exact assistant messages.** Content blocks are stored in provider index order: thinking (text + signature), redacted_thinking (data), text, tool_use. Each thinking block keeps its own signature. Partial responses (aborted, error, interjected) never replay their thinking.

**I5. Pinned prefix.** On Anthropic models that support mid-conversation system messages:
- the session pins the top-level `system` and the tool set at the first Anthropic request and re-pins only at a rebase;
- a system prompt change is appended as a durable `role:"system"` message;
- a tool-set change is a rebase point (v1).

## 4. Changes

### A. Block-exact stream assembly
Implementer A (providers) and B (session).

**`providers.mjs` `streamCompletion`, Anthropic branch (`:508-524`):** keep a `Map(index → {type, signature})`.
- `content_block_start`:
  - `thinking`: yield `{type:'thinking_delta', delta: block.thinking ?? '', blockIndex}`, always (even empty). If `block.signature` is present, remember it.
  - `redacted_thinking`: yield `{type:'redacted_thinking', data: block.data, blockIndex}`.
  - `text`: yield `text_delta` with `blockIndex`.
  - `tool_use`: as today.
- `content_block_delta`:
  - `thinking_delta` / `text_delta` carry `blockIndex: event.index`;
  - `signature_delta` accumulates per index.
- New `content_block_stop` handler: for a thinking index, yield `{type:'thinking_signature', signature, blockIndex}`.
- Delete the response-wide `thinkingSignature` (`:459`, `:519`, `:539`).
- Final `tool_call` events (`:531`) carry `blockIndex` (the key of the `tools` map is already the content-block index).
- OpenAI and Codex events stay unchanged (no `blockIndex`).

**`session.mjs` `request()` (`:775-792`):**
- When `Number.isSafeInteger(event.blockIndex)`, find or create the part keyed by `blockIndex` (a local `Map`) instead of merging into `content.at(-1)`.
- `thinking_signature` with `blockIndex` sets that part's `signature`.
- New `redacted_thinking` event pushes `{type:'redactedThinking', data, blockIndex}`.
- `tool_call` with `blockIndex` pushes `blockIndex` too.
- After a complete stream, stable-sort `message.content` by `blockIndex`. Parts without it keep insertion order (OpenAI path). Keep `blockIndex` on the parts; it is harmless metadata, and `wireBlock` (`context.mjs:10`) already drops it for text and toolCall.
- `thinking_signature` *without* `blockIndex` (old custom providers, Codex) keeps today's `findLast` behaviour.

**Partial responses.** In the interjection path (`:820-823`) and the error/abort path (`:833-835`), call `unsignIncomplete(message)`: delete `signature` from thinking parts and drop `redactedThinking` parts. This is deterministic and matches today's behaviour, where partials never had a signature. `replay()` (`:89-94`, `:138-142`) already produces unsigned partials; no change there.

**`index.d.ts`:**
- `ProviderEvent` gains `blockIndex?` on text, thinking, signature and tool_call events, plus:
  - `{type:'redacted_thinking'; data; blockIndex}`
  - `{type:'input_transformations'; items}`
  - `{type:'thinking_rebase'; reason; path?; sourceMessageId?}`
- `MessageBlock` gains `{type:'redactedThinking'; data: string}`.

### B. Wire projection (`providers.mjs` `anthropicMessages`, `:103-121`)
Signature becomes `anthropicMessages(messages, { stripThinking, features, sources })`.
- **thinking:** emit `{type:'thinking', thinking: block.thinking ?? '', signature}` when `block.signature` is present, does not start with `rna:` (Codex receipts, `subscription-provider.mjs:9`), and `!stripThinking`. Today's `:113` already emits empty-text thinking; keep it.
- **redactedThinking:** emit `{type:'redacted_thinking', data}` unless `stripThinking`.
- **`role:'system'` messages:**
  - `source:'system-prompt'`: emit `{role:'system', content:[{type:'text', text}]}`;
  - `source:'effort'` markers (§G): emit `{role:'system', content:[], output_config:{effort}}`.
  - Within each maximal run of non-assistant messages, emit user-role content first and text-system messages after it, keeping their relative order. Consecutive system messages merge into one (allowed). This keeps a late `steer` claim from putting a user message after a system message (a 400).
- **`sources`** (out-param): for each wire `[msg][block]`, the source message `id`. `buildRequest` returns it as non-wire metadata `blockSources`, so a `path` maps to a journal message id.
- Merging of same-role messages (`:117`) is unchanged.

### C. Request configuration (`providers.mjs` `buildRequest`, Anthropic branch `:207-223`)
New module `packages/sdk/src/anthropic-features.mjs` (implementer A):

```js
// Official endpoint only; every flag overridable by a boolean model.compat flag of the same name.
export function anthropicFeatures(model, endpoint) // → { official, thinkingBindingControls, appendOnly, midConversationSystem, perMessageEffort, alwaysThinks, toolChoiceNone }
```

- `official`: `https:` + host `api.anthropic.com` + no port.
- Model sets:
  - `midConversationSystem`: `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-fable-5`, `claude-fable-5-1`, `claude-sonnet-5-5` (not Sonnet 5);
  - `perMessageEffort`: `claude-fable-5-1`, `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5-5`;
  - `alwaysThinks`: `claude-opus-5-5`, `claude-fable-5`, `claude-fable-5-1`, plus any model whose `reasoningCapability.canDisable === false` and `compat.adaptiveThinking`.
- `thinkingBindingControls`: official && thinking present. The docs say models that don't enforce accept the field.
- `appendOnly`: official && thinking present. Third-party Anthropic-protocol endpoints (e.g. Kimi) keep today's behaviour unless compat opts in.

**Thinking and effort mapping** (replaces `:214-222`). Let `e = model.reasoning ?? 'off'`:
- `default`: `thinking:{type:'adaptive', display}`, no `output_config`. Opus 5.5 runs at medium (docs: identical to omitting).
- `low|medium|high|xhigh|max`: adaptive plus `output_config:{effort:e}`.
- `minimal`: map to `low`.
- `off`: `alwaysThinks` → adaptive + effort `low`; `compat.canDisableThinking===true` → `{type:'disabled'}`; else the current behaviour.
- Budget models (no `adaptiveThinking`): today's budget table.
- When `features.thinkingBindingControls` and a thinking object is present: `thinking.block_binding = {prefix_mismatch_behavior: model.compat?.thinkingBindingMode ?? 'drop_block'}`. Tests set `'error'`.

**Headers:** `anthropic-beta` is the comma-joined list of `thinking-binding-controls-2026-08-01` (when `block_binding` is sent) and `mid-conversation-output-config-2026-07-01` (when any effort marker is in the wire). The `anthropic-version` header is unchanged.

**`toolChoice: 'none'`:**
- `outputCapabilities` (`:122-131`) gains `toolChoiceNone: true` for the official Anthropic endpoint (documented on Opus 5.5: "`{type: none}` is unaffected"); it maps to `body.tool_choice = {type:'none'}`.
- This changes the messages-cache tier. Do NOT use it on the conversation's own requests; for that reason step-limit uses the append-only shape (§E5).

**`stripThinking`:** an internal `buildRequest` option passed to `anthropicMessages`.

**Usage** (`normalizeUsage`, `:41-60`): for Anthropic, `reasoningTokens = raw.output_tokens_details?.thinking_tokens` when present (documented on the final `message_delta`).

**`input_transformations`:** read from `message_start.message.input_transformations` and from `message_delta.input_transformations`. Yield `{type:'input_transformations', items:[{type, reason, path, sourceMessageId}]}`, bounded to 64 items and sanitized with `safeProviderCode`.

**Refusal:** keep code `provider_termination` (the existing test `provider-termination.test.mjs:51`). Set `errorDiagnostic.category = 'refusal'` when `stop_reason === 'refusal'`: add `'refusal'` to `provider-diagnostics.mjs` categories and carry a sanitized `stop_details.category`. The host maps category `refusal` to an interfaceLanguage message (`runtime-controller.mjs`, wherever turn-failure text is chosen).

### D. Binding recovery
**Provider (`streamCompletion` attempt loop, `:431-446`):**
- `responseErrorCode` (`:353-372`) additionally returns `thinkingRejection = {path, bound}` when status is 400, `error.type` is `invalid_request_error`, and the *raw* message matches ``/^messages\.(\d+)\.content\.(\d+): Invalid `signature` in `(?:redacted_)?thinking` block/``. `bound` is true when the message contains "bound to a different conversation". This is the documented error contract, not content heuristics.
- On the first such rejection in this call:
  - if the body had no `block_binding` and `features.thinkingBindingControls` is true, rebuild with `drop_block` (the docs' recovery);
  - otherwise rebuild with `stripThinking: true`.
- Yield `{type:'thinking_rebase', reason: bound ? 'binding_rejected' : 'invalid_signature', path, sourceMessageId}` (stripThinking path only), then refetch once. It does not count against `maxRetries`.
- A second rejection throws `ProviderError(code 'thinking_binding', status 400)`. A non-thinking 400 is never retried.

**Session:**
- On provider event `thinking_rebase`, append `thinking_rebase {id, throughMessageId: tailMessageId, reason, requestId, at}`. `tailMessageId` is the last message id in `state.messages` when the request started.
- On `input_transformations`:
  - store it on the assistant message as `inputTransformations` (≤32 entries);
  - if any `thinking_dropped` has reason `prefix_binding_mismatch`, append `thinking_rebase` with reason `binding_dropped` through `tailMessageId`, after `request_completed`;
  - `model_binding_mismatch` and `organization_binding_mismatch` are logged only; they are expected and deterministic.
- This replaces the docs' "keep sending drop_block forever" degradation: without a rebase, `drop_block` drops every later block on every request, so reasoning would be lost permanently.

### E. History policy (`session.mjs`, `context.mjs`, `image-offload.mjs`)
Implementer B. New module `packages/sdk/src/anthropic-history.mjs`:
- `appendOnlyActive(selected)`;
- `thinkingStripSet(messages, floorId)`: assistant ids at or before the floor;
- `coldBreak({lastRequestStartedAt, now, ttlMs})`, exported for TC-4;
- `commitWithRebase(append, state, {reason, records})`, so a record and its rebase are always journaled together.

**E1. Replay** (`session.mjs:66-136`), new records:
- `thinking_rebase {id, throughMessageId, reason}`:
  - sets `state.thinkingFloor`, monotone (ignore a record whose message index is lower than the current floor);
  - `reason ∈ compaction | image_budget | context_pressure | prefix_changed | binding_rejected | binding_dropped | invalid_signature`.
- `prefix_pin {id, systemPrompt, toolsDigest, afterMessageId, effort, modelKey}`: sets `state.prefixPin`.
- `request_started` gains `tailMessageId` and `cacheTailMessageId` (§H). Replay keeps `state.lastRequestStartedAt` and `state.lastCacheTail`.
- `applyRewind` (`:56-65`): if the floor message was dropped, clamp the floor to the last remaining message, so nothing is put back.

**E2. Projection** (`prepareContext`, `context.mjs:62-149`). New params: `historyPolicy: {appendOnly, floorMessageId, pinAfterMessageId}`.
- (a) **Line 94, cross-model thinking.** For `model.protocol === 'anthropic'`, strip thinking only from assistant messages whose `provider !== model.providerId`, or whose signature starts with `rna:`. Keep same-provider other-model blocks; the API drops what it can't read. Keep today's rule for OpenAI and Codex targets.
- (b) **Floor.** If `floorMessageId`, remove `thinking` and `redactedThinking` from assistant messages at or before it. Compute this on `messages` before the compaction projection, so archived ids are fine.
- (c) **Images.** If `appendOnly`, call `planHistoryImages` with a new option `{throughMessageId: floorMessageId}` (`image-offload.mjs:106`). The window is computed only over `messages[0..floor]`; images after the floor keep their pixels until the next rebase. With no floor, nothing flips.
- (d) **System messages.** Drop `role:'system'` messages with source `system-prompt` and `effort` for non-Anthropic targets, and drop them for Anthropic when the model lacks the feature. Drop `system-prompt` messages at or before `pinAfterMessageId`.
- (e) **Compaction restore** (`:74-79`): exclude source `system-prompt`.
- (f) **`usable()` anchor** (`:123`): add `contextThinkingFloorId` equality, set on the assistant message like `contextCompactionId`, so a rebase falls back to the byte estimate for one request.

**E3. Rebase points:**
- `generateCompaction` after `:553`, and manual compaction at `:1137`: `commitWithRebase(reason 'compaction')` through `state.messages.at(-1).id`, plus a new `prefix_pin` with the current system, tools and effort.
- `prepareRequestImages` after `:716`: if `appendOnly`, rebase with reason `image_budget`.
- `forgetSuperseded` when called from `compactAutomatically` (`:658`): if `appendOnly`, rebase with reason `context_pressure` in the same step as `context_forget`.
- `settleWrites` (`:605`): return false when `appendOnly` unless called at a rebase point. It runs post-run, which is warm, so it is off on Claude. TC-4's relocation must commit settle together with the next rebase on Anthropic.

**E4. Pin.** `ensurePrefixPin()`, called at the top of `request()` before ctx (`:741-753`) when `appendOnly && midConversationSystem`:
- **No pin, or pin `modelKey` from a non-Anthropic epoch:** append `prefix_pin` with the current `clean(systemPrompt)`, `digest(declarations)` and the effort.
- **`digest(declarations) !== pin.toolsDigest`:** `commitWithRebase('prefix_changed')` plus a new pin. This holds for v1, including mid-run changes from `change.tools` (`:735`).
- **Else, current `systemPrompt` ≠ the effective one** (the last `system-prompt` message after the pin, else `pin.systemPrompt`): append a durable message `{role:'system', source:'system-prompt', contextKey:'system-prompt', contextRevision: digest(text), content:[{type:'text', text: SYSTEM_PROMPT_UPDATE_LEAD + '\n' + systemPrompt}]}`.
  - `SYSTEM_PROMPT_UPDATE_LEAD`: "[Operator system prompt revised. From here on this text replaces the original system prompt in full; where they differ, follow this version.]" It is model-facing and in English, like the other host leads.
  - A state that returns to an earlier value (A, B, A) re-appends; this is correct.
- `context()` passes `systemPrompt: pin?.systemPrompt ?? current`. The memo key (`:258`) adds `state.prefixPin`, `state.thinkingFloor` and `selected.protocol`.
- Models without `midConversationSystem` keep today's behaviour: the top-level system changes and there is no pin.

**E5. Step-limit / host-final request** (`:753`) when `appendOnly`. Do not change system or tools:
- `addContextUpdate({key:'execution-boundary', source:'host-purpose-instructions', text: <same boundary text as today>})`, then use `context()`.
- The response's thinking is then replayable.
- A tool call is still rejected by the existing `tool_calls_rejected` path (`:800-803`).
- This is TC-5's fix, done for the Anthropic branch. Coordinate (§10).

**E6.** Messages of other host consumers are unaffected: they filter by role `user` / `assistant` / `toolResult`. Checked: `delivery-review.mjs:7`, `browser-delivery-review.mjs:9`, `runtime-controller.mjs:678-699`, `memory-sync.mjs:270`.

### F. Tool changes
- **v1 (this spec):** a tool-set change is a rebase point (E4). It costs a full cache miss, which is unavoidable since tools render first, and loses earlier reasoning once.
  - Frequency: ≈25 `capabilities_changed` events across all journals' lifetimes.
  - EVO-3 (stable gene names) and TC-10 (stub declarations for unreachable MCP) remove most of the remaining causes; both are prerequisites for good Claude behaviour.
- **v2 (after probe P7):** new tools enter `tools[]` with `defer_loading:true` plus a `tool_addition` block in a system message. This is documented valid for thinking. Alternatively, the live docs' `inline-tools-2026-09-15` beta. Removals use `tool_removal`.

### G. Effort (ties to the user's decision 2)
**Wire mapping** is §C.

**Default usable: yes for Claude.** Adaptive thinking decides depth. Opus 5.5 omitted equals `medium`; others default to `high`.
- Presets get `reasoningCapability.defaultAdaptive = true` (`provider-presets.mjs:9` `cap()` option) on Claude adaptive models.
- The effort-spec owner uses it to choose `default` without JEV for internal purposes and for `auto` on Claude. Explicit user levels pass through.
- No change to GLM.

**Per-message effort (P1b; only when effort changes inside one session, e.g. the user changes the selector mid-conversation).** Follow pi's derived-marker design:
- Record `message.reasoning` (the wire level actually used; `default` resolved to `reasoningCapability.providerDefault`) on each assistant message at creation (`session.mjs:766`).
- The session pins the top-level effort in `prefix_pin.effort`.
- In the projection, insert an effort-only system message at the start of the non-assistant run preceding assistant message k whenever k's recorded level differs from the level in force: the last marker, else the pin. For the current request, insert one at the start of the tail run if the active level differs.
- Markers are deterministic from journaled data, never deleted, and placed per the documented example (before the user turn).
- Change effort only at the first request of a run. The docs: "a tool-use loop is one assistant turn, so change the configuration only between turns". Mid-run `change.reasoning` is deferred to the next run.
- Models without `perMessageEffort` keep top-level changes (cache restart), as today.

### H. Cache breakpoints and TTL (`buildRequest`, `:207-213`)
- **TTL:** keep `cache.retention` `short` (5 min) for Anthropic. Data: 1 h costs +22% foreground and +34% background (§2). No preset change. `cacheTtlMs` (`usage-cache-service.mjs:12-17`) is already correct.
- **Breakpoints (≤4):**
  1. last tool;
  2. system;
  3. **B_prev**: the last eligible block (text, image, tool_result) contributed by the source message that carried the previous request's tail marker. The session passes `cache.previousTailMessageId` from `state.lastCacheTail`; omit it if that message is not in the wire;
  4. **B_tail**: the last eligible block of the last user-role wire message, as today but skipping a trailing system message.
- Same TTL on all four. Never on thinking or redacted blocks.
- The session journals `cacheTailMessageId` (the source id that received B_tail) in `request_started`.
- Moving markers never affects preserved thinking (documented).
- **Keep-alive** (open question): `max_tokens:0`, `stream:false`, same body. The decision is computed in code from the session's observed return-gap distribution; no JEV and no fixed cap.

### I. Presets and config (`prototypes/control-center/provider-presets.mjs:52-55`)
- `claude-opus-5-5`: `maxOutputTokens: 64000` (docs: 64K for agentic turns; thinking counts). Add `defaultAdaptive` (§G).
- Leave compat flags implicit; `anthropicFeatures` decides on the official endpoint.
- Optional: add `claude-sonnet-5-5` (1M, 128K, levels low…max, providerDefault high) and fix `claude-sonnet-5` levels (it supports xhigh/max).
- Auth stays API key only (`subscription-auth.mjs:11`: `methods:['api_key']`). Nothing to change for the user's Claude policy.

### J. Accounting and observability
- **`usage-cache-service.mjs` `meteredProvider` (`:113-126`) and `usageRecord` (`:30-37`)** add, only when non-zero or present:
  - `thinkingDropped: {prefix, model, organization, allowed}`, counts from `input_transformations`;
  - `thinkingRecovery: 'strip' | 'drop_block'` from the provider's `thinking_rebase` or retry.
- **Session event** `thinking_rebase {id, reason, throughMessageId, strippedBlocks}`. Not shown in the transcript by default; the turn-diagnostics view may list it with interfaceLanguage text.
- **New `prototypes/control-center/benchmark/anthropic-prefix-audit.mjs`:**
  - Takes a copy of a journal. It replays it via an optional observer added to `replay()` (exported as `replayJournal(journal, {onRecord})`).
  - At each `request_started` it builds the Anthropic wire body (synthetic official Opus 5.5 model) and runs `appendOnlyViolations(prev, cur)`.
  - It prints per-cause counts and the appended-position distribution.
  - Run it on today's journals as the baseline (≈55 violations/week expected), and after the change to confirm that every divergence is explained by a journaled rebase or pin.
- **New `prototypes/control-center/benchmark/anthropic-binding-probe.mjs`:** probes P1–P8. It reads the key from the `ANTHROPIC_API_KEY` env only; it never writes the key. Run only with the user's approval.

### K. Docs
`docs/specs/stream-protocol-v2.md`: a changelog line (Chinese, house style) covering:
- new journal records `thinking_rebase` and `prefix_pin`;
- `request_started.tailMessageId` / `cacheTailMessageId`;
- message fields `reasoning`, `inputTransformations`, `contextThinkingFloorId`;
- the content block `redactedThinking`;
- `role:'system'` messages (`system-prompt`, `effort`);
- events `thinking_rebase` and `input_transformations`;
- ledger fields `thinkingDropped` / `thinkingRecovery`;
- diagnostic category `refusal`.

Also update the Anthropic row of `docs/specs/pi-integration-and-cache.md:199`.

## 5. Data and contract summary
- **Journal records:** `thinking_rebase`, `prefix_pin` (new); `request_started.{tailMessageId, cacheTailMessageId}` (new fields). Old journals replay unchanged: no floor, no pin.
- **Messages:**
  - assistant gains `reasoning`, `protocol` (= `selected.protocol`), `inputTransformations`, `contextThinkingFloorId`; parts gain `blockIndex`;
  - new block `redactedThinking {data}`;
  - new `role:'system'` messages with `source ∈ {system-prompt}` (and `effort` only if markers are ever journaled; §G derives them, so none are journaled).
- **Provider events:** see §A and §C.
- **Ledger:** see §J.
- **Migration:** none. No Claude sessions exist live, and GLM/OpenAI/Codex projections are unchanged (guarded by tests). Saved provider configs without the new compat fields get `anthropicFeatures` defaults from the endpoint and model id.

## 6. Tests
New fixture `packages/sdk/test/fixtures/fake-anthropic.mjs`: an in-process `fetch` that streams documented SSE.
- **Signatures:** `HMAC(secret, [model, prefixDigest, prevSig])`, stored in a Map.
  - `prefixDigest` = canonical(system text, name-sorted tool set, messages before the block with thinking removed, earlier non-thinking blocks of the same assistant message).
  - Verification: an unknown signature is the tampered 400. A prefix or chain mismatch (a gap; a missing predecessor is allowed only for the first block in the request) gives `error` → the documented 400 text, or `drop_block` → drop it and all later blocks, with `input_transformations`. A model mismatch is a silent drop.
- **Validation it enforces:** `block_binding` without the header (400); markers without the beta (400); system placement rules; a final assistant message (prefill, 400).
- **Cache simulation:** positions (runs of tool_use or tool_result collapse to one), entries per breakpoint with TTL on an injected clock, 20-position lookback, usage counts.
- **Responses** are scriptable: thinking (summarized/omitted), progress thinking, redacted, text, tool_use.

Helper `packages/sdk/test/helpers/append-only.mjs`: `assertAppendOnly(prevBody, curBody, {rebase, pin})` implementing I1; when a rebase is journaled between the two, it only asserts that no thinking at or before the floor remains.

Test files:
1. **`test/anthropic-stream-blocks.test.mjs`** (A):
   - A response `[thinking(summarized), text, thinking(progress), tool_use, thinking(empty, omitted), tool_use, redacted_thinking]` yields `blockIndex` events and one signature per block.
   - Session content equals the response blocks in order.
   - The next wire assistant message deep-equals the original response content.
   - `content_block_start.signature` is honoured.
   - Interjected or aborted partials carry no signature or redacted parts.
2. **`test/anthropic-wire.test.mjs`** (A):
   - The effort mapping table: `default` has no `output_config`; `minimal` → low; `off` on Opus 5.5 → adaptive + low; `off` with `canDisableThinking` → disabled.
   - `block_binding` and the header only on the official endpoint with thinking; none for a `https://api.kimi.com/coding` base URL.
   - `toolChoice:'none'` → `{type:'none'}` on official.
   - Codex `rna:` signatures are never emitted.
   - `stripThinking` removes thinking and redacted only.
   - System-message ordering and merging.
   - `blockSources` maps a path to an id.
   - `thinking_tokens` reaches `reasoningTokens`.
   - `input_transformations` is parsed from `message_start` and `message_delta`.
   - The refusal diagnostic category is set.
   - Breakpoints: ≤4, B_prev on exactly the block marked by the previous request, never on thinking, one TTL.
3. **`test/anthropic-append-only.test.mjs`** (B, fake server in `error` mode, so any defect fails). A 10-turn scripted session with:
   - context updates every request, parallel tools, progress blocks, steer interjection, finish-feedback, resume after an injected network error;
   - every consecutive pair passes `assertAppendOnly`, there are zero 400s, and `input_transformations` is always empty.

   Sub-cases (each asserts the journal records and the next request passes):
   - system prompt change across `createSession` reopenings: wire system stays S1, a single `system-prompt` message is appended, A/B/A re-appends;
   - tools change: `thinking_rebase(prefix_changed)` + pin, no thinking at or before the floor, later thinking replayed;
   - manual and automatic compaction: `rebase(compaction)` + re-pin, retained tail without thinking, system-prompt messages not restored;
   - vision history: no flips on warm turns, flips only at or before the floor after a rebase;
   - 17 images: `image_offload` + `rebase(image_budget)`;
   - warm `settleWrites` journals nothing;
   - context-pressure forget journals `context_forget` + rebase together;
   - step-limit summary: system and tools unchanged, the boundary is a context message, the summary's thinking is replayed next run;
   - rewind clamps the floor;
   - crash mid-stream (replay) replays no signatures.
4. **`test/anthropic-binding-recovery.test.mjs`** (A+B):
   - an injected legacy edit (append an old-style `context_settle` record) with mode `error` and no header: 400 → strip and retry once → `thinking_rebase(binding_rejected)`;
   - the same edit with the header and no `block_binding`: retry with `drop_block`;
   - a mutated signature: `invalid_signature` strip and retry;
   - a second rejection: the turn fails with code `thinking_binding` and there is no third request;
   - a non-thinking 400 is not retried;
   - `drop_block` mode with `input_transformations` (prefix): `rebase(binding_dropped)`, and the following request has zero transformations;
   - Opus→Sonnet→Opus on one provider: all blocks sent, only `model_binding_mismatch`, no rebase.
5. **Update `test/session-model-change.test.mjs`:** keep the cross-provider assertions; add the same-provider Anthropic case; add that a Codex-receipt thinking block is never sent to Anthropic.
6. **Update `test/image-offload.test.mjs`:** `planHistoryImages(…, {throughMessageId})`.
7. **GLM / OpenAI unchanged (golden):** existing `providers.test.mjs` and `provider-anthropic-cache.test.mjs` stay green. Add a test that `role:'system'` `system-prompt` messages never reach OpenAI or Codex bodies.
8. **Host:** `prototypes/control-center/test/usage-cache-thinking.test.mjs` (ledger fields); preset test (Opus 5.5 `maxOutputTokens` 64000, `defaultAdaptive`); a refusal text i18n test (zh/en).

## 7. Measurement afterwards
**Before Claude is configured:**
- Run `anthropic-prefix-audit.mjs` over copies of all journals.
- Baseline today: ≈55 violations/week (32 prefix, 5 step-limit, ≈7 image flips, 6 offloads, 3 compactions, 2 settle/forget).
- After the change, the target is 0 unexplained divergences. Rebases by reason should be compaction / image_budget / prefix_changed only.

**After the user adds an Anthropic key** (rows with `modelId` `claude-*` in `.state/state.json.usage-cache.jsonl` and `GET /api/v2/usage/cache?window=24h`):
- `thinkingRecovery` count, target 0 after day 1;
- `thinkingDropped.prefix`, 0 outside the first request after a journaled rebase;
- `thinkingDropped.model`, only after model switches;
- for consecutive same-session rows with a gap ≤5 min, `cacheRead/(input+cacheRead+cacheWrite)` ≥ 0.95, and `cacheWrite` ≈ size delta;
- weekly input-equivalent `input + 1.25·cacheWrite + 0.05·cacheRead` per purpose against the projection (foreground ≈99.8M eq at current volume);
- turn failures with `thinking_binding` or `provider_termination` on Claude, target 0;
- `thinking_rebase` records per session-day from journals.

## 8. Risks and guards
- **Unverified API details.** Probes P1–P8 cover them. Strip-and-retry and `drop_block` keep requests succeeding even if a probe shows a mismatch.
- **Over-stripping loses reasoning.** Rebases occur only at the I3 points. Monitor their rate. The docs: dropping once at a boundary "has little effect".
- **A mid-run tool change rebase drops the current turn's reasoning** (v1). Measure frequency. v2 is `tool_addition` / inline tools.
- **Duplicate system prompt text after a revision.** The appended block is bounded by the system prompt size (≈4–40 KB); the next compaction re-pins.
- **The redactor (`clean`) altering model text or thinking** (only when a secret appears): self-heals via drop or strip plus a rebase.
- **Third-party Anthropic-protocol endpoints:** all new behaviour is gated to the official host; the block-assembly fix applies to all of them.
- **Conflicts with parallel P1 work:** see §10.
- **The UI rendering multiple thinking parts or `redactedThinking`:** add a web spec test that unknown or redacted parts render nothing and multiple thinking parts render in order.

## 9. Dependencies
- **EVO-3 / TC-1** (stable gene tool names) and **TC-10** (unreachable MCP stubs) should land before or with this; otherwise every evolution generation or MCP flap is a Claude rebase.
- **TC-5:** E5 implements its Anthropic shape.
- **TC-4 and TC-2:** on Anthropic their commits must use `commitWithRebase` at the next I3 point; there is no standalone cold-break rebase.
- **TC-8:** shares the `usageRecord` edits.

## 10. Partition for implementers

**Implementer A — providers:**
- `packages/sdk/src/providers.mjs` (Anthropic branches only: `:41-60`, `:103-131`, `:207-223`, `:284`, `:353-372`, `:424-446`, `:459-540`);
- new `packages/sdk/src/anthropic-features.mjs`;
- `packages/sdk/src/provider-diagnostics.mjs` (category `refusal`);
- `packages/sdk/src/index.d.ts` / `providers.d.ts`;
- tests 1, 2 and half of 4.
- **Conflicts:** P1 item 5 (GLM `toolChoiceNone` in `outputCapabilities` `:122-131`) touches the same function, so merge sequentially. The effort-per-purpose owner may touch the OpenAI effort lines `:181-200` (disjoint).

**Implementer B — session/context:**
- `packages/sdk/src/session.mjs` (`:56-136`, `:257-262`, `:521-569`, `:571-645`, `:709-848`, `:1018-1027`, `:1137`);
- `packages/sdk/src/context.mjs` (`:62-149`);
- `packages/sdk/src/image-offload.mjs` (`:106-127`);
- new `packages/sdk/src/anthropic-history.mjs`;
- fixture, helper, and tests 3–6.
- **Conflicts:**
  - TC-4 (settle relocation), TC-5 (`:753`), TC-6 (`generateCompaction`) and TC-8 (`request_started` fields) edit `session.mjs`;
  - TC-2 (fold) edits `prepareContext`.
- Assign TC-5's Anthropic part to B, or land B first and rebase the others onto `commitWithRebase`.

**Implementer C — host and docs:**
- `prototypes/control-center/provider-presets.mjs`;
- `prototypes/control-center/usage-cache-service.mjs` (coordinate with TC-8);
- `prototypes/control-center/runtime-controller.mjs` (refusal text only);
- the two benchmark scripts;
- `docs/specs/stream-protocol-v2.md`, `docs/specs/pi-integration-and-cache.md`;
- web spec test; host tests in 8.

**Order:** A and B in parallel (fixture owned by B, consumed by A's test 4), then C.

## Files
- packages/sdk/src/providers.mjs
- packages/sdk/src/session.mjs
- packages/sdk/src/context.mjs
- packages/sdk/src/image-offload.mjs
- packages/sdk/src/subscription-provider.mjs
- packages/sdk/src/provider-diagnostics.mjs
- packages/sdk/src/index.d.ts
- packages/sdk/src/providers.d.ts
- packages/sdk/src/anthropic-features.mjs (new)
- packages/sdk/src/anthropic-history.mjs (new)
- packages/sdk/test/fixtures/fake-anthropic.mjs (new)
- packages/sdk/test/helpers/append-only.mjs (new)
- packages/sdk/test/anthropic-stream-blocks.test.mjs (new)
- packages/sdk/test/anthropic-wire.test.mjs (new)
- packages/sdk/test/anthropic-append-only.test.mjs (new)
- packages/sdk/test/anthropic-binding-recovery.test.mjs (new)
- packages/sdk/test/session-model-change.test.mjs
- packages/sdk/test/image-offload.test.mjs
- packages/sdk/test/provider-anthropic-cache.test.mjs
- packages/sdk/test/provider-termination.test.mjs
- prototypes/control-center/provider-presets.mjs
- prototypes/control-center/usage-cache-service.mjs
- prototypes/control-center/runtime-controller.mjs
- prototypes/control-center/rna-runtime.mjs
- prototypes/control-center/benchmark/anthropic-prefix-audit.mjs (new)
- prototypes/control-center/benchmark/anthropic-binding-probe.mjs (new)
- prototypes/control-center/test/usage-cache-thinking.test.mjs (new)
- docs/specs/stream-protocol-v2.md
- docs/specs/pi-integration-and-cache.md
- docs/research/system-review-20261004-findings.md
- references/pi/packages/ai/src/api/anthropic-messages.ts
- references/pi/packages/ai/test/anthropic-thinking-binding-e2e.test.ts

## Probes needed
- P1 (user-approved, real Anthropic API, Opus 5.5, prefix_mismatch_behavior 'error'): run the docs' three-request self-test with Rna's actual request bodies. First request with a tool; second request appending its tool_result; third request after a deliberate edit, which must 400 with the documented text. Confirms that enforcement is on for the account and that the Rna body passes. Cost < $0.10.
- P2: a multi-block agentic turn (display summarized) producing progress thinking blocks between parallel tool_use blocks. Replay with per-block signatures and assert a 200 with an empty input_transformations. Repeat with display 'omitted', where the thinking text is empty and only the signature is present.
- P3: keep-tail compaction shape. Summary user message + retained tail with thinking stripped up to the floor (the rebase). Expect no 400, empty transformations, and thinking produced after the compaction replayed successfully on the next request.
- P4: same-provider model switch Opus 5.5 → Sonnet 5.5 → Opus 5.5 with all blocks kept. Expect only model_binding_mismatch entries, no 400, and record cache_read on the return to Opus. Confirms the live doc's claim that Opus 5.5 reads Sonnet 5.5 blocks.
- P5: placement of mid-conversation system messages in Rna's message shape: [user + context text blocks, system(text: revised system prompt), assistant]. Also with an effort-only marker adjacent (both orders) and with a steer user message claimed after the system message, which the projection reorders. Expect no 400 'system message not placed correctly'.
- P6: cache lookback. One turn appending more than 20 positions (sequential progress-thinking/tool_use pairs plus 8 context blocks). Compare cache_read_input_tokens with and without the B_prev breakpoint on the previous request's tail block.
- P7 (v2 only): adding a new tool mid-conversation with defer_loading:true plus a tool_addition system block (beta mid-conversation-tool-changes-2026-07-01), versus the live-doc beta inline-tools-2026-09-15. Measure cache_read preservation and input_transformations.
- P8: confirm usage.output_tokens_details.thinking_tokens on the final message_delta for Opus 5.5 adaptive thinking; confirm the input_transformations array is present (empty) on every response when the beta header is sent.
- Offline, no API cost: run the new anthropic-prefix-audit.mjs over copies of all 321 journals before and after implementation, giving the per-cause baseline (scratchpad crude scan: ~55 thinking-breaking events/week in 4,444 requests) and the post-change zero-unexplained-divergence check.

## Open questions
- Server-side refusal fallbacks (fallbacks:'default', beta server-side-fallback-2026-07-01) are recommended by Anthropic for Opus 5.5. The fallback model (Opus 5 / 4.8) runs without Opus 5.5's thinking blocks and is billed as a separate model. Enable by default? The user's policy only constrains auth (API key), so this is a cost and behaviour choice for the user.
- Idle keep-alive pings (max_tokens:0, stream off, re-sent shortly before the 5-minute expiry while the user is idle). Projected saving ≈11% of foreground input cost (~$44/week at current volume and Opus 5.5 prices), but it spends money while the user is away. Enable? If yes, the horizon is computed in code from each session's observed return-gap distribution (no fixed cap).
- Production prefix_mismatch_behavior: this spec chooses 'drop_block' (degrade, log, auto-rebase) over 'error' (fail the turn on any binding bug). Confirm.
- Thinking display: keep 'summarized' (UI shows reasoning summaries and progress notes) or move to the 'updates' beta (progress notes only, reasoning hidden)? Display does not affect billing or replay.
- Opus 5.5 preset maxOutputTokens: raise from 8192 to 64000, as the docs recommend because thinking counts toward max_tokens. This also shifts the compaction trigger to 0.8×1M−64K = 736K. Confirm. Also: add claude-sonnet-5-5 / claude-fable-5-1 presets now, or only Opus 5.5?
- Ownership: should TC-5's Anthropic branch (step-limit summary keeps system/tools and appends the boundary as a host context message) be implemented here (§E5) or by the TC-5 implementer? Both edit session.mjs:753.
- Tool-set changes on Claude in v1 cost a rebase (lose earlier reasoning once, full cache miss). Acceptable until the v2 defer_loading/tool_addition or inline-tools path is probed? A mid-run skill install then loses the current turn's reasoning.