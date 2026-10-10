# 0.63 isolation contract (lead, team L)

Source of truth for behaviour: the final design `wt-design-063.md` (§ numbers below are its sections). This file
says what the teams code against and what may not change without the lead. Wire formats are in
`docs/specs/stream-protocol-v2.md` §8.6–8.8.

## Files

Read only for everyone but L (change requests go to L):

| File | Holds |
|---|---|
| `git-isolation/contract.mjs` | `ISOLATION_READY` (the one release gate, §0.5), reasons, folder and ref names, merge labels, conflict kinds, statuses, `LIMITS`, `HOST_CARDS`, `ISOLATION_ERRORS`, `MODEL_TEXT`, `notImplemented()`, shared JSDoc typedefs (`RootInfo`, `Isolation`, `Snapshot`, `Conflict`, `ApplyOutcome`) |
| `git-isolation/CONTRACT.md` | this file |
| `packages/sdk/src/agent-merge.mjs` | `agent_merge` name, schema, description, `DELEGATE_ISOLATION_TEXT`, `agentMergeTool()` |
| `web/src/api/types.ts` (0.63 block), `web/src/api/worktree-api.ts` | web shapes and the typed client |
| `docs/specs/stream-protocol-v2.md` §8.6–8.8 | routes, fields, errors |
| `test/isolation-contract.test.mjs`, SDK `test/agent-merge-contract.test.mjs` | guard the names above (owners may extend, never weaken) |

Stubs whose bodies the owners write. Exported names, parameters, return shapes and error codes are stable; owners
may add exports or internal helpers, but renaming or reshaping goes through L.

| Stub | Owner |
|---|---|
| `git-isolation/index.mjs` (`IsolationEngine`), `env.mjs`, `snapshot.mjs`, `merge.mjs`, `writer.mjs`, `records.mjs`, `rollback.mjs` | T1 |
| `workspace-roots.mjs` (`RootResolver`), `worktree-service.mjs` (`WorktreeService`) | T2 |
| `session-worktree-service.mjs` (`SessionWorktreeService`), `turn-checkpoint.mjs` (`TurnCheckpoint`) | T4 |
| `git-init-service.mjs` (`GitInitService`) | T5 |

Convention: a stub method throws `notImplemented(name)` (`status` 501, `code` `not_implemented`); constructors only
store their options and never throw, so services can be built and wired before their bodies exist. Use test doubles
for another team's stub. Other teams import `git-isolation/index.mjs` (or `contract.mjs`) only — the engine
submodules are T1's internals. Import with literal relative specifiers: the desktop build ships `git-isolation/`
by following imports from shipped modules.

## Cross-team surface

- **IsolationEngine** (T1, `git-isolation/index.mjs`): `isolation`, `snapshot`, `pin`, `merge`, `apply`, `diff3`,
  `take`, `fileSha256`, `resolved`, `rollback`, `rollbackTurn`, `applies`, `applyDetail`, `applyPatches`,
  `recover`, `resolveInterrupted`, `sweep`, `lock`. Constructor `(store, { git, execRunning, attributable,
  interactions, now })`. `apply` waits for `execRunning` and git operations, takes the repository lock, snapshots the
  target, merges, writes, records — callers never write project files themselves.
- **RootResolver** (T2): `rootOf({ projectId, sessionId?, agentId?, actionId? }) → RootInfo`, `peek`, `invalidate`.
  Never answers P for a missing worktree (`worktree_missing`) or a session worktree not yet created
  (`worktree_pending`).
- **WorktreeService** (T2): `checkSpace` (asynchronous since B8, awaited before `agent_delegate` returns), `create`, `remove`, `setState`,
  `record`, `ownerOf`, `list`, `applyWorktree`, `discardWorktree`, `repair`, `rebuild`, `reconcile`, `sweep`.
- **SessionWorktreeService** (T4): `ensure`, `syncStart`, `applyAtFinish`, `applyOnHandBack`, `applyIdle`,
  `answerConflict`, `answerCreate`, `archive`, `unapplied`.
- **TurnCheckpoint** (T4): `start` (handle with `ready` and `gate(inner?)`: the turn's write wait, passed to
  `createRnaRuntime` as `toolRun.wait` and run in the session's `beforeTool` before dispatch, beside the ToolPolicy's
  constraint judgment and before its pre-write baseline), `end`, `attributable` (→ the engine's `attributable` option).
- **GitInitService** (T5): `init`, `preview`, `confirm`.
- Route factories (new files, owners as in design §16), same shape as `createWorkspaceGitRoutes`:
  `createApplyRoutes({ store, body, engine })` (T1, `apply-routes.mjs`: `…/applies…`, `…/turns/:turnId/rollback`)
  and `createWorktreeRoutes({ store, body, worktrees })` (T2, `worktree-routes.mjs`: `…/worktrees…`), each returning
  `handle(req, { pathname, url, send }) → boolean`, answering thrown `{ status, code }` errors as
  `send(status, { error, code, ...extra })`. Writes refuse while maintenance holds (503) — L registers them behind
  the same gate as the git writes.

## T3 ↔ T4: `pendingMerges()`

```js
// BuiltinAgentService (T3)
pendingMerges(sessionId) → Array<{
  agentId: string, role: 'worker', task: string | null, turnId: string,
  status: 'conflict' | 'pending', reason?: 'cancelled' | 'read_only' | 'unfinished' | 'parent_idle' | 'apply_interrupted',
  conflicts: { path: string, kind: string }[],
}>
```

- Synchronous, reads state only, never throws (unknown session → `[]`), oldest `endedAt` first.
- Lists this session's finished workers (status not `running`) whose `delegation.merge.status` is `conflict` or
  `pending`. Workers still running, merged, dropped, `nothing` or `shared_root` are not listed, nor is a merge held on
  the user's git operation (`git_operation`: the host merges it itself if the operation ends while a turn of the parent
  runs, and leaves it `parent_idle` otherwise), nor a merge a crash cut off whose write still waits on the user's
  "interrupted apply" card (`apply_interrupted` with an apply record still `interrupted`).
- Which ended workers T3 merges by itself (decision of 2026-10-05, following mu swarm-isolation.ts:279-370): only one
  that finished normally while its parent conversation has a running turn (partial), or whose result opens a follow-up
  turn of its idle parent (`continueAfter`; all or nothing). Every other worker is pinned and left `pending` with
  `reason` `cancelled`, `unfinished` (failed, interrupted, out of steps — whether or not the parent runs), `read_only`,
  or `parent_idle` (no turn of the parent running when the host settled it — idle, paused, restarting — and no result
  that would open one: no `continueAfter`, or an emergency stop, an archived conversation or a recovery review that
  makes delivery only show the notice): nothing written, no apply record, W kept (`kept`) until agent_merge, the card's
  merge or discard, or the model acting on this reminder settles it. Startup recovery applies the same rule (an
  interrupted worker is `unfinished`), except for a host merge a crash cut off after it began writing: its apply
  records are adopted into `merge.applyIds` and the merge is finished (or left `apply_interrupted` while the engine's
  "interrupted apply" card decides). `BuiltinAgentService.holdReason()` decides. The panel's apply / discard of a
  worker's W whose delegation is still `pending` or `conflict` is refused (409 `worktree_worker_pending`).
- T4 calls it at turn end step 1 (`finishTurn`, before `settleTurn`), once per turn: non-empty → continue the turn
  with `{ source: FEEDBACK_SOURCES.workerMerge, text: MODEL_TEXT.workerMergeReminder(rows) }`, and record that the
  reminder was given on the turn (`turn.mergeReminded = true`) so a resumed turn does not repeat it.
- The reverse direction: when T3 merges a worker into a session worktree S while the session is idle (§4.1 step 4),
  it calls `sessionWorktrees.applyIdle(sessionId)` (T4). L injects `sessionWorktrees` into BuiltinAgentService.

## T4 → everyone: `execRunning`

```js
// RuntimeController (T4)
execRunning(projectId) → number
```

- Direct-mode `project_exec` runs in progress for the project: +1 on `tool_execution_start` of `project_exec` in a
  foreground turn whose root is the project folder (RootInfo.kind `project`), −1 on its `tool_execution_end`; a
  run's leftovers are dropped when the run ends. Isolated roots (S, W, B) never count.
- Synchronous, never throws, `0` for unknown projects. Typedef `ExecRunning` in `workspace-roots.mjs`; default
  `noExecRunning`.
- L wires it: `new IsolationEngine(store, { execRunning: id => runtime.execRunning(id), attributable: (p, t) =>
  checkpoints.attributable(p, t) })` and `new RootResolver(store, { git, execRunning })`. Nobody else waits on it:
  `IsolationEngine.apply` waits up to `LIMITS.execIdleWaitMs` (120 s) before any write into P, then writes anyway
  (CAS still protects).

## Other seams

- **T3 ↔ T5, `agent_merge({ changeId })`**: T3's merge handler forwards a `changeId` call to
  `ProjectInitiativeController#backgroundMerge({ projectId, sessionId, changeId, action, path, page, take, callId },
  signal) → ToolResult` (T5), whose JSON is the agent_merge result shape (`AGENT_MERGE_RESULT` comment in
  `agent-merge.mjs`). L injects it as `builtinAgentService.backgroundMerge`; unwired → `merge_unknown`.
- **agent_merge in the SDK (T3)**: `createDelegationTools` adds `agentMergeTool(control.merge)` to the background set,
  `DelegationControlHandlers` gains `merge`, `DELEGATION_TOOL_NAMES` gains `'agent_merge'`, `DELEGATE_TEXT`'s last
  sentence becomes `DELEGATE_ISOLATION_TEXT`; `index.mjs` exports and `index.d.ts` declares:
  ```ts
  export const AGENT_MERGE_TOOL_NAME: 'agent_merge';
  export const AGENT_MERGE_ACTIONS: readonly ['merge', 'show', 'take', 'resolved', 'drop'];
  export const AGENT_MERGE_TEXT: string;
  export const DELEGATE_ISOLATION_TEXT: string;
  export interface AgentMergeArgs { agentId?: string; changeId?: string; action?: 'merge' | 'show' | 'take' | 'resolved' | 'drop'; path?: string; page?: number; take?: { path: string; side: 'current' | 'incoming' }[] }
  export function agentMergeTool(merge: (args: AgentMergeArgs & { callId: string }, signal: AbortSignal) => MaybePromise<ToolResult>): AgentTool;
  // DelegationControlHandlers gains:
  merge(args: AgentMergeArgs & { callId: string }, signal: AbortSignal): MaybePromise<ToolResult>;
  ```
- **createWorkspaceTools options (T2 implements; T3 writes this line at `index.d.ts` :283)**:
  ```ts
  export function createWorkspaceTools(cwd: string, options?: { deniedPaths?: string[]; maxFileBytes?: number; includeMutations?: boolean; execLogDir?: string; maxOutputBytes?: number; execTimeoutMs?: number; sandbox?: boolean; sandboxExtra?: string[]; sandboxDeny?: string[] }): Promise<RegisteredTool[]>;
  ```
  `sandboxProfile(root, { home, extra, deny })` appends `(deny file-write* (literal "<root top>/.git"))` and the
  deny list; `project_exec`'s description becomes fixed text (sandboxing goes to `details` and refusals);
  `workspacePrivateSegment` gains `.rna`.
- **Host root options (T2)**: `CapabilityService#registry(project, memoryTools, { …, root, isolated })` (root empty
  → P; `isolated` forces the sandbox); `createRnaRuntime({ cwd, isolated?, instructionsRoot? })` passes `{ root: cwd,
  isolated }` to the registry and reads AGENTS.md / CLAUDE.md from `instructionsRoot ?? cwd` (T4 passes
  `RootInfo.project`); `GeneEvolutionService#guardHook(projectId, { turnId, root })`;
  `MediaToolsService#createTools(project, { root })` and the vision service alike (T4 passes the session root from
  `managementTools`); `TerminalService#create(projectId, { sessionId, … })`; inspection reads accept `?sessionId=`.
- **WorkspaceGitService (T1)**: `run(cwd, args, { maxBytes, timeoutMs, killSignal, env, input, engine })`;
  constructor option `owners: realPath => ({ rna, owner })` replaces the `worktreeOwner()` placeholder (L wires
  `worktrees.ownerOf`); constructor option `engine` so `discard` takes a `user_discard` checkpoint first (§0.3-1).
- **Session creation (T4 + L)**: `store.createSession({ …, worktree: boolean })` validates a boolean and sets
  `session.worktree = { id: <new record id>, state: 'pending' }`; L's `POST /api/sessions` first awaits
  `worktrees.isolation(projectId)` and answers 409 `worktree_unavailable` with `reason` when it is off.
  `PATCH /api/projects/:id { git: { sessionWorktreeDefault } }` is T4's (store). `store.mjs:500` defaults
  `project.git = { sessionWorktreeDefault: false, worktrees: [], applies: [] }` on load (T4).
- **Web (T6)**: reads the 0.63 fields in `api/types.ts` and calls `worktreeApi` (`api/worktree-api.ts`); adds
  `worktree?: boolean` to `createSession`'s input in `api/client.ts`; mocks every `worktreeApi` route in `mock/*`
  (the mock answers `isolation: { enabled: false, reason: 'not_ready' }` by default). Every two-step call sends
  `confirm` only on the user's second click.
- **Cards**: ids and options are `HOST_CARDS`; each owner registers its own answer handler with the interaction
  service. Text is the owner's, via `say({ zh, en })`.
- **Model-facing texts**: `MODEL_TEXT` (host) and `agent-merge.mjs` (SDK), English, never per project.
- **Phase**: `turn.phase = 'applying'` while a turn applies to the project folder (T4; the web labels it).

## Additions the teams made (folded in at integration; all additive)

- **IsolationEngine (T1)**: `ApplyRequest` gains `incomingRoot` (hard-link check), `notMerged` (build it with the exported
  `notMergedOf(snapshot)`) and `cleanOnly` (`all` + `cleanOnly`: the clean part all or nothing, used at pause, stop and
  failure; plain `all` with any conflict writes nothing). New methods `compose(projectId, tree, entries)`,
  `syncBase(projectId, { current, previous, paths })` (base′, §4.2 step 3 / §7.3), `discardCheckpoint`, `primeExcludes`,
  `close`; constructor options `ready`, `sandbox`, `pollMs`, `execWaitMs`, `hooks`. `take()` answers ApplyOutcome plus
  `taken`. `MergeResult.writes` carry `expect`; every path in MergeResult and ApplyOutcome is root-relative. A
  `writing` row's ref has the planned result (before plus the planned writes) as its second parent, not R. `recover()`
  sets `engine.recovering`, and `apply()` / `take()` wait for it, so no startup merge writes between a crashed write
  and its recovery. Row fields `targetWorktreeId`, `pending`, `undoesTurn`, `recovered`, `card` (the view hides
  `pending`, `card`, `targetWorktreeId`); rollback records carry the undone turn's `sessionId` / `turnId` in `source`.
- **Worktrees and roots (T2)**: records may carry `laid` and `gitName` (RootResolver and `worktreeEnv` honour it);
  `WorktreeService` takes `statfs` (test seam); `GET …/worktrees` rows carry `root` (worktree + prefix). An isolated
  registry denies all of P (`sandboxDeny: [P]`), stronger than `<W>/.git` alone; a laid-down path not ignored inside
  the worktree gets an exact `/<prefix><path>` line in the common info/exclude. `TerminalService.create` returns a
  promise when `sessionId` is given. Exports `gitignoreLiteral`, `worktreeRecord`, `isolatedProjectFolder`,
  `previewDeniedPatterns`, `escapeGlob`, `viteEntryFor`, SDK `EXEC_DESCRIPTION`, `SANDBOX_CACHES`.
- **Workers (T3)**: `BuiltinAgentService` takes (or is assigned) `engine`, `roots`, `worktrees`, `sessionWorktrees`,
  `backgroundMerge`; `this.recovery` settles when startup recovery has pinned (and, by the rule above, merged or left
  pending) the workers the restart interrupted or whose end the shutdown cut short; `userMerge`
  behind `POST /api/v2/sessions/:id/agents/:agentId/merge`. Delegation fields `isolated`, `mergeAtStart`,
  `worktree.removed`, internal `mergeWork` and `merge.by: 'user'` (merged from the card: agent_merge drop refuses it,
  `merge_user_merged`); merge reasons `interrupted`, `apply_interrupted`, an engine error code, and `dropped` +
  `missing`. Startup recovery waits for `IsolationEngine.recovering` before it reads a worker's apply records.
- **Sessions and turns (T4)**: `turn.apply.card` / `settledBy` / `reason`, `turn.worktreeCreate`, worktree `marks`,
  `REFS.worktree(id, 'premerge')`, user item `hostContext` and `source: 'host-worktree'`, host notes with source
  `host-worktree-sync`, a second card in one turn with actionId suffix `:<n>`. `SessionWorktreeService.recover()`,
  `watch()`, `close()`, `waiting()`; `syncStart` answers `feedback` too; `applyAtFinish` takes `onApplying`,
  `onWaiting`, `signal`; `applyOnHandBack` takes `signal`, `onWaiting`. `SessionDeletionService.confirmWorktree()`;
  `store.hostTurn()`.
- **Background and init (T5)**: `ProjectInitiativeController` takes `engine`, `worktrees`, `roots` (or
  `attachIsolation()`); it settles cut-off background worktrees itself on its first upkeep (`recoverWorktrees`).
  `revertBackgroundChange(projectId, changeId, input)` answers a promise for git rows (two steps). Git change rows and
  `directFixes[]` git rows carry the fields listed in the protocol doc §8.6; background worktree records carry `base`
  and an internal `merge`; reverse-merge labels are the local `BACKGROUND_REVERSE_LABELS` (`this-background-work` /
  `project-folder`), restores into B use `background-restore`. `GitInitService` options `appRoot`, `limits`, its
  `pending` map, exports `GITIGNORE_HEADER`, `ALWAYS_IGNORED`, `ECOSYSTEM_RULES`, `exactPattern`, `ecosystemLines`,
  `secretLines` (B8), `venvLines`; its errors spread `details`.
- Error codes added to `ISOLATION_ERRORS`: `worktree_request_invalid`, `worktree_remove_failed`,
  `worktree_repair_failed`, `worktree_unapplied`, `delegation_unknown`, `merge_request_invalid`, `merge_settled`,
  `rollback_request_invalid`, `applies_request_invalid`.

## Safety review (after integration)

Behaviour the adversarial review added or tightened; guarded by `test/isolation-adversarial.test.mjs` (protocol §8.7
"安全审查补充"):

- `IsolationEngine.lock` is re-entrant only while the outer hold lasts (a timer or callback the holder started queues
  once the hold is over), and `Store.subscribe` runs each listener in the async context it subscribed in, so a
  listener woken by a mutation inside a held lock never borrows that lock.
- Every recorded write (`recordedWrite`, so apply, take, rollback, resolveInterrupted) leaves out, before its
  checkpoint, entries no write may carry: gitlinks, paths inside another repository the target holds (both kind
  `submodule`), and into P content with an Rna conflict-marker line (kind `content`). `all` without `cleanOnly` then
  writes nothing. The writer itself also refuses gitlinks and, into P, marker content (last line of defence). `take()` never writes `unsafe_symlink` / `submodule`
  conflicts, not even `byUser`.
- `unsafe_symlink` resolves a new link through the links of the result tree (chains included) and also flags links
  into any `.git` or the top `.rna`.
- A write that replaces a folder with a file, or a link with a real folder, goes through whole (CAS against "absent"
  once the plan's own deletes emptied the folder; never through the link). A write refused before any file changed
  drops its record instead of leaving it `writing`; `error.wrote` tells the two apart.
- Rollback: a rollback limited to `paths` does not mark its records `rolled_back`; a record already rolled back offers
  only the files that rollback skipped (`force`, `forceOnly` in `planRollback`).
- Startup recovery never writes into P while a merge / rebase / … is in progress there: the row becomes `interrupted`
  with its card.
- `merge()`, `apply()` and rollbacks refuse git < 2.38 with 409 `git_unavailable`, `reason: 'git_too_old'`.
- `discardCheckpoint` refuses (409 `checkpoint_oversized`, `paths`) a discard naming a file over
  `LIMITS.snapshotFileBytes`: no checkpoint can hold it.
- Snapshots rebuild the private index once when `write-tree` fails (blobs pruned by the user's `git gc`); `readBlobs`
  batches by size (64 MB), so several files near the snapshot limit no longer overflow one read.

## After the reviews (additive; folded in at the gate close-out)

- **Review additions (T1–T5)**: `TurnCheckpoint.attributable()` also answers `windows` (the turn's attempts), and a
  direct-mode turn rolls back only the worker / resolve records written inside them. `rollbackTurn` refuses
  `apply_blocked` when a record of the turn is `writing` / `interrupted`. `worktree-service.mjs` exports
  `holdsRnaMarkers`; `…/worktrees/:wtId/apply` lists files holding Rna markers as `content` conflicts and never writes
  them. `WorktreeService.remove()` of a session worktree resets the owning `session.worktree.state` to `pending`.
  `baseOf()` uses `record.base` for background worktrees. Shutdown aborts `BuiltinAgentService.closing`,
  `BackgroundWorktrees.stopping`. `list()` rows have `path: null` (and no `root`) when the repository cannot be found.
- **IsolationEngine (gate close-out)**:
  - `rollbackTurn` of a worktree-session turn takes the turn's `turn` records and the `resolve` records its conflict
    card wrote into P (a session worktree in `source.worktreeId`), newest first, as one rollback record; resolve rows
    carrying `undoes` (an interrupted apply's "go back to before") stay out, there and in direct mode's `also`.
  - `take()` accepts `signal` and `onWaiting` (as `apply()`).
  - `markRolledBack(projectId, applyId, { by })`: a record of S / B rolled back there by its owner becomes
    `rolled_back` (`rolledBackBy` = the rollback record, which gets `undoes`); records of P are left to `rollback()`.
  - `sweep()` also answers `checkpointsExpired`: `expireCheckpoints()` sets `turn.checkpoint = { state: 'expired',
    reason: 'expired', expiredAt }` for turns whose `refs/rna/turn/<id>` it swept (or that is gone and the turn is past
    `LIMITS.turnRefDays`); it also empties crash leftovers older than a day from `<commonDir>/rna/tmp`.
  - Writer: every rename and delete re-checks that the folder it lands in still resolves to itself under the root's
    realpath (`sameFolder`, exported from `index.mjs` and `writer.mjs`) — before, and again after the rename (a file
    that landed through a link swapped in at the last instant is taken back out). Refusals count as races
    (`changed_during_merge`; `all` puts everything back) and are logged `write_path_tampered`; the outcome may list
    `tampered`. Temporary files are made in `<commonDir>/rna/tmp` (no sandboxed process can write there; next to the
    target only across volumes), and a file that did not exist is placed with `link()` so it never replaces one that
    appeared meanwhile. Test seam: `hooks.beforePlace(path)` (after the last check, before the rename).
- **WorktreeService**: `remove()` and `layDependencies()` move, delete and copy only through folders `sameFolder`
  confirms. `releaseProject(project)` (registered with `store.onProjectDeleted` in the constructor; `releases` holds
  the promise per project): a deleted project's worktrees are removed when `git status` against their base / seed is
  clean and they hold no ignored files of their own, otherwise unlocked and left in place; refs stay.
- **Store**: `onProjectDeleted(hook) → unsubscribe`; `deleteProject` calls each hook after the deletion with `{ id,
  workspace, git }` as the row was (a throwing or rejecting hook never stops the deletion).
- **SessionWorktreeService**: `answerConflict(sessionId, turnId, choice, { signal })` waits for a git operation in P
  with one `waiting()` notice, under `this.closing` (aborted by `close()`); a stopped answer clears
  `turn.apply.card.answered` so `recover()` (which now rescans the cards) answers it again; apply ids are noted on the
  turn as each write lands. Attachment copies into S go only through folders `sameFolder` confirms.
- **WorkspaceInspectionService**: a session whose `worktree.state` is `pending` reads and previews P (scope
  `pendingSessionId`, stale once the worktree exists); constructor option `previewSandbox` (test seam).
- **Dev preview** (`workspace-dev-preview.mjs`): `isolatedPreview(scope)`, `previewSandboxProfile(scope, cacheDir, { stateFile, daemonPort })`
  (SDK `sandboxProfile(root, { deny: [P] })` with Rna's state unreadable and the daemon port unreachable, as for
  project_exec, plus the preview's cache folder, readable and writable); `startVitePreview` options `sandbox`
  (default SDK `sandboxAvailable`) and `say`; an isolated root's worker runs under `sandbox-exec`, refused without it
  (409 `PREVIEW_SANDBOX_UNAVAILABLE`). The worker gets `sandboxed: true` and makes an empty `node_modules` in the
  previewed folder when none is nearer than P's (Vite writes its bundled config to the nearest `.vite-temp` and falls
  back only on EACCES, not the sandbox's EPERM).
- **BuiltinAgentService**: dropping a worker merged into S calls `engine.markRolledBack` for its S rows.
- **api-v2**: git `backgroundChanges[]` rows also carry `applyIds` (≤ 20), `hold`, `handedTo`.
- **TurnCheckpoint**: `turn.checkpoint.state` may be `expired` (typedef).
- **Adversarial review of the close-out (fixed)**:
  - `sameFolder` also accepts a folder whose on-disk name differs from the plan's spelling only in case or Unicode
    normalization (realpath answers the stored name on APFS / HFS+), when it is inside the root, as deep, and no
    segment on the way is a link; before, every write into such a folder of P (a case-only rename git does not see,
    a Finder-made decomposed name) was refused as tampered and `all` applies were blocked for good.
  - `IsolationEngine.rollbackRecords(projectId, applyIds, input, { key, source })` (additive): every P record still in
    effect among `applyIds`, newest first, as one rollback record (two steps, same refusals as `rollback()`; records of
    a worktree are left out, none of P → `apply_target_denied`). `ProjectInitiativeController.revertGitChange` uses it
    for a git change set with more than one record (`key: change:<id>`); `syncGitRows` follows all of a set's P
    records (`reverted` once none stands, `kept` again once one does).
  - `expireCheckpoints` marks every turn whose ref this sweep deleted, whatever the turn's own dates.
  - `SessionWorktreeService.postConflictCard` keeps the turn's card while its answer is still to be carried out (being
    answered, or stopped by a shutdown and taken up by `recover()`): a hand-back in between (the startup idle apply)
    no longer posts a second card that stays waiting after the answer settles the conflict.

## L at integration

Done (0.63.0 integration):

1. `server.mjs` builds one `WorkspaceGitService` (`workspaceGit`), shared by the panel routes, git init, the engine
   and the worktree service, so every write queues on one repository FIFO; `IsolationEngine` (with `execRunning` →
   `RuntimeController#execRunning`, `attributable` → `TurnCheckpoint#attributable`, `interactions`), `RootResolver`,
   `WorktreeService`, `TurnCheckpoint`, `SessionWorktreeService`. `workspaceGit.engine` / `.owners` are assigned after
   construction. Injected into RuntimeController (`roots`, `sessionWorktrees`, `checkpoints`), BuiltinAgentService
   (`engine`, `roots`, `worktrees`, `sessionWorktrees`; `backgroundMerge` → `ProjectInitiativeController#backgroundMerge`),
   ProjectInitiativeController (`engine`, `worktrees`, `roots`), SessionDeletionService, TerminalService and
   WorkspaceInspectionService (`roots`).
2. Routes: `createApplyRoutes`, `createWorktreeRoutes` after the maintenance gate (POST → 503 `maintenance_held`);
   `POST /api/sessions` refuses `worktree: true` with 409 `worktree_unavailable` + `reason` when isolation is off;
   `DELETE /api/sessions/:id` calls `confirmWorktree` (`confirm: true` in the body); the background change revert route
   awaits and passes the body. Error bodies of isolation codes carry `code` and `reason` / `unapplied` / `worktreeId`.
3. Startup: `engine.recover()` before `builtinAgentService.recover()`; then (live daemon) `worktrees.reconcile()` per
   project, `sessionWorktrees.recover()` (starts its watcher, applies idle sessions), `engine.sweep()` and
   `worktrees.sweep()`, and the sweeps again daily. Shutdown closes the engine's and the session service's watchers and
   waits for the startup chain.
4. `api-v2.mjs`: `ProjectSummary.git = { sessionWorktreeDefault, init }` only (guarded by a size test with 500 records
   and 60 worktree rows); git `backgroundChanges[]` rows carry `kind`, `applyId`, `applyIds`, `worktreeId`,
   `conflicts` (`{ path, kind }`), `hold`, `handedTo`.
5. `agent_merge` added to the reserved tool names (SDK `project-genome.mjs`, `capability-install-service.mjs`) and to
   the web's tool kinds.

Gate close-out (host, done): the review items that had to close before the gate — host writes into W / S / B
re-check their folders (writer, attachments, worktree cleanup); a worktree's Vite preview runs under the sandbox;
the session card answer has a signal and a timeline line; deleting a project releases its worktrees; dropping a worker
merged into S settles its record; swept turn refs expire their checkpoints; a worktree turn's rollback takes its
card's resolve records; a pending worktree conversation previews P. Guarded by `test/isolation-closeout.test.mjs`.

Still open:

1. Versions (host 0.63.0, SDK minor) — the orchestrator bumps them.
2. ~~Desktop walk-through (design §13 "桌面实测") rendering the real UI, then flip `ISOLATION_READY`~~ — done
   2026-10-04 on a test project with a real model (all ten steps passed); the gate is open since 0.63.3.
3. After deployment: §10 previews for the three project folders, shown to the user, initialised only on their yes.

0.64.0 additions:
- **Undo initiator (additive):** `APPLY_INITIATORS` in contract.mjs. `rollback(projectId, applyId, input, { initiator })`, `rollbackTurn(…, input, { initiator })`, `rollbackRecords(…, { key, source, initiator })`, `resolveInterrupted(projectId, applyId, choice, { initiator })` (on `restore`) and `apply({ …, initiator })` record `initiator` on the row. `rollback()` keeps the undone row's whole source. `rollbackFlow` records `partial: true` for a `paths` rollback. `BackgroundWorktrees.rollback(projectId, ids, { initiator })`; `BuiltinAgentService.dropWorker(identity, record, { initiator })`. `workspace-events.mjs` derives the user's undos for the models.
- **Turn changes (additive, read-only):** `turnChanges(projectId, turnId, { sessionId? }) → { source: 'records'|'checkpoint', files, applyIds?, uncovered?, truncated? } | { source: 'tools', reason }` and `turnPatches(projectId, turnId, { sessionId?, paths }) → { patches: [{ path, diff } | { path, sections: [{ applyId, rolledBack?, diff }] }] }`, reusing the apply-record diff helpers; errors `turn_not_found` 404, `turn_changes_unavailable` 409 (with `reason`), `git_paths_invalid` 400. Routes: `GET …/turns/:turnId/changes[/patches]` in apply-routes.mjs. Patch requests match paths literally.
- **work.coverage receipts:** a turn that ran in a conversation worktree checked the copy, not the project folder, so it is not a receipt; applies and rollbacks into the project folder count as later changes.
- **Review follow-ups:** a `rollback` record's `skipped` first lists the files its plan left as they were (at most 20: `changed_after`, `conflict`, `unattributable`), then the write's own; `partial` still marks only a `paths`-limited rollback. `IsolationEngine.undoWrites` (server.mjs wires it to `ProjectObservationService`) and `userUndoWrite(projectId)`: a write with `initiator: 'user'` into P, and the `user_discard` checkpoint, begin and end an undo write; `ProjectObservationService.undoWrite(projectId) → { end(paths) }` folds those files into the observation baseline by fingerprint, and scans overlapping the write are dropped. `turn.checkpoint.endedAt` (each attempt's end snapshot). `turnChanges` direct mode: files no call or record of the turn wrote by name are left out or listed `unattributed: true`; `shared: [{ path, applyId }]` for files another owner's record also wrote while the turn ran; `rolledBack` only when each record of the turn that wrote the file was rolled back; renamed files get rename patches. A background run whose change set is deferred, merge_conflicted, discarded, or kept with conflicts checked its own copy and is not a work.coverage receipt; a worker's merge belongs to the turn that delegated it.

0.65.0 additions (P0):
- **IsolationEngine (holds):** `apply({ …, hold })` / `take({ …, hold })`: a git operation in P throws `git_operation_in_progress` (409, `operation`) before anything is written instead of waiting. New: `projectBusy(projectId) → Promise<string|null>`, `operationRefused(operation)`, `whenProjectFree(projectId, key, fn) → cancel` (fs.watch on the git dir plus a `freePollMs` poll; keyed; not active work), `waitingFree(projectId)`, constructor option `freePollMs`; `close()` stops the watches. `rollbackFlow` refuses an operation that began after its check. `resolveInterrupted(…, { initiator, hold })`; `settleCards` runs projects independently and holds an answered interrupted card (one `worktree` notice, retried when the operation ends).
- **BackgroundWorktrees:** `operation(projectId)`; `apply`, `finish`, `settle`, `settleApply`, `applyClean`, `applyBackground` answer `{ status: 'held', reason: 'git_operation', operation }`; `handoff(bg, { …, signal })` refuses merge/take/drop into P with `git_operation_in_progress`; `rollback()` rolls back `session:<id>` rows inside that S (kind `rollback`, partial, then `markRolledBack`), answers `session` paths, and rethrows `git_operation_in_progress`.
- **ProjectInitiativeController:** git change rows may carry `hold: 'git_operation'` and `operation` (no `retryAt`); `retryWhenFree`, `projectGitUpkeep` (per project, coalesced), `recoverWorktrees()` → `recoverProjectWorktrees(projectId)` per project concurrently; a held clean_only/background answer is recorded as `answer` only once carried out.
- **BuiltinAgentService:** merge reason `git_operation` (+ `operation`); `pendingMerges` leaves it out; `retryHeldMerges` / `resumeHeldMerges`; `mergeOnce(…, { signal, hold })`; `remerge` and `takeSides(…, { signal })` hold → agent_merge refusal `git_operation_in_progress` (English model text), route 409.
- **SessionWorktreeService:** replaces the `answerConflict` waiting line: `answerConflict` throws `git_operation_in_progress` and `react()` holds the answer (`heldAnswers`, one `waiting()` line per turn). `forward` / `applyAtFinish` / `cleanApply` take `hold`; `applyOnHandBack`, `applyIdle`, `archive` hold (`turn.apply.reason: 'git_operation'`; `archive → { state: 'held' }`); `recover()` runs projects concurrently. `RuntimeController.afterTurn` passes `hold: true`; only `finishTurn`'s apply waits (turn signal).
- **WorktreeService.applyWorktree:** 409 `git_operation_in_progress` during a git operation in P.
- **Background change lines (0.65, MEM-3)**: `ProjectInitiativeController.settleChange(projectId, changeId, change, text)` settles a background change set row and rewrites its conversation line in one Store write (`applyDeferred`, the conflict card's discard and apply answers); a change-set line is memory evidence only once its set is settled. `settleWorkLines` marks a line cut off by a restart while its run held a background worktree `backgroundWork.recovering: true`; the rewrite by `recoverWorktrees` (a new `backgroundWork`) drops it.
- **Project mind (X-5, consumer)**: `project-mind.mjs` reads `backgroundChanges[]` (`id`, `actionId` incl. `<id>-direct`, `status` kept/deferred/merge_conflicted/reverted, `discarded`, `applyId`), `directFixes[]` (`actionId`, `status`), `turn.apply.status` (`applying`/`pending`/`conflicted` = not yet in P, `applyWaiting`) and the user's undos via `deriveWorkspaceEvents` to settle and reopen commitments and agenda items; a change to these statuses must keep `workChangeOutcome` / `applyWaiting` in step.
- **Review follow-ups (0.65.0):** the user's git operation is checked only when something can have changed it (a pass about to write P, or a held set whose watch stopped waiting); no git process per store change. A worker merge resumed after a git operation that fails for another reason records `merge: { status: 'pending', applyIds, reason: <code> }` and appears in `pendingMerges`. A full apply of the conversation worktree into P settles other turns' `pending`/`applying` applies without a conflict as `{ status: 'applied', settledBy }`. `workload.activeWork` includes host merges in progress; `BuiltinAgentService.close()` awaits them. Rollback skipped reason `worktree_gone` for records into a conversation worktree that no longer exists.

0.66.0 (P1, history and cache — not isolation, listed for readers of the journal):
- On append-only Anthropic targets, history economies (settle/prune/forget/fold, history-image offload) apply only at or before the thinking floor; any record that must change the projection immediately is journaled together with `thinking_rebase` in one step (`commitWithRebase`). `historyEditMode(model, provider)` (free | rebase | none) is the single source of truth for both the cold-break economy and idle compaction.

P2 batch B additions (B8, isolation hygiene; released with batch B):
- **Secret files (mu checkpoints.md §2):** `SECRET_FILES` (fixed gitignore-style table: `*.env`, `.env.*` but not `.env.example` / `.sample` / `.template`, `.envrc`, `.netrc`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`; each pattern matches one path segment at any depth, case-insensitively), `SECRET_FILES_VERSION`, `isSecretName`, `isSecretPath` in contract.mjs. A snapshot never hashes a listed path that matches: it stays at the private index's version (HEAD's for a tracked one, absent for an untracked one), so no secret content enters the object store or refs/rna, and no merge, rollback or discard checkpoint carries it. The private index notes carry the table's version (an older index is rebuilt from HEAD once). `Snapshot.secret`: of P every matching path the listing showed; of S / W / B only its owner's changes (snapshot.mjs `secretChanged`): not a copy Rna laid down that is untouched since (the record's `laid` entry carries the copy's `size`, `mtimeMs`, `ino` as made, never its bytes; `IsolationEngine.snapshot` passes the record's `laid`), whatever its source became, and not a file holding the same bytes as P's at the same path. `NOT_MERGED_REASONS` gains `secret`; `notMergedOf()` reports them. `discardCheckpoint` refuses a discard naming one (409 `checkpoint_secret`, `paths`). `WorktreeService.layDependencies(…, { parent })` clones the parent root's own secret files (untracked, or changed since HEAD; ≤ 200) into the new worktree, without an info/exclude line (it would hide P's own file from `git status`); `remove()` moves the ones the worktree's owner changed to the trash.
- **ISO-6:** `IsolationEngine.forgetRoot(projectId, { root })` deletes a root's private index and notes; `WorktreeService.remove()` calls it (lexical and resolved root) after `git worktree remove`, and clears a session worktree's `premerge` ref. `IsolationEngine.sweep()` deletes private indexes no live root uses (P and every worktree not removed, of every project on the repository, archived ones included) whose files are older than `LIMITS.retentionDays` (exact `<16 hex>[.json]` names, regular files only), and answers `indexesDeleted`. `WorktreeService.sweep()` deletes `premerge` with `seed`, `base`, `tip` of expired rows.
- **git gc (the user's decision of 2026-10-05):** `IsolationEngine.sweep()` runs `git gc --auto` (foreground, `gc.worktreePruneExpire=never`) under the repository lock only on a repository whose owner is `rna` (storage.mjs `ownerOf`: a project on it has `git.init.by === 'rna'` in the repository's top folder and its branches, tags, remote-tracking refs and HEAD reach that first commit only), never while a turn of a project on it runs; answers `collected` (common dirs). Every other repository is reported in the storage view, never collected.
- **Storage view (zcode storageCatalog.ts / cleanPlan.ts):** `git-isolation/storage.mjs`: `STORAGE_CATALOG` (worktrees `confirm`, trash / privateIndexes / hiddenRefs `auto`, objects `auto` only for an Rna-owned repository, else `none`), `STORAGE_CLEANABILITY`, pure `repositoryOwner`, `orphanIndexes`, `parseCountObjects`, `applyAggregates`, `worktreeCounts`, and `IsolationStorage({ store, engine, worktrees })` with `view()` (cached, never waited for; a stale one starts a refresh) and `refresh()`. Re-exported from index.mjs. `GET /api/health` (and so `./rna doctor`) carries it as `storage` (server option `storageView`, default on for the live daemon); refreshed after each isolation sweep.
- **ISO-8:** `ApplyRow.ms` (first durable step → settled; a discard: checkpoint → settled) and `ApplyRow.bytes` (content bytes written; writer outcome `bytes`). `TurnCheckpoint.start({ …, onWait })` reports how long a write waited at the gate; `end()` writes `turn.timing.checkpointEnd` with `turn.checkpoint`. RuntimeController records `turn.timing.checkpointWait` (longest gate wait for the start checkpoint or start sync), `startSync`, `applying` (finish apply, plus the hand-back's), and the tool item's `gateWaitMs` (time held at the turn's tool gate, ≥ 1 ms only).
- **ISO-3 / ISO-7:** `end()` takes the end snapshot, reads the hold and closes the window inside `engine.lock` (re-entrant pin); `capture()` closes an attempt's window a restart left open at the next attempt's start, and `attributable()` reads any open window as ending where the next begins (as rollbackTurn's `inside()`).
- **ISO-10:** `checkSpace` / `trackedBytes` are asynchronous (`WorkspaceGitService.run`); `create()` runs `worktree add --no-checkout` under the repository lock and fills the folder after it with `read-tree -u --reset <seed>` under the record's GIT_DIR / GIT_WORK_TREE (`checkout()`).
- **Deleting a conversation with pending workers:** `WorktreeService.unmerged(projectId, worktreeId) → { files, paths?, secret?, missing?, unreadable? }` (base → a fresh pinned tip, plus the secret files the worker changed, `secret` counting them). `SessionDeletionService.confirmWorktree` also lists the conversation's worker copies whose delegation merge did not settle (pending, conflict, running) and still hold files the merge did not apply: 409 `worktree_unapplied` with `unapplied` and `workers: [{ agentId, worktreeId, files, task?, role? }]`; `removeWorktree` removes the conversation's worker copies with its session worktree (tips pinned). The route passes `workers` in the error body. Secret files a worker or the conversation's own worktree changed are counted too (they leave with the copy, into the trash, never Git): `workers[].secret?`, and `secret?` on the error body (and the result) for all of them; `SessionWorktreeService.unapplied()` answers `{ unapplied, secret? }`.
- **Worktree conversations' secret files (review finding 1):** a forward apply never carries them (S's snapshot does not hold them). `SessionWorktreeService.keptSecrets(ctx, turnId, snapshot)` (after every forward of applyAtFinish / cleanApply) posts one timeline notice per newly kept path (both languages) and keeps `secretTold` / `secretNote` on the worktree record; `secretNoteUpdate(sessionId, turnId)` hands the model `MODEL_TEXT.sessionSecretKept(paths)` once, called from RuntimeController's request hook (key `worktree-secrets:<turnId>`, source `host-worktree-sync`).
- **Background runs' secret files (B8):** `BackgroundWorktrees.settle` / `applyClean` / `applyBackground` add `secret` (B's tip `secret`: its owner's changes, at most 50) to their outcome. The controller keeps it on the change set row (`backgroundChanges[].secret`) and appends `secretText` (both languages: not applied, moved to `.rna/trash.nosync` for `LIMITS.trashDays` when the copy is cleaned up) to the run's line; a run whose only changes were secret files gets no change set, and its working line says so instead of being withdrawn (`secretOnlyLine`); a direct fix's card detail says so too.
- **Panel discard refusals:** `POST …/git/discard` answers 409 `checkpoint_oversized` / `checkpoint_secret` with `paths` (workspace-git-routes.mjs).
- **Second review (B8):** `merge()` enforces the secret rule itself: a SECRET_FILES path (root path) that a tree from before B8 (a conversation's base, a worker's seed, a pinned tip) or a tracked file still names keeps the current side's entry in the result tree, is never written, deleted or reported as a conflict, and is listed once in `notMerged` (`secret`); this covers `apply`, `merge` previews and the panel's counts. `WorktreeView.pending.secret?` (the owner's changed secret files, from `git status` through `secretChanged`; never in `files`); the panel's apply preview and result carry `secret?` (paths, ≤ 50) and `note?` (interface language), the discard preview lists them in `files` too and both discard steps carry `secret?` / `note?`. `SessionDeletionService.unmergedWorkers` also lists a worker whose merge is `merged` while its copy still exists (kept when `mergeWork.unverified`, or not removed), counting the unverified files and its secret files, so `removeWorktree` never takes an unlisted copy. `GITIGNORE_RULES` gains `secret`: `GitInitService` proposes the SECRET_FILES rules matching listed files (`secretLines`, table order, never a `!` rule) and an exact line for any a rule's case missed. `collectGarbage` stops `git gc --auto` (signal, SIGTERM) when a turn of a project on the repository starts; `WorkspaceGitService.run` takes an optional `signal`.
