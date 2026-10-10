// D4 scenario DSL (plan A7): steps a user or the clock takes — send (and answer a card), stream, background run,
// revert (a change set, or a rewind), delete, archive, evolve, advanceClock (and idle) — each through the host's real
// entry point (HTTP routes, the stream, the initiative's own tick). Every step returns a record of what it caused in the world: the faux model's requests, OpenViking and JEV
// calls, and SSE frames on every client the world holds. `.expect({...})` then asserts on the world:
//   state(state, step)        the state as persisted on disk (re-read through the shard reader)
//   sidecars(names, world)    `<state>.<suffix>` siblings; files({ path: text | RegExp | null }) workspace files
//   gitRefs(refs, step)       refs of the workspace repository; frames(frames, step) SSE frames of the step
//   requests(rows, step)      model requests of the step ({ tag, via, request, wire }); memory(calls) / judgments(calls)
// Invariants checked after every step whatever the scenario says: the host never failed to persist, every sidecar is
// one the checkpoint inventory knows, no SSE frame exceeds the protocol's event cap, and every JEV answer parsed.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readStateFile } from '../../state-shards.mjs';
import { MAX_EVENT_BYTES } from '../../api-v2.mjs';
import { decide, decisionInput } from './faux-model.mjs';
import { until } from './world.mjs';
import { ledgerRows } from '../../decision-ledger.mjs';

const TERMINAL_ACTION = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'needs_review']);

function invariants(world, label, record) {
  assert.equal(world.store.persistence.failed, false, `[${label}] state persistence failed (${world.store.persistence.errorCode})`);
  assert.deepEqual(world.unknownSidecars(), [], `[${label}] a sidecar the checkpoint inventory does not know would block the next upgrade`);
  const oversized = record.frames.filter(frame => frame.bytes > MAX_EVENT_BYTES);
  assert.deepEqual(oversized.map(frame => `${frame.event}:${frame.bytes}`), [], `[${label}] SSE frames over MAX_EVENT_BYTES`);
  // The fake JEV answers in the wire format the kernel parses: a malformed answer would silently become a fallback.
  const malformed = ledgerRows(world.store).filter(row => row.reason === 'invalid_response');
  assert.deepEqual(malformed.map(row => row.point), [], `[${label}] JEV answers the kernel could not parse`);
}

async function check(world, label, record, spec) {
  const at = name => `[${label}] ${name}`;
  try {
    if (spec.state) await spec.state(readStateFile(world.stateFile).state, record);
    if (spec.sidecars) await spec.sidecars(world.sidecars(), world);
    if (spec.files) for (const [path, expected] of Object.entries(spec.files)) {
      const actual = world.file(path);
      if (expected === null) assert.equal(actual, null, at(`${path} should not exist`));
      else if (expected instanceof RegExp) assert.match(actual ?? '', expected, at(path));
      else assert.equal(actual, expected, at(path));
    }
    if (spec.gitRefs) await spec.gitRefs(world.gitRefs(), record);
    if (spec.frames) await spec.frames(record.frames, record);
    if (spec.requests) await spec.requests(record.requests, record);
    if (spec.memory) await spec.memory(record.ov, record);
    if (spec.judgments) await spec.judgments(record.jev, record);
  } catch (error) { if (!String(error.message).startsWith(`[${label}]`)) error.message = `[${label}] ${error.message}`; throw error; }
  return record;
}

/**
 * Index and resync frames that no state change explains: per stream, an `index` frame must carry a newer revision than
 * the stream's hello and previous index frames; an index `resync` (an oversized row) is never expected. What is left
 * came from a value derived from the clock (or a display tick), or from a row too large to send.
 */
export function unexplainedIndexFrames(frames, { since = -Infinity } = {}) {
  const seen = new Map(), out = [];
  for (const frame of [...frames].sort((a, b) => a.at - b.at)) {
    const revision = typeof frame.data?.revision === 'number' ? frame.data.revision : null, last = seen.get(frame.stream) ?? -Infinity;
    const unexplained = frame.event === 'index' && (revision === null || revision <= last) || frame.event === 'resync' && Boolean(frame.data?.projectIds || frame.data?.sessionIds || frame.data?.fields);
    if (unexplained && frame.at >= since) out.push(frame);
    // Session events carry revisions too, sent before the (debounced) index diff of the same change: only hello and
    // index frames set the stream's index baseline.
    if (revision !== null && ['hello', 'index'].includes(frame.event)) seen.set(frame.stream, Math.max(last, revision));
  }
  return out;
}

export function scenario(world) {
  const steps = [];
  async function step(label, run) {
    const mark = world.mark();
    let outcome;
    try { outcome = await run(); await world.settle(); } catch (error) { error.message = `[${label}] ${error.message}`; throw error; }
    const record = { label, outcome, at: mark.at, ...world.since(mark) };
    /** This step's index/resync frames that no state change explains (see unexplainedIndexFrames). */
    record.unexplained = () => unexplainedIndexFrames(world.frames(), { since: mark.at });
    invariants(world, label, record);
    record.expect = spec => check(world, label, record, spec);
    steps.push(record);
    return record;
  }
  const turnDone = (sessionId, turnId) => until(() => { const turn = world.session(sessionId)?.turns.find(row => row.id === turnId); return turn && turn.status !== 'running' ? turn : null; }, `turn ${turnId}`);

  const s = {
    world, steps,
    /**
     * A user message through POST /api/sessions/:id/messages, run to its end. `reply`: the faux model's responses
     * for this turn, in order (a tool call, then text…); none: the default answer. `stopAt: 'card'` returns when the
     * turn shows a question card waiting for the user (answer it with `answer`).
     */
    send(text, { reply = [], sessionId = world.sessionId, stopAt = 'end', label = `send ${JSON.stringify(text).slice(0, 40)}` } = {}) {
      return step(label, async () => {
        world.faux.script('foreground', ...[reply].flat());
        const accepted = await world.post(`/api/sessions/${sessionId}/messages`, { text, requestId: randomUUID() });
        assert.equal(accepted.status, 200, `message accepted: ${JSON.stringify(accepted.body).slice(0, 300)}`);
        const turnId = accepted.body.session?.activeTurnId ?? world.session(sessionId).activeTurnId;
        if (stopAt === 'card') {
          const card = await until(() => world.session(sessionId).items.findLast(item => item.turnId === turnId && item.interaction?.status === 'pending')?.interaction, 'a question card');
          return { turnId, card, accepted: accepted.body };
        }
        const turn = await turnDone(sessionId, turnId);
        await world.quiet(sessionId);
        return { turnId, turn: world.session(sessionId).turns.find(row => row.id === turnId) ?? turn, accepted: accepted.body };
      });
    },
    /** The user answers the conversation's waiting question card (POST …/interactions/:id/answer); its turn runs to its end. */
    answer(answers, { sessionId = world.sessionId, label = 'answer the card' } = {}) {
      return step(label, async () => {
        const item = world.session(sessionId).items.findLast(row => row.interaction?.status === 'pending');
        assert.ok(item, 'a card waits for an answer');
        const response = await world.post(`/api/sessions/${sessionId}/interactions/${item.interaction.id}/answer`, { requestId: randomUUID(), answers });
        assert.equal(response.status, 200, `answer: ${JSON.stringify(response.body).slice(0, 300)}`);
        if (item.turnId) await turnDone(sessionId, item.turnId);
        await world.quiet(sessionId);
        return { interaction: response.body.interaction, turnId: item.turnId };
      });
    },
    /**
     * A streamed reply watched by a browser tab on the conversation: `text` arrives in `chunks` deltas `chunkMs`
     * apart, so display ticks and index diffs happen while it streams. The outcome carries the tab (its GETs).
     */
    stream(text, { reply = 'A streamed reply. '.repeat(40), chunks = 20, chunkMs = 60, sessionId = world.sessionId, tab, label = `stream ${JSON.stringify(text).slice(0, 40)}` } = {}) {
      return step(label, async () => {
        const browser = tab ?? await world.browser({ sessionId });
        await until(() => browser.gets.length >= 2, 'the tab to load');
        const before = browser.gets.length, startedAt = performance.now();
        world.faux.script('foreground', { text: reply, chunks, chunkMs });
        const accepted = await world.post(`/api/sessions/${sessionId}/messages`, { text, requestId: randomUUID() });
        assert.equal(accepted.status, 200);
        const turnId = accepted.body.session?.activeTurnId ?? world.session(sessionId).activeTurnId;
        await turnDone(sessionId, turnId); await world.quiet(sessionId);
        // The tab's last coalesced reload (50 ms) and the hub's last diff land before the step closes.
        await new Promise(done => setTimeout(done, 250));
        return { turnId, tab: browser, startedAt, gets: browser.gets.slice(before), bootstrapGets: browser.gets.slice(before).filter(row => row.kind === 'bootstrap').length };
      });
    },
    /**
     * One background run decided by the initiative: the decision lane answers `work` with `task`, later decisions wait;
     * the worker lane plays `work` (responses in order). When no decision is due on the current evidence, the clock moves
     * `wakeAfterMs` ahead (past the one-day review a waiting decision sets). Waits until the action is terminal.
     */
    backgroundRun({ task, work = [], projectId = world.projectId, wakeAfterMs = 86400000 + 60000, label = `background run ${JSON.stringify(task).slice(0, 40)}` }) {
      return step(label, async () => {
        assert.ok(world.app.projectInitiative, 'the world was built without initiative');
        let chose = false;
        world.faux.on('initiative', request => { const input = decisionInput(request); if (chose) return decide(input, 'wait'); chose = true; return decide(input, 'work', task); });
        world.faux.script('background-work', ...work);
        const actions = () => world.project(projectId)?.initiativeRuntime?.sdkState?.actions ?? [];
        const before = new Set(actions().map(row => row.id)), asked = world.faux.of('initiative').length;
        world.app.projectInitiative.schedule();
        // A decision is due now (new evidence) or at the review time the last decision chose: the clock moves there.
        const decided = () => world.faux.of('initiative').length > asked;
        await until(decided, 'a decision on the current evidence', 1500).catch(() => { world.clock.advance(wakeAfterMs); return until(decided, 'the next review to be due', 20000); });
        const action = await until(() => actions().find(row => !before.has(row.id) && row.action === 'work' && TERMINAL_ACTION.has(row.status)), 'the background action to finish', 60000).catch(error => {
          const seen = actions().filter(row => !before.has(row.id)).map(row => `${row.action}:${row.status}${row.deferredReason ? `(${row.deferredReason})` : ''}${row.errorCode ? `[${row.errorCode}]` : ''}`);
          const runtime = world.project(projectId)?.initiativeRuntime ?? {};
          throw Object.assign(error, { message: `${error.message}; actions ${seen.join(', ') || 'none'}; requests ${world.faux.requests.map(row => row.tag).join(',')}; initiative ${JSON.stringify({ status: runtime.status, lastErrorCode: runtime.lastErrorCode, blocked: runtime.availability?.state }).slice(0, 300)}` });
        });
        // Its change set (if it wrote) is recorded once the run's writes were applied.
        await until(() => !world.app.projectInitiative.contexts.get(projectId)?.workRuns?.size, 'the run to leave its context', 30000);
        const change = (world.project(projectId).backgroundChanges ?? []).findLast(row => row.actionId === action.id) ?? null;
        return { action, change, job: (world.project(projectId).jobs ?? []).find(row => row.id === action.id) ?? null };
      });
    },
    /**
     * The user's revert: `{ change }` reverts a background change set; `{ item, reason }` rewinds the conversation
     * at one of the user's messages (user_edit | user_delete).
     */
    revert({ change, item, reason = 'user_edit', sessionId = world.sessionId, projectId = world.projectId, label }) {
      return step(label ?? (change ? `revert change ${change}` : `rewind at ${item}`), async () => {
        const path = `/api/projects/${projectId}/background-changes/${change}/revert`;
        let response = change ? await world.post(path, {}) : await world.post(`/api/sessions/${sessionId}/items/${item}/rewind`, { reason });
        assert.equal(response.status, 200, `revert: ${JSON.stringify(response.body).slice(0, 300)}`);
        // A git change set's rollback is previewed first (the files it would restore and a one-time token); the user
        // confirms in the card, which sends the token back.
        const preview = change && typeof response.body?.confirm === 'string' ? response.body : null;
        if (preview) { response = await world.post(path, { confirm: preview.confirm }); assert.equal(response.status, 200, `revert confirm: ${JSON.stringify(response.body).slice(0, 300)}`); }
        return { ...response.body, ...(preview ? { preview } : {}) };
      });
    },
    /** Deletes a conversation (DELETE /api/sessions/:id) and waits for its cleanup to settle. */
    delete(sessionId = world.sessionId, { confirm = false, label = `delete ${sessionId}` } = {}) {
      return step(label, async () => {
        const response = await world.del(`/api/sessions/${sessionId}`, { confirm });
        assert.ok([200, 202].includes(response.status), `delete: ${response.status} ${JSON.stringify(response.body).slice(0, 300)}`);
        const row = () => (world.store.state.sessionDeletions ?? []).find(item => item.sessionId === sessionId);
        const record = await until(() => ['completed', 'blocked'].includes(row()?.status) ? row() : null, 'the deletion to settle', 60000)
          .catch(error => { throw Object.assign(error, { message: `${error.message}; deletion ${JSON.stringify(row() ?? null).slice(0, 600)}` }); });
        return { response: response.body, deletion: record };
      });
    },
    /** Archives (or restores) a project through PATCH /api/projects/:id. */
    archive(projectId = world.projectId, { archived = true, label = `${archived ? 'archive' : 'restore'} ${projectId}` } = {}) {
      return step(label, async () => {
        const response = await world.patch(`/api/projects/${projectId}`, { archived });
        assert.equal(response.status, 200, `archive: ${JSON.stringify(response.body).slice(0, 300)}`);
        return response.body;
      });
    },
    /** A user's action on a gene of the evolution tree (POST /api/v2/projects/:id/genes/:geneId). */
    evolve(geneId, { action = 'confirm', text, projectId = world.projectId, label = `evolve ${action} ${geneId}` } = {}) {
      return step(label, async () => {
        const response = await world.post(`/api/v2/projects/${projectId}/genes/${encodeURIComponent(geneId)}`, { action, ...(text ? { text } : {}) });
        assert.ok([200, 202].includes(response.status), `evolve: ${response.status} ${JSON.stringify(response.body).slice(0, 300)}`);
        return response.body;
      });
    },
    /**
     * Moves the scenario clock, then runs the host's periodic work once (world.tick: what its own timers do next).
     * `until`: waits for a condition, ticking while it waits; with `repeat`, the clock moves `ms` again before each
     * tick (time keeps passing in `ms` jumps, e.g. through a poll backoff), at most every `everyMs` of wall time.
     */
    advanceClock(ms, { settleMs = 200, until: condition, repeat = false, everyMs = 250, label = `advance clock ${ms} ms` } = {}) {
      return step(label, async () => {
        world.clock.advance(ms); world.tick();
        let last = performance.now();
        const again = () => { if (performance.now() - last < everyMs) return; last = performance.now(); if (repeat) world.clock.advance(ms); world.tick(); };
        if (condition) return until(() => condition() || (again(), false), `${label}: condition`, 60000);
        await new Promise(done => setTimeout(done, settleMs));
        return { now: world.clock.now() };
      });
    },
    /** Idle time with the clock moving in poll-sized jumps (world.idle). */
    idle(ms, { label = `idle ${ms} ms`, ...options } = {}) { return step(label, async () => { await world.idle(ms, options); return { ms }; }); },
    /** Any other action, recorded and checked like a step. */
    step,
  };
  return s;
}
