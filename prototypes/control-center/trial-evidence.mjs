import { TRIAL_USES } from './project-genes.mjs';
import { methodGenes } from './project-mind.mjs';
import { conversationTimeline } from './proactive-pacing.mjs';

// A trial working rule (a skill patch) becomes active only on the user's own feedback: TRIAL_USES confident "followed" judgments
// of foreground turns that carried it, each followed by a message that did not correct it (gene-evolution-service.mjs
// recordRuleUse, countClean). Background runs are never judged, and a user who is away sends no next message: a rule whose
// work is mostly done in the background, with nobody around, stays on trial for ever, in force and never proven or retired.
// This is the way out. It asks once (the `no_evidence` retire invitation); only the user's answer retires anything, and a
// refusal raises the bar. Everything is read from counts and times, in code: no model, no judgment point.
//
// What counts as "the proof cannot come" is measured on the project's own activity, not on a number of days:
// - `unjudged`: placements of the rule in a model's context (a foreground turn's block, or a background run that read it in its
//   skill) that no judgment could use, `stats.injected - stats.recalled`. A trial rule needs TRIAL_USES judged uses to be
//   proven; having been placed that many times with nothing to judge by is the first sign the trial is not getting its proof.
// - `waited`: how long it has been in force while the user was not here: since the user last wrote (or answered a card of this
//   kind), or since the rule was written if later. The yardstick is the user's own longest absence in this project (the
//   longest gap between two of their messages): proof would come when they return, so only a wait of more than twice as long
//   as they have ever been away says it is not coming soon. A project with no gap yet (fewer than two messages) says nothing.
// Measured on the live projects on 2026-10-22 (benchmark/trial-gene-evidence.mjs): the research project's user wrote until 10-03
// and was never away more than 2.6 days (bar 5.1); its three trial rules were read by 17-18 daily runs since, every one of those
// placements unjudged, and have waited 17-19 days: all three are asked about, one at a time. The novel project's ten trial rules
// are barely read by anything (0-1 runs each): the user is away 13 days (bar 11.6) but nothing runs them, so nothing is asked.
/** The `usage` of the invitation (web NudgeStrip GENE_QUESTIONS). */
export const NO_EVIDENCE = 'no_evidence';
/** A wait is "not coming soon" when it is longer than this many times the user's longest absence so far. */
export const AWAY_FACTOR = 2;

/** Placements of a rule in a model's context that no judgment could use (never followed or gone against with confidence). */
export const unjudgedOf = gene => { const stats = gene?.stats ?? {}; return Math.max(0, (stats.injected ?? 0) - (stats.recalled ?? 0)); };
const at = value => { const ms = Date.parse(value ?? ''); return Number.isFinite(ms) ? ms : 0; };

/**
 * The user's own rhythm in a project: when they last wrote (or answered a card of this kind, `touched`), and the longest gap
 * between two messages of theirs. `longest` is null before there are two messages.
 */
export function userRhythm(sessions, { touched = 0 } = {}) {
  const times = conversationTimeline(sessions).filter(row => row.kind === 'user').map(row => row.at).sort((a, b) => a - b);
  let longest = null;
  for (let index = 1; index < times.length; index++) longest = Math.max(longest ?? 0, times[index] - times[index - 1]);
  return { last: Math.max(times.at(-1) ?? 0, touched), longest, messages: times.length };
}

/**
 * How many unjudged placements the next ask needs. TRIAL_USES to begin with. A refusal (keep, or closing the card) is evidence
 * that the user wants rules to run without judgment: the project's next ask needs twice the count they refused (any rule's:
 * the refusal says what they put up with, not which rule); a card that only lapsed (the user wrote instead) lets the same rule
 * be asked again after TRIAL_USES more. No fixed interval and no cap on the number of asks: the bar rises with the evidence.
 */
export function evidenceBar(project, gene) {
  const refused = project?.genes?.evidenceAsks?.refused ?? 0, prior = gene?.evidenceAsk ?? null;
  let required = Math.max(TRIAL_USES, refused * 2);
  if (prior?.outcome === 'asked') required = Math.max(required, (prior.unjudged ?? 0) + TRIAL_USES);
  return required;
}

/**
 * Whether one trial working rule has run out of road, and why not when it has not. `rhythmOf`: a function giving userRhythm of the
 * project's live conversations (read only when the rule has placements enough to be asked about). Returns { ask: false, why, ... } or { ask: true, unjudged, required, waited, longest }.
 * Only a rule that is on trial, that nobody has settled (confirmed, kept, already asked about for another reason), that no
 * correction has touched (a same-point correction is evidence; this is about the lack of any) and that was not followed
 * enough times already (that one only waits for a message) is a candidate.
 */
export function trialVerdict(project, gene, rhythmOf, { now = Date.now() } = {}) {
  const stats = gene?.stats ?? {};
  if (gene?.status !== 'trial') return { ask: false, why: 'not_on_trial' };
  if (gene.keep === true || gene.confirmedAt || (gene.confirmations ?? 0) > 0 || gene.retireOffered) return { ask: false, why: 'settled' };
  if ((stats.missed ?? 0) > 0) return { ask: false, why: 'corrected' };
  if ((stats.applied ?? 0) >= TRIAL_USES) return { ask: false, why: 'followed_enough' };
  const unjudged = unjudgedOf(gene), required = evidenceBar(project, gene);
  if (unjudged < required) return { ask: false, why: 'too_few_placements', unjudged, required };
  const rhythm = rhythmOf();
  if (rhythm.longest === null) return { ask: false, why: 'no_rhythm', unjudged, required };
  const waited = now - Math.max(rhythm.last, at(gene.createdAt)), longest = rhythm.longest;
  if (!(waited > AWAY_FACTOR * longest)) return { ask: false, why: 'not_away_long_enough', unjudged, required, waited, longest };
  return { ask: true, unjudged, required, waited, longest };
}

/**
 * Every trial working rule of the project with its verdict, and the one to ask about now: the most placements nobody could
 * judge first, the oldest first among equals. One at a time is the caller's (a card of this kind open asks nothing more).
 * @returns {{ rows: { gene: object, ask: boolean, why?: string }[], ask: object | null }}
 */
export function trialEvidence(project, sessions, { now = Date.now() } = {}) {
  const rules = methodGenes(project).filter(row => row.status === 'trial');
  if (!rules.length) return { rows: [], ask: null };
  const touched = at(project?.genes?.evidenceAsks?.answeredAt);
  let rhythm = null; const rhythmOf = () => rhythm ??= userRhythm(sessions, { touched });
  const rows = rules.map(gene => ({ gene, ...trialVerdict(project, gene, rhythmOf, { now }) }));
  const ask = rows.filter(row => row.ask).sort((a, b) => b.unjudged - a.unjudged || String(a.gene.createdAt ?? '').localeCompare(String(b.gene.createdAt ?? '')) || String(a.gene.id).localeCompare(String(b.gene.id)))[0] ?? null;
  return { rows, ask };
}
