import { existsSync, unlinkSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DirectFixRecorder } from './direct-fix-store.mjs';
import { projectEdits } from '../../packages/sdk/src/workspace-tools.mjs';

// Plan 2026-09-30 §3.1 (M3): judgments inside a running turn.
// - tool.constraint: a file write that confidently breaks a constraint the user
//   stated is refused with the reason, so the model adjusts it.
// - turn.drift: every few steps of a long turn, when the recent steps have
//   clearly wandered away from the request, the request is put back in front.
// - turn.rewind: when the same failure repeats and the approach is confidently a
//   dead end, the files changed since the first failure are restored and the
//   model is told to take another way.
// Notes reach the model through the next request's context (never the prefix).
export const WRITE_TOOLS = Object.freeze(['project_write', 'project_edit']);
export const DRIFT_EVERY = 8, REWIND_AFTER = 3, CONSTRAINT_BUDGET_MS = 2500, DENIALS_PER_PATH = 2, FORGET_BUDGET_MS = 8000;
const clip = (value, max) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
const withTimeout = (promise, ms, fallback) => { let timer; return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(timer)), new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); timer.unref?.(); })]); };
const textOf = result => Array.isArray(result?.content) ? result.content.filter(row => row?.type === 'text').map(row => row.text).join('\n') : typeof result === 'string' ? result : '';

/** The user's standing constraints for a project (active constraint lessons). */
export const projectConstraints = project => (project?.mind?.lessons ?? []).filter(row => row.status === 'active' && !row.stale && row.kind === 'constraint').map(row => row.text).slice(-8);

/** The ToolPolicy's constraint gate (tool-policy.mjs, before dispatch): refuse a write that breaks a stated constraint; fail open on doubt, time or error. */
export function constraintGate({ decisions, getProject }) {
  const denials = new Map();
  return async ({ tool, args, signal }) => {
    if (!WRITE_TOOLS.includes(tool?.name) || typeof decisions?.toolConstraint !== 'function') return null;
    const project = getProject(), rules = projectConstraints(project);
    if (!rules.length || typeof args?.path !== 'string') return null;
    if ((denials.get(args.path) ?? 0) >= DENIALS_PER_PATH) return null; // the model insisted twice: let it through, it must explain
    const text = tool.name === 'project_edit' ? (() => { try { return projectEdits(args).map(edit => edit.newText).join('\n'); } catch { return String(args.newText ?? ''); } })() : String(args.content ?? '');
    const judged = await withTimeout(decisions.toolConstraint(project, { tool: tool.name, path: args.path, text, rules, signal }).catch(() => null), CONSTRAINT_BUDGET_MS, null);
    // Model-visible, so fixed English (it reaches foreground, background and subagent models alike); the rules are the user's own words.
    const broken = (judged?.broken ?? []).map(index => rules[index]).filter(Boolean).map(rule => `“${clip(rule, 120)}”`);
    if (!broken.length) return null;
    denials.set(args.path, (denials.get(args.path) ?? 0) + 1);
    return { deny: `This write was not run: it would break ${broken.length === 1 ? 'a constraint' : 'constraints'} the user stated: ${broken.join('; ')}. Change it to meet ${broken.length === 1 ? 'the constraint' : 'them'} and write again; if an exception is really needed, ask the user first.` };
  };
}

/** A session `forgetStale` hook (context.forget): ids of earlier tool results later work superseded; null on doubt, time or error. */
export function forgetHook({ decisions, getProject }) {
  return async ({ request, recent, results, signal }) => {
    if (typeof decisions?.contextForget !== 'function') return null;
    const judged = await withTimeout(decisions.contextForget(getProject(), { request, recent, results, signal }).catch(() => null), FORGET_BUDGET_MS, null);
    return judged ? judged.stale.map(index => results[index]?.id).filter(Boolean) : null;
  };
}

export class TurnWatcher {
  constructor({ decisions, getProject, workspace, request = '', record = null }) {
    Object.assign(this, { decisions, getProject, workspace, request, record });
    this.steps = []; this.failures = new Map(); this.checkpoint = null; this.notes = []; this.checking = false; this.args = new Map(); this.judgments = [];
  }
  /** A judgment made inside this turn, kept on the turn so the next user message can label it (calibration). */
  recordJudgment(entry) { this.judgments.push(entry); try { this.record?.(entry); } catch { /* bookkeeping never blocks the turn */ } }
  onStart(event) {
    this.args.set(event.toolCallId, event.args);
    if (this.checkpoint && WRITE_TOOLS.includes(event.toolName)) this.checkpoint.capture(event.args?.path);
  }
  onEnd(event) {
    const args = this.args.get(event.toolCallId); this.args.delete(event.toolCallId);
    const target = args?.path ?? args?.command ?? args?.query ?? '';
    const failed = Boolean(event.isError), output = textOf(event.result);
    this.steps.push(`${event.toolName}${target ? ` ${clip(target, 80)}` : ''}${failed ? ` (failed: ${clip(output.split('\n').find(Boolean), 100)})` : ''}`);
    if (this.steps.length % DRIFT_EVERY === 0) void this.checkDrift();
    if (!failed) return;
    const key = `${event.toolName}:${clip(output.split('\n').find(line => line.trim()), 120)}`;
    // The first time a failure appears is the checkpoint: files touched from here on are snapshotted.
    if (!this.checkpoint) try { this.checkpoint = new DirectFixRecorder(this.workspace); } catch { this.checkpoint = null; }
    const count = (this.failures.get(key) ?? 0) + 1; this.failures.set(key, count);
    if (count >= REWIND_AFTER) { this.failures.delete(key); void this.checkRewind(key); }
  }
  async checkDrift() {
    if (this.checking || typeof this.decisions?.turnDrift !== 'function' || !this.request) return;
    this.checking = true;
    try {
      const judged = await this.decisions.turnDrift(this.getProject(), { request: this.request, recent: this.steps.slice(-10) }).catch(() => null);
      if (judged?.ledgerId) this.recordJudgment({ point: 'turn.drift', ledgerId: judged.ledgerId, drifting: judged.drifting === true });
      if (judged?.drifting) this.notes.push({ key: 'turn-steering', source: 'host-turn-steering', scope: 'turn', text: JSON.stringify({ observation: 'Your recent steps have drifted away from what the user asked for.', request: clip(this.request, 600), nextStep: 'Return to that request and drop side work that does not serve it.' }) });
    } finally { this.checking = false; }
  }
  async checkRewind(failure) {
    if (typeof this.decisions?.turnRewind !== 'function') return;
    const judged = await this.decisions.turnRewind(this.getProject(), { request: this.request, failure, attempts: this.steps.slice(-6) }).catch(() => null);
    if (judged?.ledgerId) this.recordJudgment({ point: 'turn.rewind', ledgerId: judged.ledgerId, deadEnd: judged.deadEnd === true });
    if (!judged?.deadEnd) return;
    const restored = this.restore();
    this.notes.push({ key: 'turn-rewind', source: 'host-turn-rewind', scope: 'turn', text: JSON.stringify({ observation: `The same failure happened ${REWIND_AFTER} times (${failure}); this approach is a dead end.`, restored: restored.length ? `The host restored ${restored.join(', ')} to how they were before the first failure.` : 'No files needed restoring.', nextStep: 'Take a different approach, or say in one sentence where you are stuck and what you need.' }) });
  }
  /** Put every file changed since the checkpoint back as it was then (the turn's own changes only). */
  restore() {
    const recorder = this.checkpoint; this.checkpoint = null;
    if (!recorder) return [];
    const restored = [];
    for (const row of recorder.changes()) {
      const path = join(recorder.root, row.path);
      try {
        if (!row.existed) { if (existsSync(path)) unlinkSync(path); }
        else { mkdirSync(dirname(path), { recursive: true }); const temporary = `${path}.rna-rewind-${process.pid}`; writeFileSync(temporary, row.before); renameSync(temporary, path); }
        restored.push(row.path);
      } catch { /* leave it; the note says which were restored */ }
    }
    return restored;
  }
  /** Context updates for the next request, once each. */
  drain() { const notes = this.notes; this.notes = []; return notes; }
}

