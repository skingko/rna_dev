import { inLanguage, LANGUAGE_NAMES } from './interface-language.mjs';

// 直接处理 (direct fix) text. What the user reads (the card and the detail under it) follows the interface language;
// what the worker model reads (the task) is fixed English and only names the language its report is written in.

/**
 * The worker's task for a directly handled finding. Model-visible, so English whatever the interface language; the
 * report it writes ends up in the card's detail, which the user reads, so it is asked for in the interface language.
 */
export function directFixTask(finding, language = 'zh') {
  return `Direct fix: the text below is a background finding. Correct only the objective, unambiguous errors in it (typos, names or numbers that disagree, contradictions with the project's own records, broken references, inaccurate records), making the edits in the project files with project_edit / project_write. Make no creative, stylistic or directional changes, and leave anything uncertain for the user. After editing, read each change back to verify it. Finish with a short report written in ${LANGUAGE_NAMES[language] ?? LANGUAGE_NAMES.zh}: which files you changed, what you changed in each, and what you deliberately left alone and why.\n\nBackground finding:\n${finding}`;
}

/**
 * The detail under the card: the worker's own report (or a one-line fallback), the files it changed (`mark`: 'new' |
 * 'deleted' | null) and, when asked, what the revert cannot restore (`skipped`) or what was not applied (`secret`).
 */
export function directFixDetail({ report = '', files = [], skipped = [], secret = '', language = 'zh' } = {}) {
  const say = (zh, en) => inLanguage(language, { zh, en }), join = list => list.join(language === 'en' ? ', ' : '、');
  const marks = { new: say('（新建）', ' (new)'), deleted: say('（删除）', ' (deleted)') };
  return [report || say('已按后台结论完成修正。', 'The fixes from the background finding are done.'), '', say('修改的文件：', 'Changed files:'), ...files.map(row => `- ${row.path}${marks[row.mark] ?? ''}`),
    ...(skipped.length ? ['', say(`另有 ${skipped.length} 个文件改动未留快照，回退时不会还原：${join(skipped.slice(0, 5))}`, `${skipped.length} more changed file${skipped.length === 1 ? ' has' : 's have'} no snapshot and will not be restored on revert: ${join(skipped.slice(0, 5))}`)] : []),
    ...(secret ? ['', secret] : [])].join('\n').slice(0, 8000);
}

/** The 已直接处理 card: keep or revert the fixes just applied. Option ids (`keep`, `revert`) are the contract; labels are display. */
export function directFixCard({ count, detail, language = 'zh' }) {
  const say = (zh, en) => inLanguage(language, { zh, en }), files = `${count} ${count === 1 ? 'file' : 'files'}`;
  return { id: 'decision', header: say('已直接处理', 'Handled directly'), question: say(`我发现了几处明确的问题，已经直接修正（${count} 个文件）。要保留这些修改吗？`, `I found a few clear-cut problems and fixed them directly (${files}). Keep these changes?`), detail,
    options: [{ id: 'keep', label: say('确认保留', 'Keep changes') }, { id: 'revert', label: say('回退这些修改', 'Revert these changes'), description: say(`把 ${count} 个文件还原到修改前`, `Restore ${files} to how they were before`) }], allowCustom: true };
}
