import { inLanguage, interfaceLanguageOf } from './interface-language.mjs';

// The language of the text the CLI itself prints for a person to read (help, usage, status and progress lines, prompts,
// CLI-side errors). It follows the app's interface language, `settings.interfaceLanguage`, which the running daemon holds:
// one bounded GET /api/health, made only at the moment CLI-owned text is about to be printed (`languageReady()`), never
// for a command that prints just the daemon's JSON. Unset, unreachable or slow daemon, and commands that run without one
// (service, recovery, bench, maintenance prune/compact-journals) keep Chinese, the language the app shipped with, so
// the Chinese text is exactly what it always was.
//
// Not translated here: command names, flags, JSON output and its fields, ids, and text that comes from the daemon (the
// daemon localizes its own errors).
let language = 'zh', source = null, pending = null;

/** The language CLI text is printed in right now. */
export const cliLanguage = () => language;
/** Fixes the language (a daemon answer already carried it, or a test): no probe is made afterwards. */
export function setCliLanguage(value) { language = value === 'en' ? 'en' : 'zh'; source = null; pending = Promise.resolve(); }
/** Registers the daemon the language is read from, on first use of `languageReady()`; forgets an earlier answer. */
export function useDaemonLanguage({ base, timeoutMs = 1500 }) {
  language = 'zh'; pending = null;
  source = async () => {
    const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok ? interfaceLanguageOf(await response.json()) : 'zh';
  };
}
/** Resolves once the language is known (at most one request per process); never rejects, an unanswered probe leaves Chinese. */
export function languageReady() {
  if (!source) return Promise.resolve();
  pending ??= source().then(value => { language = value; }, () => {});
  return pending;
}

/** The Chinese or English variant of a line, by the language resolved above. */
export const say = (zh, en) => inLanguage(language, { zh, en });
/** A line in both languages, for text that is chosen later (usage strings, labels): `textOf` picks one. */
export const text = (zh, en) => ({ zh, en });
export const textOf = value => (typeof value === 'string' ? value : say(value.zh, value.en));
export const zhOf = value => (typeof value === 'string' ? value : value.zh);
export const enOf = value => (typeof value === 'string' ? value : value.en);

// Usage strings and ID labels carry Chinese placeholders (`<会话ID>`); in English they read from this glossary, the same
// words the English help uses. Longest entries first, so `核对说明` wins over `说明`.
const GLOSSARY = [
  ['会话 ID', 'session ID'], ['会话ID', 'session ID'], ['项目 ID', 'project ID'], ['项目ID', 'project ID'], ['历史项目ID', 'earlier project ID'],
  ['供应商 ID', 'provider ID'], ['供应商ID', 'provider ID'], ['日程 ID', 'schedule ID'], ['日程ID', 'schedule ID'], ['动作 ID', 'action ID'], ['动作ID', 'action ID'],
  ['版本 ID', 'version ID'], ['版本ID', 'version ID'], ['交互 ID', 'interaction ID'], ['交互ID', 'interaction ID'], ['模型ID', 'model ID'],
  ['搜索结果ID', 'search result ID'], ['附件ID', 'attachment ID'], ['回放ID', 'replay ID'], ['探针ID', 'probe ID'], ['操作ID', 'operation ID'], ['候选ID', 'candidate ID'],
  ['恢复点ID', 'recovery point ID'], ['完整行动ID', 'full action ID'], ['后台行动 ID', 'background action ID'], ['行动ID', 'action ID'],
  ['核对说明', 'reconciliation note'], ['公开能力关键词', 'public capability keywords'], ['包内相对路径', 'path inside the package'], ['内容', 'text'],
  ['项目说明', 'description'], ['数量', 'count'], ['组件键', 'component key'], ['组件', 'component'], ['说明', 'note'], ['类型…', 'type…'], ['类型', 'type'],
  ['能力包JSON文件', 'capability package JSON file'], ['JSON文件', 'JSON file'], ['文件路径', 'file path'], ['文本文件', 'text file'], ['项目相对路径', 'project-relative path'],
  ['HTML相对路径或Vite目录', 'HTML path or Vite directory'], ['本地目录', 'local directory'], ['调整内容', 'adjustment'], ['推理档位', 'reasoning level'],
  ['--api-key-env 环境变量名', '--api-key-env NAME'], ['--api-key-env 名称', '--api-key-env NAME'], ['--timeout-ms 毫秒', '--timeout-ms MILLISECONDS'], ['--timeout 秒', '--timeout SECONDS'],
  ['--point 决策点', '--point DECISION_POINT'], ['--title 标题', '--title TITLE'], ['--out 文件', '--out FILE'], ['名称', 'name'], ['目录', 'directory'], ['路径', 'PATH'], [' 或 ', ' or ']
].sort((a, b) => b[0].length - a[0].length);
/** The English reading of a usage string or an ID label; always English, whatever the current language is. */
export const glossEn = value => GLOSSARY.reduce((out, [zh, en]) => out.replaceAll(zh, en), String(value));

/** A CLI-side error: `message` is the Chinese line (what it always was), `english` the same line in English. */
export class CliError extends Error {
  constructor(zh, en, options) { super(zh, options); this.english = en; }
}
export const cliError = (zh, en, options) => new CliError(zh, en, options);
/** The error's line in the current language; an error from the daemon or the system keeps its own text. */
export const errorText = error => (language === 'en' && typeof error?.english === 'string' ? error.english : error?.message);
/** Resolves the language when the error is a CLI-side one, i.e. one whose line has an English variant. */
export const errorReady = error => (typeof error?.english === 'string' ? languageReady() : Promise.resolve());
