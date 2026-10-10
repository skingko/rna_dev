import { createHash } from 'node:crypto';

/** This is a conservative contradiction check, not a natural-language intent
 * parser. The configured model still proposes the operating contract. Keep the
 * full cited requirement so a short excerpt cannot discard its negation. */
export function initialScheduleIntent(draft, { name = '', description = '', userMessages = [] } = {}) {
  const sources = [{ id: 'project-title', text: name }, { id: 'project-description', text: description }, ...userMessages.map(row => ({ id: row.id, text: row.text }))];
  const quote = draft.requestEvidence?.trim();
  const source = quote && sources.findLast(row => typeof row.text === 'string' && row.text.includes(quote));
  if (!source) return { allowed: false, code: 'schedule_user_source_missing' };
  const text = source.text, kind = draft.rule?.kind;
  // Later user constraints may revoke an older description. A renewed request
  // should cite that newer message rather than resurrecting the old sentence.
  const applicable = sources.slice(sources.indexOf(source)).map(row => row.text).filter(value => typeof value === 'string');
  const negative = '(?:不要|不需要|无需|不必|禁止|请勿|勿|别)';
  const cadence = { daily: '(?:每天|每日|天天|按日)', weekly: '(?:每周|每星期|按周)', interval: '(?:周期|重复|定时|间隔)' }[kind];
  const globallyDeclined = applicable.some(text => /(?:不要|不需要|无需|禁止|请勿)(?:再)?(?:安排|创建|注册|设置)?(?:任何)?(?:定时任务|日程)|\b(?:do not schedule(?:\s+(?:anything|any tasks?))?[.!]?\s*$|don't schedule[.!]?\s*$)/iu.test(text) || kind !== 'once' && /(?:仅|只)(?:限)?(?:本|这|此)(?:次|一回)|(?:不要|不需要|无需|禁止|请勿)(?:再)?(?:安排|创建|注册|设置)?(?:任何)?(?:周期任务|重复任务)|\b(?:one[- ]time only|no recurring tasks?)\b/iu.test(text));
  const cadenceDeclined = cadence && applicable.some(text => new RegExp(`${negative}\\s*(?:再|安排|创建|注册|设置)?\\s*${cadence}`, 'u').test(text) || new RegExp(`\\b(?:not|never|don't|do not|no)\\s+(?:schedule\\s+)?${{ daily: 'daily', weekly: 'weekly', interval: '(?:recurring|periodic)' }[kind]}\\b`, 'iu').test(text));
  const provenance = { sourceId: source.id, sourceHash: createHash('sha256').update(text).digest('hex'), requestEvidence: quote, sourceExcerpt: text.slice(0, 2000), interpretation: 'model_proposed_user_requirement' };
  return { allowed: !globallyDeclined && !cadenceDeclined, ...provenance, ...((globallyDeclined || cadenceDeclined) ? { code: 'schedule_explicit_constraint' } : {}) };
}
