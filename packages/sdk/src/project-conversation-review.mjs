import { createHash } from 'node:crypto';
import { validateToolArguments } from './capabilities.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => Object.assign(new Error(message), { code: 'invalid_judge' });
const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const reference = object({ evidenceId: text(64), quote: text(2000) });
const issue = object({ kind: { enum: ['contradiction', 'unsupported_inference', 'constraint_loss', 'unverified_delivery'] }, reason: text(1500), references: { type: 'array', minItems: 2, maxItems: 6, items: reference } });
export const conversationReviewSchema = object(Object.fromEntries(['left', 'right'].map(side => [side, object({
  turns: { type: 'array', minItems: 2, maxItems: 6, items: object({ turn: { type: 'integer', minimum: 1, maximum: 6 }, assessment: { enum: ['no_material_issue_found', 'issue_found', 'not_assessable'] }, answerId: text(64), reason: text(1500), issues: { type: 'array', maxItems: 4, items: issue } }) },
  coverage: { enum: ['complete', 'partial'] }, limitations: text(2000),
})])));

// Bounded segments match the existing judge's head/tail preview. Keeping
// segments separate prevents a quote across an omitted interval being accepted.
function unit(side, kind, turn, value) {
  if (typeof value !== 'string' || !value.trim()) throw fail('Conversation review requires actual nonempty turn evidence');
  const chars = Array.from(value), truncated = chars.length > 16000, sha256 = hash(value);
  return { id: `${side}_${kind}_${turn}_${sha256.slice(0, 16)}`, kind, turn, sha256,
    segments: truncated ? [chars.slice(0, 12000).join(''), chars.slice(-4000).join('')] : [value], truncated };
}

/** Host-frozen text identities; never a claim that these sentences are true.
 * This opt-in is part of the case hash, so retries cannot silently add/remove it.
 * It reuses the paired judge request and introduces no additional model call.
 */
export function frozenConversationEvidence(testCase, sides) {
  if (!testCase.reviewConversation) return undefined;
  const inputs = [testCase.input, ...(testCase.followUps ?? []).map(row => row.input)];
  if (inputs.length < 2 || inputs.length > 6) throw fail('Conversation review requires two to six frozen user turns');
  const result = { schemaVersion: 1, sides: {}, scope: 'host_text_identity_verified_semantics_model_assessed' };
  for (const side of ['left', 'right']) {
    const receipts = sides[side]?.turns;
    if (!Array.isArray(receipts) || receipts.length !== inputs.length) throw fail('Conversation review is missing a real turn receipt');
    const units = [], turns = [];
    for (const [index, input] of inputs.entries()) {
      const receipt = receipts[index], turn = index + 1;
      if (receipt.turn !== turn || receipt.input !== input || receipt.answerTruncated === true) throw fail('Conversation receipt does not match the frozen input or complete retained answer');
      const user = unit(side, 'input', turn, input), answer = unit(side, 'answer', turn, receipt.answer);
      units.push(user, answer); turns.push({ turn, inputId: user.id, answerId: answer.id });
    }
    result.sides[side] = { turns, units, truncated: units.some(row => row.truncated) };
  }
  return { ...result, evidenceHash: hash(JSON.stringify(result)) };
}

export function validateConversationReview(review, evidence) {
  if (!evidence) return undefined;
  try { validateToolArguments(conversationReviewSchema, review); } catch { throw fail('Conversation ratings require a bounded review for both sides'); }
  for (const side of ['left', 'right']) {
    const row = review[side], frozen = evidence.sides[side], units = new Map(frozen.units.map(item => [item.id, item]));
    if (row.turns.length !== frozen.turns.length) throw fail('Conversation review must cover every executed turn, including earlier failures');
    for (const [index, finding] of row.turns.entries()) {
      const turn = frozen.turns[index];
      if (finding.turn !== turn.turn || finding.answerId !== turn.answerId) throw fail('Conversation finding references a missing, duplicate or wrong-side turn');
      if ((finding.assessment === 'issue_found') !== Boolean(finding.issues.length)) throw fail('Conversation assessment and issue findings disagree');
      for (const issue of finding.issues) {
        const seen = new Set(); let actualAnswer = false, context = false;
        for (const ref of issue.references) {
          const source = units.get(ref.evidenceId), key = `${ref.evidenceId}\u0000${ref.quote}`;
          if (!source || source.turn > turn.turn || !ref.quote.trim() || !source.segments.some(segment => segment.includes(ref.quote)) || seen.has(key)) throw fail('Conversation issue cites unseen, future, duplicate or non-verbatim evidence');
          seen.add(key); actualAnswer ||= source.id === turn.answerId; context ||= source.kind === 'input' || source.turn < turn.turn;
        }
        if (!actualAnswer || !context) throw fail('Conversation issues must bind the current answer to its available task or earlier context');
      }
    }
    if (row.coverage === 'complete' && (frozen.truncated || row.turns.some(turn => turn.assessment === 'not_assessable'))) throw fail('Complete conversation review cannot claim unseen or unassessable turns');
  }
  return structuredClone(review);
}

export const PROJECT_CONVERSATION_REVIEW_GUIDANCE = `When hostContext.conversationEvidence is provided, return conversationReview for both sides and exactly one ordered row for every observed turn. Use that turn's host answerId. Inspect the actual answer in the context available at that turn: still-valid earlier instructions, user corrections, and prior answers. A later correction does not erase an earlier mistake; later evidence cannot make an earlier appropriately qualified answer wrong. Check for unsupported inferences, lost constraints, contradictions and claims of delivery without receipts. In particular, absence of measurement is not proof of historical nonexistence; a numeric value is not its source representation; a proposed future workflow is not an existing user requirement. Do not invent extra requirements to create a defect. A material issue needs exact quotes referencing the current answer and relevant input or prior answer using same-side evidence IDs. Frozen research source support is assessed separately in sourceReview. IDs establish text identity only, not semantic correctness. Boundaries between preview segments contain omitted text and cannot be quoted across. Use not_assessable and partial coverage when evidence is insufficient, not a guessed pass. 'complete' means every supplied turn was reviewed with no omitted answer text, not an exhaustive proof of all claims. Reflect issues and limitations only in applicable frozen criterion scores. A semantic observation does not add a new scoring criterion: when a frozen criterion assesses only the final artifact, an earlier corrected explanation need not reduce that criterion. Preserve the earlier finding independently of the scores. This is a model's evidence-based assessment, not an independent deterministic quality guarantee.`;
