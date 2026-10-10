import { narrate } from '../../proactive-narrator.mjs';

// K2 narrator adapter (benchmark/features.mjs contract). The controller routes
// every share and scheduled delivery through the narrator; scenarios drive it
// through the real controller (schedules, project_present, the judge's
// self-revision). There is no host rewrite: `rewriteScheduled` returns the
// agent's text unchanged (kept for older scenario code).
export default {
  available: () => true,
  narrate,
  async rewriteScheduled({ text }) { return String(text ?? ''); },
};
