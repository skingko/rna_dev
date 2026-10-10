// Worktree isolation, 0.63 (design wt-design-063.md): the contract every team codes against. Written by the lead
// (team L); read only for the other teams. Pure data, name builders and fixed model-facing texts only: no git, no
// file system, no state. Behaviour lives in the owning team's modules (see CONTRACT.md next to this file).
//
// Names here are wire and on-disk formats (hidden refs, worktree folders, state fields, card ids): changing one
// after release strands data, so a change is a contract change (CONTRACT.md + docs/specs/stream-protocol-v2.md §8.6–8.8).

/**
 * The release gate (design §0.5). While false, no worktree of any kind is created: workers share the parent's
 * folder, background work keeps DirectFixRecorder, `POST /api/sessions { worktree: true }` is refused with
 * `worktree_unavailable` (reason `not_ready`), and behaviour is 0.62's. Direct-mode turn checkpoints, rollback and
 * git init do not depend on it. Only the lead flips it, after §9 wiring, sandbox, engine and desktop checks pass.
 * Opened in 0.63.3 after the desktop walk-through of design §13 passed on a test project (2026-10-04).
 */
export const ISOLATION_READY = true;

/** Lowest git with `merge-tree --write-tree` (design §1 #21: older git means no isolation, not a second engine). */
export const MIN_GIT_VERSION = Object.freeze([2, 38, 0]);

/**
 * Why isolation is off for a project (`isolation.reason`, design §2). Computed in code, cached in memory, never
 * stored in state. `not_ready`: ISOLATION_READY is false.
 */
export const ISOLATION_REASONS = Object.freeze(['not_ready', 'sandbox_unavailable', 'git_unavailable', 'git_too_old', 'no_repository', 'custom_git_drivers', 'workspace_missing']);

/** Where Rna keeps its copies, inside the project folder P (design §1 #7). `.nosync`: iCloud Drive skips them. */
export const WORKTREE_DIR = '.rna/worktrees.nosync';
export const TRASH_DIR = '.rna/trash.nosync';
export const WORKTREE_KINDS = Object.freeze(['session', 'worker', 'background', 'orphan']);
export const WORKTREE_PREFIX = Object.freeze({ session: 's-', worker: 'w-', background: 'b-' });
/** `project.git.worktrees[].state`. `removed` rows are deleted 30 days after `removedAt`. */
export const WORKTREE_STATES = Object.freeze(['active', 'kept', 'conflicted', 'removed', 'missing']);
/** `session.worktree.state` (no `session.worktree` at all = direct mode). */
export const SESSION_WORKTREE_STATES = Object.freeze(['pending', 'active', 'missing', 'kept']);

/**
 * The 8 characters a folder, ref label or merge label carries for an id (design §2 "<id 前 8 位>"): letters and
 * digits only, a leading `agent` of a worker's id dropped (`agent-1a2b…` → `1a2b…`).
 */
export function shortId(id) {
  return String(id ?? '').replace(/^agent-/, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
}
/** `s-1a2b3c4d`, `w-…`, `b-…`; `n` > 1 when that name is taken (`s-1a2b3c4d-2`). Relative to WORKTREE_DIR. */
export function worktreeName(kind, id, n = 1) {
  const prefix = WORKTREE_PREFIX[kind];
  if (!prefix) throw new TypeError(`No worktree folder for kind ${kind}.`);
  return `${prefix}${shortId(id)}${n > 1 ? `-${n}` : ''}`;
}

/**
 * Hidden refs (design §3.3), all in the repository's common dir. None is a branch: `git branch` and `git status`
 * never list them, and default refspecs never transfer them. Ids in a ref are the record ids (`[A-Za-z0-9_-]`).
 */
export const REFS = Object.freeze({
  root: 'refs/rna/',
  /** `seed`: the snapshot it was created from; `base`: a session worktree's last sync point; `tip`: its last snapshot. */
  worktree: (worktreeId, which) => `refs/rna/wt/${worktreeId}/${which}`,
  /** Orphans found at startup (design §5.3): snapshotted before anything else happens to them. */
  orphan: name => `refs/rna/wt/orphan-${name}/tip`,
  /** The hold commit of one apply record: parents [before, after] (while writing: [before, R]). */
  apply: applyId => `refs/rna/apply/${applyId}`,
  /** A direct-mode turn's hold commit: parents [start, end]. Kept 30 days. */
  turn: turnId => `refs/rna/turn/${turnId}`,
  /** A merge's temporary labels (conflict markers name them); deleted as soon as that merge ends. */
  merge: (mid, label) => `refs/rna/m/${mid}/${label}`,
});
/**
 * Merge label names (the last segment of REFS.merge). Conflict markers carry the full ref name, which makes a
 * leftover marker of one merge recognisable exactly (design §4.1 `resolved`).
 * - worker → parent root: current / incoming-worker-<id8>
 * - background → P: current / incoming-background-<id8>
 * - session S → P (forward, never written with markers): current / incoming-this-conversation
 * - P → S turn-start sync: current / incoming-project-folder
 * - P → S reverse merge written with markers into S (design §4.2): this-conversation / project-folder
 * - rollback (after → current ← before): current / incoming-rollback-<applyId8>
 */
export const MERGE_LABELS = Object.freeze({
  worker: agentId => ({ current: 'current', incoming: `incoming-worker-${shortId(agentId)}` }),
  background: actionId => ({ current: 'current', incoming: `incoming-background-${shortId(actionId)}` }),
  sessionToProject: () => ({ current: 'current', incoming: 'incoming-this-conversation' }),
  projectToSession: () => ({ current: 'current', incoming: 'incoming-project-folder' }),
  reverseMarkers: () => ({ current: 'this-conversation', incoming: 'project-folder' }),
  rollback: applyId => ({ current: 'current', incoming: `incoming-rollback-${shortId(applyId)}` }),
});
/** A merge id: lowercase hex, 8–32 characters (it is a ref path segment and appears in marker lines). */
export const MERGE_ID = /^[a-f0-9]{8,32}$/;
/** Ids of records that become ref segments or URL path segments (apply, worktree). */
export const RECORD_ID = /^[A-Za-z0-9_-]{1,80}$/;
/**
 * Whether `text` still holds a conflict marker line of merge `mid` (design §4.1 `resolved`, §4.2 step 6): a line
 * starting with `<<<<<<< refs/rna/m/<mid>/` or `>>>>>>> refs/rna/m/<mid>/`. Markers of other merges, or the
 * user's own `<<<<<<<` lines, do not count.
 */
export function hasMergeMarkers(text, mid) {
  if (!MERGE_ID.test(mid)) throw new TypeError('A merge id is lowercase hex.');
  const prefix = REFS.merge(mid, '');
  return String(text).split(/\r?\n/).some(line => line.startsWith(`<<<<<<< ${prefix}`) || line.startsWith(`>>>>>>> ${prefix}`));
}

/**
 * Conflict kinds (`conflicts[].kind`). From merge-tree's info section (design §3.4, the English message is never
 * parsed): content, binary, modify_delete, add_add, rename, type, other. Found by code, never written
 * automatically: submodule, case_collision, unsafe_symlink, unsafe_hardlink. From the writer's CAS (design §3.5,
 * §3.8): changed_during_merge, unexpected_file.
 */
export const CONFLICT_KINDS = Object.freeze(['content', 'binary', 'modify_delete', 'add_add', 'rename', 'type', 'other', 'submodule', 'case_collision', 'unsafe_symlink', 'unsafe_hardlink', 'changed_during_merge', 'unexpected_file']);
/** Only text conflicts get conflict markers; everything else is "non-text" (design §4.2 step 3). */
export const TEXT_CONFLICT_KINDS = Object.freeze(['content']);
/** Left to the user on a card; `agent_merge` `take` refuses them (design §4.1). */
export const USER_ONLY_CONFLICTS = Object.freeze(['submodule', 'case_collision', 'unsafe_symlink', 'unsafe_hardlink']);
/**
 * `notMerged[].reason`: paths a merge left out on purpose. `oversized`: over SNAPSHOT_FILE_BYTES; `nested`: a
 * repository of its own; `secret`: a file of SECRET_FILES that the source changed (P's own copy is never touched).
 */
export const NOT_MERGED_REASONS = Object.freeze(['oversized', 'nested', 'secret']);

/**
 * Files that hold secrets (mu kyrn/docs/features/checkpoints.md §2, packages/kyrn-judge/src/checkpoint/store.ts
 * BUILT_IN_IGNORES): never hashed into a snapshot, so never reachable from refs/rna (a checkpoint is a second copy of
 * the project kept for 30 days, and a mirror push or a bundle of every ref would carry it), and never part of a
 * merge, a rollback or a discard's checkpoint. gitignore patterns without a slash: each matches one path segment, a
 * file or a folder, at any depth, case-insensitively (the safe direction on a case-sensitive volume too). A tracked
 * one stays in snapshots at the version its HEAD commit already holds (the user's own history), never the folder's.
 * Fixed table; a change is a contract change (snapshot notes carry SECRET_FILES_VERSION, so private indexes rebuild).
 */
export const SECRET_FILES = Object.freeze(['*.env', '.env.*', '!.env.example', '!.env.sample', '!.env.template', '.envrc', '.netrc', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519']);
export const SECRET_FILES_VERSION = 1;
const SECRET_KEEP = new Set(SECRET_FILES.filter(rule => rule.startsWith('!')).map(rule => rule.slice(1)));
const SECRET_EXACT = new Set(SECRET_FILES.filter(rule => !rule.includes('*') && !rule.startsWith('!')));
const SECRET_SUFFIX = SECRET_FILES.filter(rule => rule.startsWith('*.')).map(rule => rule.slice(1));
const SECRET_PREFIX = SECRET_FILES.filter(rule => !rule.startsWith('*') && rule.endsWith('*')).map(rule => rule.slice(0, -1));
/** Whether one path segment (a file or folder name) matches SECRET_FILES. */
export function isSecretName(name) {
  const lower = String(name ?? '').toLowerCase();
  if (!lower || SECRET_KEEP.has(lower)) return false;
  return SECRET_EXACT.has(lower) || SECRET_SUFFIX.some(suffix => lower.endsWith(suffix)) || SECRET_PREFIX.some(prefix => lower.startsWith(prefix) && lower.length > prefix.length);
}
/** Whether a root-relative path (`/`-separated; a trailing `/` names a folder) lies in or is a SECRET_FILES match. */
export function isSecretPath(path) {
  return String(path ?? '').split('/').filter(Boolean).some(isSecretName);
}

/** `project.git.applies[].kind` (design §11). */
export const APPLY_KINDS = Object.freeze(['turn', 'worker', 'background', 'resolve', 'rollback', 'user_discard']);
/** `project.git.applies[].state`. `writing` survives only a crash; startup recovery settles it (design §3.6). */
export const APPLY_STATES = Object.freeze(['writing', 'verified', 'unverified', 'interrupted', 'rolled_back', 'expired']);
/**
 * `project.git.applies[].initiator` of an undoing record (a rollback, an interrupted apply's "go back to before"): who
 * asked for it. Set by the engine from its caller's option, never from a request body; workspace-events.mjs tells the
 * models only about the user's undos (the model's own agent_merge drop is not news to it). Additive.
 */
export const APPLY_INITIATORS = Object.freeze(['user', 'agent', 'host']);
/** `project.git.applies[].target`: the project folder, or (crash recovery only, no rollback offered) an isolated root. */
export const APPLY_TARGET = Object.freeze({ project: 'project', session: id => `session:${id}`, background: id => `background:${id}` });
/** How a write treats a file that moved under it (design §3.5). `markers` writes only S or B (asserted). */
export const WRITE_MODES = Object.freeze(['all', 'partial', 'markers']);

/** `turn.apply.status` (session worktree turns, design §4.2/§11). */
export const TURN_APPLY_STATUSES = Object.freeze(['none', 'applying', 'applied', 'conflicted', 'pending']);
/** `turn.checkpoint.state` (direct-mode turns, design §5.1). */
export const TURN_CHECKPOINT_STATES = Object.freeze(['taken', 'skipped']);
/** `delegation.merge.status` (design §4.1). */
export const MERGE_STATUSES = Object.freeze(['pending', 'merged', 'conflict', 'dropped', 'nothing', 'shared_root']);
/** `backgroundChanges[].status` of a git change set (`kind: 'git'`, design §4.3/§11). */
export const BACKGROUND_GIT_STATUSES = Object.freeze(['kept', 'reverted', 'deferred', 'merge_conflicted']);

/** Numbers the design fixes (engineering defaults, design §17). */
export const LIMITS = Object.freeze({
  /**
   * Measured, not copied (B8, docs/research/snapshot-file-bytes-20261005.md): live projects hold files up to 12.3 MB
   * that workers must see in their seed (mu's 5 MB and harness's 2 MB would leave them out), and a changed 100 MB
   * file costs one snapshot 1.8 s idle, 27 s under heavy load — inside snapshotTimeoutMs, paid once per change.
   */
  snapshotFileBytes: 100 * 1024 * 1024,
  snapshotTimeoutMs: 60000,
  appliesPerProject: 500,
  retentionDays: 30,
  retentionKeepPerProject: 50,
  turnRefDays: 30,
  trashDays: 7,
  rollbackTokenMs: 120000,
  worktreeTokenMs: 120000,
  gitInitTokenMs: 30 * 60000,
  execIdleWaitMs: 120000,
  checkpointWaitMs: 60000,
  /** Host continuations of one turn to resolve its S → P conflict (design §4.2), and for background runs (§4.3). */
  applyContinuations: 2,
  backgroundFinishContinuations: 3,
  /** `all` mode: fresh snapshot and retry after a CAS failure, then `blocked` (design §3.5). */
  writeAllAttempts: 3,
  previewBytes: 6 * 1024,
  showLinesPerPage: 2000,
  takeItems: 64,
  freeSpaceMinBytes: 2 * 1024 * 1024 * 1024,
  freeSpaceTrackedFactor: 2,
  initLargeFileBytes: 50 * 1024 * 1024,
  initConfirmFiles: 20000,
  initConfirmBytes: 2 * 1024 * 1024 * 1024,
  initMaxFiles: 100000,
  initLargestListed: 20,
});

/** Dependency manifests and lock files (design §6.4): a write list holding one gets the "reinstall" note. */
export const DEPENDENCY_FILES = Object.freeze(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'uv.lock', 'poetry.lock', 'Cargo.lock', 'Gemfile.lock']);
/**
 * `.gitignore` preview line groups (design §10 step 2); the web shows each line with its group. `secret` (B8): a
 * SECRET_FILES rule (or an exact path) for listed files that hold secrets, so the first commit leaves them out.
 */
export const GITIGNORE_RULES = Object.freeze(['always', 'ecosystem', 'secret', 'venv', 'large', 'nested', 'user']);

/** `feedback.source` of host continuations (design §4.1 turn end step 1, §4.2 step 3). */
export const FEEDBACK_SOURCES = Object.freeze({ workerMerge: 'host-worker-merge', worktreeApply: 'host-worktree-apply' });

/**
 * Host cards (question cards above the composer, the 0.58.2 multi-card mechanism). `actionId` makes each one
 * idempotent; the option ids are what the answer carries. Card text is the owning team's, in the interface language.
 * - sessionConflict (T4, design §4.2): rna = another host-written turn; conversation = conflicted files take this
 *   conversation's version (from preMerge, never markers); project = they take the project folder's; later = stay pending.
 * - sessionCreate (T4, design §7.2): project_folder = drop session.worktree and continue in P; retry.
 * - backgroundConflict (T5, design §4.3): rna = a turn in the delivery session using agent_merge({changeId});
 *   clean_only = apply what does not conflict; background = conflicted files take the background version; discard.
 * - interrupted (T1, design §3.6): complete = write only paths still at before; restore = put back only paths still at R.
 * Every option that writes takes a checkpoint first.
 */
export const HOST_CARDS = Object.freeze({
  sessionConflict: Object.freeze({ source: 'worktree', actionId: turnId => `worktree-apply:${turnId}`, options: Object.freeze(['rna', 'conversation', 'project', 'later']) }),
  sessionCreate: Object.freeze({ source: 'worktree', actionId: turnId => `worktree-create:${turnId}`, options: Object.freeze(['project_folder', 'retry']) }),
  backgroundConflict: Object.freeze({ source: 'initiative', actionId: actionId => `${actionId}-merge`, options: Object.freeze(['rna', 'clean_only', 'background', 'discard']) }),
  interrupted: Object.freeze({ source: 'worktree', actionId: applyId => `apply-interrupted:${applyId}`, options: Object.freeze(['complete', 'restore']) }),
});

/**
 * Error codes of the isolation surfaces and their HTTP status when they reach a route. Tool refusals carry the
 * same code in `details.code`. Messages are the owning team's, via say({ zh, en }).
 */
export const ISOLATION_ERRORS = Object.freeze({
  not_implemented: 501,
  worktree_unavailable: 409, // isolation off for this project; body carries `reason` (ISOLATION_REASONS)
  worktree_pending: 409, // a session worktree not created yet (first turn creates it)
  worktree_missing: 409, // its folder is gone; never answered with P instead
  worktree_not_found: 404,
  worktree_active: 409, // apply/discard of a worktree still in use
  worktree_unconfirmed: 409, // stale or reused confirm token
  worktree_changed: 409, // the worktree changed after the first step
  worktree_create_failed: 500,
  root_denied: 403, // a root that is neither P nor a registered, listed Rna worktree
  delegation_worktree_space: 507,
  delegation_worktree_failed: 500,
  snapshot_unreadable: 409,
  snapshot_timeout: 504,
  engine_failed: 500, // merge-tree exit other than 0/1, unparsable output
  write_path_denied: 403,
  markers_target_denied: 500, // assertion: markers mode aimed at P or W
  apply_blocked: 409, // `all` mode still racing after LIMITS.writeAllAttempts
  apply_not_found: 404,
  apply_expired: 409, // past retention: "已过期，不能回退"
  apply_target_denied: 409, // rollback of a record whose target is not the project folder
  git_operation_in_progress: 409, // a user-started write while P has a merge/rebase/… in progress
  rollback_unconfirmed: 409,
  rollback_changed: 409,
  rollback_nothing: 409,
  turn_checkpoint_missing: 409, // a direct-mode turn without a checkpoint (skipped, or before 0.63)
  merge_unknown: 404, // agent_merge / merge route: no such worker or change set in this conversation
  merge_not_finished: 409,
  merge_shared_root: 409, // nothing to merge: it worked in the parent's folder
  merge_path_not_conflicted: 400,
  merge_take_denied: 409, // a USER_ONLY_CONFLICTS kind
  merge_unresolved: 409,
  git_init_already: 409,
  git_init_folder_denied: 403,
  git_init_inside_repo: 409,
  git_init_too_many_files: 409,
  git_init_large_unacknowledged: 409,
  git_init_identity_required: 400,
  git_init_identity_invalid: 400,
  git_init_lines_invalid: 400,
  git_init_unconfirmed: 409,
  git_init_changed: 409,
  git_init_failed: 500,
  // Added at integration (codes the teams used beyond the first contract):
  worktree_request_invalid: 400, // unknown keys in a worktree apply / discard body (T2)
  worktree_remove_failed: 409, // git refused to remove a worktree (T2)
  worktree_repair_failed: 409, // `git worktree repair` failed after the project folder moved (T2)
  worktree_unapplied: 409, // DELETE /api/sessions/:id of a conversation whose worktree holds unapplied files, or whose subagent workers' copies hold unmerged ones (B8), without `confirm: true`; body carries `unapplied` and `workers` (T4)
  delegation_unknown: 404, // rootOf({ agentId }) of a subtask this project does not have (T2)
  merge_request_invalid: 400, // a bad body on POST …/agents/:agentId/merge (T3)
  merge_settled: 409, // handoff of a worker whose merge is no longer conflict or pending (T3)
  rollback_request_invalid: 400, // a bad rollback body (T1)
  applies_request_invalid: 400, // a bad applies query (T1)
  // Added by the safety review:
  checkpoint_oversized: 409, // the panel's discard names a file over LIMITS.snapshotFileBytes: no checkpoint can hold it, so nothing is discarded; body carries `paths`
  checkpoint_secret: 409, // the panel's discard names a SECRET_FILES file (B8): checkpoints never hold one, so nothing is discarded; body carries `paths`
  // Added by the A5 review (pending workers):
  worktree_worker_pending: 409, // the panel's apply / discard of a worker's W whose delegation still waits (pending, conflict): its card settles it; body carries `worktreeId`
  merge_user_merged: 409, // agent_merge drop of a worker the user merged from its card
});

/** What a contract stub throws until its owning team replaces it. */
export function notImplemented(name) {
  return Object.assign(new Error(`${name} is not implemented yet (0.63 isolation contract stub).`), { status: 501, code: 'not_implemented' });
}

/**
 * Model-facing texts the design fixes (English, never varying by project, so prompt prefixes stay shared). The
 * SDK side (agent_merge description, the delegate sentence) is in packages/sdk/src/agent-merge.mjs.
 */
export const MODEL_TEXT = Object.freeze({
  /** A worker running in its own worktree: host context (not the system prompt) of the child (design §6.3, T3). */
  workerContext: 'You are working in your own copy of the project, made from the parent\'s current files. The host collects your changes when you finish; do not commit, stash or switch branches. Dependencies resolve from the project folder; to change dependencies, install them in this copy.',
  /** The background contract line for an isolated run while a foreground turn runs (design §8 :527-528, T5). */
  backgroundIsolatedForeground: 'A foreground turn is running. Your writes go to your own working copy and are applied after it; do not duplicate the foreground task.',
  /** Turn-start sync left these paths at the conversation's version (design §7.3, T4): host context attachment. */
  startSyncConflicts: files => `These files were also changed in the project folder since this conversation's copy was last synced: ${files.join(', ')}. Your copy keeps its version for now; the host merges both when this turn ends.`,
  /**
   * Files that hold secrets (SECRET_FILES) the conversation's worktree changed (B8): no apply carries them into the
   * project folder, so the model hears it once, as host context of its next request (SessionWorktreeService.secretNoteUpdate).
   */
  sessionSecretKept: files => `The host never applies files that hold secrets (.env files, keys, certificates) from this conversation's copy to the project folder, so these changes exist only in your copy: ${files.join(', ')}. The user was told where they are and can copy them over; do not say they are in the project folder.`,
  /** S → P conflict feedback (design §4.2 step 3, T4): the JSON the host continuation carries. */
  worktreeApplyFeedback: ({ mid, files, nonText }) => JSON.stringify({
    observation: `While this turn ran, files in the project folder changed (by the user or other work) in the same places you changed. Those changes were merged into your working copy; the files below now contain conflict markers labelled ${REFS.merge(mid, '')}…. Non-text conflicts are listed separately and will be decided by the user.`,
    files, nonText,
    nextStep: 'Resolve each marked conflict keeping both intents where possible (the section under ||||||| is the common base), remove the markers, rerun the relevant checks, then finish. Do not drop the project-folder side unless it is clearly obsolete.',
  }),
  /** Turn end step 1 (design §4.1, T4 using T3's pendingMerges()): one continuation per turn, at most. `reason` of a
   * pending worker: why the host did not merge it (unfinished, parent_idle, cancelled, read_only, apply_interrupted). */
  workerMergeReminder: workers => JSON.stringify({
    observation: 'These workers ended, but their changes are not in your files yet.',
    workers: workers.map(row => ({ agentId: row.agentId, status: row.status, ...(row.reason ? { reason: row.reason } : {}), ...(row.conflicts?.length ? { conflicts: row.conflicts.map(item => item.path) } : {}) })),
    nextStep: 'For each worker, call agent_merge with its agentId to apply its changes and resolve any conflict, or use action drop if its work is no longer wanted; a worker with reason unfinished did not finish its task, so check that its partial work is wanted first, and ask the user when unsure. Then finish.',
  }),
  /**
   * The line appended to a settled worker's host notice and to its joined result (design §4.1 table, T3).
   * `pendingReason`: cancelled | read_only (the host's other pending reasons have lines of their own in
   * builtin-agent-service.mjs mergeLine: unfinished, parent_idle, apply_interrupted, git_operation, an engine code).
   */
  mergeNotice: ({ status, agentId, applied = [], conflicts = [], pendingReason = 'cancelled', reason }) => ({
    merged: () => `Its changes were merged into your files: ${applied.join(', ')}. If they are not wanted, agent_merge({"agentId":"${agentId}","action":"drop"}) rolls them back.`,
    conflict: () => `Merged ${applied.length} file(s) into your files; ${conflicts.length} file(s) conflict with changes made after it started (${conflicts.map(item => item.path).join(', ')}). Call agent_merge({"agentId":"${agentId}"}) to resolve them.`,
    pending: () => `${pendingReason === 'read_only' ? 'The project is no longer writable' : 'It was cancelled'}, so its changes were not merged. agent_merge({"agentId":"${agentId}"}) brings them in; action drop discards them.`,
    nothing: () => 'It changed no files.',
    dropped: () => 'Its changes were dropped.',
    shared_root: () => `It worked directly in your files (no isolated copy: ${reason ?? 'unavailable'}).`,
  })[status]?.() ?? '',
});

/**
 * @typedef {'project'|'session'|'worker'|'background'} RootKind
 * @typedef {object} RootInfo  What RootResolver.rootOf answers (design §9). Every path is a realpath.
 * @property {string} root       The folder tools, cwd and snapshots use: P, or the worktree + the project's prefix.
 * @property {RootKind} kind
 * @property {boolean} isolated  true for S, W, B (sandbox forced, `.git` write denied).
 * @property {string} project    P (registeredWorkspacePath of the project), also for isolated roots.
 * @property {string} [prefix]   The project folder inside the repository ('' or 'sub/dir/').
 * @property {string} [worktreeId]
 * @property {string} [gitDir]   GIT_DIR for git on this root, from the record (`<commonDir>/worktrees/<name>`).
 * @property {string} [workTree] GIT_WORK_TREE, from the record.
 *
 * @typedef {object} Isolation  `isolation` of GET …/worktrees (design §2).
 * @property {boolean} enabled
 * @property {string} [reason]   ISOLATION_REASONS, when not enabled.
 * @property {string|null} git   The git version text (`2.39.5`), null when git cannot run.
 *
 * @typedef {object} Snapshot   design §3.2
 * @property {string} tree
 * @property {string} commit     commit-tree of `tree` (parent: the root's HEAD when it has one); on no branch.
 * @property {string[]} nested   Skipped repositories of their own (`dir/`).
 * @property {string[]} oversized Skipped files over LIMITS.snapshotFileBytes.
 * @property {string[]} secret   SECRET_FILES paths left at the private index's version (never hashed): of P every
 *   one the listing showed; of an isolated root only its owner's changes (snapshot.mjs secretChanged: not a laid-down
 *   copy still as made, not a file with the project folder's bytes).
 *
 * @typedef {object} Conflict
 * @property {string} path
 * @property {string} kind       CONFLICT_KINDS
 * @property {{ mode: string, oid: string }} [base]
 * @property {{ mode: string, oid: string }} [current]
 * @property {{ mode: string, oid: string }} [incoming]
 * @property {string} [marked]   Blob of the merge result holding conflict markers (text conflicts only).
 *
 * @typedef {object} ApplyOutcome  IsolationEngine.apply (design §3.4–§3.7)
 * @property {'nothing'|'applied'|'conflicted'|'blocked'} status  `conflicted`: something was left out (all mode:
 *   nothing written; partial: the clean part written).
 * @property {string|null} applyId   The record written (null when nothing was written).
 * @property {string} mid
 * @property {string} before         Commit of the target snapshot the merge read (pinned by the record).
 * @property {string} result         Tree R of the merge.
 * @property {string[]} written
 * @property {string[]} removed
 * @property {Conflict[]} conflicts
 * @property {{ path: string, reason: string }[]} notMerged
 * @property {number} bothChanged    Files both sides changed (merged cleanly or not), design §3.8.
 * @property {'verified'|'unverified'|null} verify
 * @property {string[]} [mismatched] Paths the post-write check found different (unverified).
 * @property {boolean} dependencies  The written paths include a DEPENDENCY_FILES name.
 */
