/**
 * How a background task is named to the user. A work/share decision names it itself (`title`, one plain line written
 * for the user); a scheduled run is named by its schedule; anything else falls back to the first sentence of the
 * instruction the decision model wrote, without evidence handles (E1, E16 …), host tool names or record ids. Handles
 * only mean something inside the one decision that used them; tool names and ids mean nothing to the user (live,
 * 2026-10-03: 后台“…project_history 读失败动作 007c353e…”没做完).
 */
// A list of handles goes as one unit ("(E4, E5)", "E2 and E3", "E3、E5"), with a preposition whose only object it was
// ("Draft it from E2 and E3." reads "Draft it.", "根据 E3、E5 继续写" reads "继续写").
const ONE_HANDLE = '(?<![A-Za-z0-9_])E\\d{1,3}(?![0-9A-Za-z_])', HANDLE_LIST = `${ONE_HANDLE}(?:(?:\\s*[,，、/]\\s*|\\s+(?:and|or)\\s+|\\s*[和与及或]\\s*)${ONE_HANDLE})*`;
const HANDLE = new RegExp(`\\s?(?:(?<![A-Za-z0-9_])(?:from|in|on|at|by|with|per|see|of)\\s+(?=${HANDLE_LIST}\\s*(?:[.,;:!?)）。，；：！？]|$)))?(?:(?:根据|按照|依据|基于|参考|参照|依照|结合)\\s*(?=${HANDLE_LIST}(?!\\s*的)))?${HANDLE_LIST}\\s?`, 'g');
// Spacing around a removed handle: keep one space only between Latin words.
const rejoin = (match, offset, whole) => /[A-Za-z0-9]/.test(whole[offset - 1] ?? '') && /[A-Za-z0-9]/.test(whole[offset + match.length] ?? '') ? ' ' : '';
// A bracket left empty (or holding only separators) goes with the space before it ("output (E2)." reads "output.").
export function withoutHandles(text) { return String(text ?? '').replace(HANDLE, rejoin).replace(/[ \t]{2,}/g, ' ').replace(/[ \t]*(?:（[\s,，、/]*）|\([\s,，、/]*\))/g, '').replace(/(?<=[\u3400-\u9fff]) (?=[「『“（【])/gu, '').trim(); }
// Record ids: a UUID anywhere, a hex hash only right after the record it names ("turn e666f3a6", "动作 007c353e"; a
// capitalized Run/Turn starts a sentence as a verb, "Run cafe1234 again", and is not a record name); a bare
// hex-looking word is an ordinary word (decade1, cafe1234, a colour code). A named English id takes its name with it, and
// a preposition left pointing at nothing goes too ("Run the deploy for session abcdef12." reads "Run the deploy.").
// Host tool names (project_history, mcp__…) go as well. Words inside a path or file name (project_notes.md,
// out/3fa9b2c1.png) are left alone.
const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', HEX_ID = `(?:${UUID}|(?=[0-9a-f]*\\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40})`, ID_END = '(?![A-Za-z0-9_/-]|\\.[A-Za-z0-9])';
const NAMED_ID = `(?<![A-Za-z0-9_./-])(?:turn|[Aa]ction|[Jj]ob|run|[Ss]ession|[Ii]tem)\\s?[:#]?\\s?${HEX_ID}`;
const DANGLING = `(?<![A-Za-z0-9_./-])(?:for|of|in|on|from|at|to|by|with|about)\\s(?=${NAMED_ID}${ID_END}(?:\\s*[.,;:!?)）。，；：！？]|\\s*$|\\s(?:and|or|then|but)\\b))`;
const RECORD_ID = new RegExp(`\\s?(?:(?:${DANGLING})?${NAMED_ID}|(?<=(?:动作|行动|任务|会话|回合|轮次|消息|条目)\\s?[:：#]?\\s?)${HEX_ID}|(?<![A-Za-z0-9_./-])${UUID})${ID_END}\\s?`, 'g');
const TOOL_NAME = /\s?(?<![A-Za-z0-9_./-])(?:mcp__[\w-]+|(?:project|memory|openviking|marketplace|capability|skill|schedule)_[a-z0-9_]+)(?![A-Za-z0-9_/-]|\.[A-Za-z0-9])\s?/g;
// Quotes a removed tool name leaves empty go with the space before them ('Check "skill_load" output' reads 'Check output').
export function withoutInternals(text) { return String(text ?? '').replace(RECORD_ID, rejoin).replace(TOOL_NAME, rejoin).replace(/[ \t]*(?:""|''|“”|‘’|「」|『』|``)/g, ''); }
const clip = (text, limit) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
/** A name as the user reads it: one line, without handles, tool names or record ids. */
const cleanLine = text => withoutHandles(withoutInternals(String(text ?? '').replace(/\s+/g, ' ').trim()));
export function taskLine(text, limit = 160) {
  const value = cleanLine(text);
  const first = value.match(/^.+?[。！？!?](?=\s|$|[^。！？!?])/u)?.[0] ?? value;
  return clip(first, limit);
}

/** The schedule a host-scheduled action runs, if the project still has it. */
export const scheduleOf = (project, action) => action?.hostSchedule ? project?.schedules?.find(row => row.id === action.hostSchedule.scheduleId) ?? null : null;
// The host's scheduled work instruction: "Scheduled occurrence …\nDue: …\nTime rule: …\n\n<the schedule's task>\n\nProduce the requested deliverable …".
const SCHEDULED_TAIL = '\n\nProduce the requested deliverable';
/** The task a scheduled run was given, as it stood when it ran (the schedule may have changed or gone since). */
export function scheduledTaskOf(action) {
  const content = String(action?.content ?? '');
  if (!action?.hostSchedule || !content.startsWith('Scheduled occurrence ')) return '';
  const head = content.indexOf('\n\n'), tail = content.indexOf(SCHEDULED_TAIL, head + 2);
  return head < 0 ? '' : content.slice(head + 2, tail < 0 ? undefined : tail).trim();
}
/**
 * What a background action is, in the user's words. A scheduled run is named by the schedule the user set up:
 * its content is the host's own instruction to the worker (occurrence key, due time, rule JSON, delivery rules)
 * and was shown verbatim before (live, 2026-10-03). Model work is named by its decision's `title`, else by the
 * first sentence the model wrote. A revoked action's content is a placeholder for the model and never a name.
 * `quoted`: the caller puts the label inside its own quotes, so the name is not framed again. `bare`: the caller says
 * itself that this is a scheduled run (a run card's kind), so a scheduled run is its schedule's name alone ('' if none).
 */
export function actionLabel(project, action, { limit = 160, language = 'zh', quoted = false, bare = false } = {}) {
  if (!action?.hostSchedule) return (typeof action?.title === 'string' ? clip(cleanLine(action.title), limit) : '') || taskLine(action?.contextRevoked ? '' : action?.content, limit);
  // A schedule deleted since: name the run by the task it was given.
  const title = String(scheduleOf(project, action)?.title ?? '').replace(/\s+/g, ' ').trim() || taskLine(scheduledTaskOf(action), limit);
  const name = clip(title, limit);
  if (bare) return name;
  if (quoted) return language === 'en' ? (name ? `${name} (scheduled task)` : 'scheduled task') : (name ? `${name}（定时任务）` : '定时任务');
  return language === 'en' ? (name ? `the scheduled task "${name}"` : 'a scheduled task') : (name ? `定时任务「${name}」` : '定时任务');
}
