# D4 scenario harness

Cross-system tests run one real host (`createServer`) in a temporary world. Only the model, the network services and the clock are fake (pi `test-harness.ts`; deepseek-harness `docs/testing.md`: "mock only the LLM adapter, network and clock", "verify the world, not the self-report"). Scenarios live in `test/scenarios/`; each batch adds the ones for the seams it changes.

## Pieces

| File | What it is |
|---|---|
| `world.mjs` | `createWorld(t, options)`: the host on a temp state file and a git workspace, the fakes wired in, readers for the world (persisted state, sidecars, files, git refs, usage ledger), `tick()` for the host's periodic work after a clock jump. |
| `scenario.mjs` | The DSL: `send` / `answer`, `stream`, `backgroundRun`, `revert`, `delete`, `archive`, `evolve`, `advanceClock` / `idle`, `step`. Each step records model requests, OpenViking and JEV calls and SSE frames; `.expect({ state, sidecars, files, gitRefs, frames, requests, memory, judgments })` asserts on the world. Every step also checks invariants: persistence did not fail, every `<state>.<name>` sibling is in the checkpoint inventory, no SSE frame exceeds `MAX_EVENT_BYTES`, every JEV answer parsed. |
| `faux-model.mjs` | Scripted responses per purpose tag (`foreground`, `initiative`, `background-work`, `mind`, `narrator`, `http`…), mounted as an SDK provider (createServer's `runtimeFactory`, the initiative's providers) and as an OpenAI-compatible endpoint (the configured model, for every purpose the host calls with the real provider: subagents, compaction). `decide()` writes initiative decisions. |
| `fake-openviking.mjs`, `fake-jev.mjs` | HTTP fakes with real state; the JEV fake abstains unless a question is answered (`answer(id, value)`). The OpenViking fake also keeps sessions' archives and extracted memory files (`extraction({ sessionId, session, archiveNo })` makes a commit write memories, its `memory_diff.json` and `.done`; event tags; `memory(uri, body)`, `bodyOf(uri)`, `tagsOf(uri)`, `writes()`), and has `fail(call)` and `listOverride(uri)` to break one route or one listing. |
| `clock.mjs` | A shifted `Date`: wall time keeps running, `advance(ms)` jumps every reader forward. Timers stay real. |
| `clients.mjs` | Raw SSE reader, a browser tab that follows `web/src/store/sync.ts`'s loading rules, a byte-counting proxy for the CLI. |
| `fixtures.mjs` | Live-shaped state (entries, outbox rows, rhythm history) with synthetic text. |
| `budget.mjs` | Median-of-5 measurements against fixed budgets (expected ms × load × headroom). |

## Writing a scenario

```js
const world = await createWorld(t, { initiative: true, files: { 'notes.md': 'one\n' } });
const s = scenario(world);
const step = await s.send('Tidy the notes.', { reply: [{ toolCalls: [{ name: 'project_write', args: { path: 'notes.md', content: 'two\n' } }] }, 'Done.'] });
await step.expect({ files: { 'notes.md': 'two\n' }, requests: rows => assert.match(rows[0].wire, /Tidy the notes/) });
```

- Assert what the world shows (files, persisted state, what the fakes received), not what the host reports about itself.
- Gates that fail until another item lands carry `{ todo: '<item>' }` and name it; remove the mark when it merges.
- No paid model call, no network beyond 127.0.0.1, no production state. Keys are synthetic.
- Every 16 KB of state is a shard file the store writes; on a slow disk keep fixtures as small as the gate allows.
