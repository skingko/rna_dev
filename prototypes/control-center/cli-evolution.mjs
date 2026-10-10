// `./rna doctor`'s evolution section (P2 batch D, D3; the system review's "answering 'no generations since 0.58' took reading the
// lessons, funnels and session items by hand"): per project, where each evolution lane is and why nothing happens, what every
// rule was run or shown for (a check that never ran, a skill rule shown many times and never followed), what became of lessons
// and corrections that did not turn into a rule (typed: terminal vs retryable, ModularRSI dispositions.py), how the work fared
// across generations, the prediction scoreboard (rrsi loop.py:159-176), the harm readings and the last contrast analyses.
// Read-only (GET /api/v2/projects/:id/genes/observability), counts and codes only; the host words its own notes in the interface language.

const sum = (rows, pick) => rows.reduce((total, row) => total + (pick(row) ?? 0), 0);
/** One project's compact evolution summary from its observability view. */
export function evolutionSummary(project, view) {
  const live = view?.genes ?? [], guards = live.filter(row => row.layer === 'guard'), rules = live.filter(row => row.layer !== 'guard');
  const { generation = null, ...lanes } = view?.status ?? {};
  const board = view?.scoreboard ?? [], counted = verdict => board.filter(row => row.verdict === verdict).length;
  return {
    projectId: project.id, name: project.name ?? null, enabled: view?.enabled ?? null, generation, lanes,
    // Exposure, never the self-confirming level: a check's runs, how often a skill rule was put in front of the model and confidently followed.
    // A check that ran before its runs were counted by day has no last-7-days number (null, not 0): `trackedLast7Days` says how many have one.
    exposure: {
      guards: { live: guards.length, neverRan: guards.filter(row => !row.ran).length, ranLast7Days: guards.some(row => row.ranRecent !== null && row.ranRecent !== undefined) ? sum(guards, row => row.ranRecent) : null, trackedLast7Days: guards.filter(row => row.ranRecent !== null && row.ranRecent !== undefined).length, realCatches: sum(guards, row => row.real) },
      rules: { live: rules.length, exposureRecorded: rules.filter(row => row.shown !== null && row.shown !== undefined).length, shown: sum(rules, row => row.shown), followed: sum(rules, row => row.applied), injectedLast7Days: sum(rules, row => row.injectedRecent), earnedNothing: (view?.bloat?.rules ?? []).filter(row => row.unproven).length },
    },
    dispositions: { lessons: view?.dispositions?.lessons?.counts ?? null, corrections: view?.dispositions?.corrections?.counts ?? null, rules: view?.dispositions?.genes ?? null },
    outcomes: { total: view?.outcomes?.total ?? 0, byOutcome: view?.outcomes?.byOutcome ?? {}, schedules: (view?.outcomes?.schedules ?? []).length },
    generations: (view?.generations ?? []).slice(0, 5).map(row => ({ n: row.n, correctedShare: row.rate, corrected: row.bad, reacted: row.known, before: row.before?.rate ?? null })),
    scoreboard: { held: counted('held'), correctedAgain: counted('again'), pending: counted('pending') },
    harm: (view?.harm ?? []).filter(row => row.state !== 'ok').map(row => ({ geneId: row.geneId, state: row.state, matchedPairs: row.shared, correctedBefore: row.before?.rate ?? null, correctedAfter: row.after?.rate ?? null })),
    bloat: view?.bloat ? { promptGrowth: view.bloat.ratio, earnedNothing: view.bloat.rules.filter(row => row.unproven).length, startsAt: view.bloat.minimum } : null,
    analyses: (view?.contrasts ?? []).slice(0, 3).map(row => ({ at: row.at, turns: row.turns, trouble: row.trouble, pairs: row.pairs ?? 0, patches: row.committed ?? 0 })),
    funnel: view?.funnel ?? null,
    notes: view?.notes ?? [],
  };
}
/**
 * The doctor's `evolution` section: the named project, or every project that is not archived (at most `limit`).
 * `call(path)`: the CLI's own `/api/…` caller. A project that cannot be read says so; the doctor goes on.
 */
export async function evolutionSection(call, projectId = null, { limit = 8 } = {}) {
  const projects = projectId ? [{ id: projectId }] : ((await call('/v2/bootstrap')).projects ?? []).filter(row => !row.archivedAt).slice(0, limit);
  const out = [];
  for (const project of projects) {
    try { out.push(evolutionSummary(project, await call(`/v2/projects/${project.id}/genes/observability`))); }
    catch (error) { out.push({ projectId: project.id, name: project.name ?? null, available: false, error: error.message }); }
  }
  return out;
}
