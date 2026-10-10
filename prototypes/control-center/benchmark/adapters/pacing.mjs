import { pacingSignals, pacingThreshold } from '../../proactive-pacing.mjs';

// K2 pacing adapter (benchmark/features.mjs contract): the controller holds
// night/away messages in their threads and emits one welcome-back summary.
export default {
  available: () => true,
  /** Current pacing view for diagnostics: threshold with its factors. */
  read(store, projectId, { now = Date.now() } = {}) {
    const project = store.state.projects.find(row => row.id === projectId); if (!project) return null;
    const signals = pacingSignals(project, store.state.sessions.filter(row => row.projectId === projectId && !row.archivedAt), { now });
    return { ...pacingThreshold(signals), signals, stored: project.mind?.pacing ?? null };
  },
};
