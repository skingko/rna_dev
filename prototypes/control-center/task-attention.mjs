// Task page marks (plan 2026-09-30 §8.1): whether a finished piece of
// background work needs the user's attention is judged by JEV `message.value`
// on its own result (a decision the user must make, or something new and
// relevant that was not already told), not by how recent it is. One judgment
// per finished action, stored host-side (`project.taskMarks`) and served with
// the action snapshot; the controller's action records are never touched.
const iso = value => new Date(value).toISOString();
const DAY = 86400000, MARKS_KEPT = 80;
const clip = (value, max) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
// `needs_user_decision` at the medium tier marks 需要你; `already_reported` at medium hides 新结果.
export const ATTENTION_THRESHOLD = .75;

export const actionResultText = action => clip(String(action?.handoff ?? '').replace(/^交接[:：]\s*/, '') || action?.resultSummary || '', 1200);

/** A stored mark from message.value probabilities. */
export function attentionMark(judged, now) {
  const probabilities = judged?.probabilities ?? {};
  return { at: iso(now), needsUser: (probabilities.needs_user_decision ?? 0) >= ATTENTION_THRESHOLD, alreadyReported: judged?.alreadyReported === true, ...(judged?.ledgerId ? { ledgerId: judged.ledgerId } : {}) };
}

export class TaskAttentionService {
  constructor(store, { decisions = null, now = Date.now, delayMs = 3000, enabled = true } = {}) {
    Object.assign(this, { store, decisions, now, delayMs, enabled });
    this.timer = null; this.running = null; this.closed = false; this.attempted = new Map();
  }
  start() { if (this.unsubscribe || !this.enabled) return; this.unsubscribe = this.store.subscribe(() => this.schedule(), { display: false }); this.schedule(); }
  schedule() { if (this.closed || this.timer || this.running) return; this.timer = setTimeout(() => { this.timer = null; void this.pump(); }, this.delayMs); this.timer.unref?.(); }
  /** Finished work from the last day that has no mark yet (newest first). */
  pending() {
    const now = this.now(), out = [];
    for (const project of this.store.state.projects) {
      if (project.archivedAt || project.simulated !== false) continue;
      for (const action of project.initiativeRuntime?.sdkState?.actions ?? []) {
        if (action.action !== 'work' || action.status !== 'completed' || action.sourceDeleted || action.contextRevoked || project.taskMarks?.[action.id]) continue;
        const finished = Date.parse(action.finishedAt ?? action.startedAt ?? action.createdAt ?? 0);
        if (!Number.isFinite(finished) || now - finished > DAY || now - (this.attempted.get(action.id) ?? 0) < 30 * 60000) continue;
        out.push({ project, action, finished });
      }
    }
    return out.sort((a, b) => b.finished - a.finished);
  }
  async pump() {
    if (this.closed || this.running || this.store.state.emergency) return;
    const next = this.pending()[0]; if (!next) return;
    this.running = this.mark(next.project, next.action).catch(() => null).finally(() => { this.running = null; this.schedule(); });
    await this.running;
  }
  async mark(project, action) {
    this.attempted.set(action.id, this.now());
    const text = actionResultText(action);
    if (!text) return this.save(project.id, action.id, { at: iso(this.now()), needsUser: false, alreadyReported: false, skipped: 'no_result' });
    const mind = project.mind ?? {};
    const openItems = [...(mind.commitments ?? []).filter(row => (row.status ?? 'pending') === 'pending').map(row => row.request), ...(mind.agenda ?? []).filter(row => !row.stale && (row.status ?? 'open') === 'open').map(row => row.text)].filter(Boolean).slice(0, 6);
    const findings = (mind.findings ?? []).slice(-8);
    const judged = await this.decisions?.messageValue?.(project, { text, kind: 'share', findings, openItems, project: { title: project.name, taskTypes: project.taskTypes ?? [] } }).catch(() => null);
    if (!judged) return null; // no judge: the page keeps its time-based mark
    return this.save(project.id, action.id, attentionMark(judged, this.now()));
  }
  save(projectId, actionId, mark) {
    try {
      this.store.mutate(state => {
        const project = state.projects.find(row => row.id === projectId); if (!project) return;
        const marks = { ...(project.taskMarks ?? {}), [actionId]: mark };
        const keys = Object.keys(marks); if (keys.length > MARKS_KEPT) for (const key of keys.sort((a, b) => String(marks[a].at).localeCompare(String(marks[b].at))).slice(0, keys.length - MARKS_KEPT)) delete marks[key];
        project.taskMarks = marks;
      });
    } catch { return null; }
    return mark;
  }
  async close() { this.closed = true; clearTimeout(this.timer); this.unsubscribe?.(); await this.running; }
}
