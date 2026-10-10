/**
 * Projects and sessions being deleted in the background. They leave the local
 * index at once; until the host finishes, index updates and a re-bootstrap
 * must not bring them back (the host still lists them while it works).
 */
export const pendingDeletes = { projects: new Set<string>(), sessions: new Set<string>() }
export const deletingProject = (id: string) => pendingDeletes.projects.has(id)
export const deletingSession = (id: string) => pendingDeletes.sessions.has(id)
