// Localizes host API error messages written in Chinese: exact catalog entries, then `{n}` templates; unknown text is returned unchanged.
import catalog from './api-error-catalog/index.mjs';

const HAN = /[　-〿㐀-鿿＀-￯]/;
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let exact;
let templates;
const compile = () => {
  exact = new Map();
  templates = [];
  for (const [zh, en] of Object.entries(catalog)) {
    if (!/\{\d+\}/.test(zh)) { exact.set(zh, en); continue; }
    const parts = zh.split(/\{(\d+)\}/);
    const slots = [];
    let source = '^';
    parts.forEach((part, index) => { if (index % 2) { slots.push(Number(part)); source += '([\\s\\S]+?)'; } else source += escapeRegex(part); });
    templates.push({ pattern: new RegExp(`${source}$`), slots, en, weight: parts.filter((_, index) => index % 2 === 0).join('').length });
  }
  templates.sort((a, b) => b.weight - a.weight);
};
const lowerLead = text => /^[A-Z][a-z]+(\s|$)/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
const translate = (message, depth = 0) => {
  if (!HAN.test(message)) return message;
  const direct = exact.get(message);
  if (direct !== undefined) return direct;
  if (depth < 4) for (const { pattern, slots, en } of templates) {
    const match = pattern.exec(message);
    if (!match) continue;
    const values = new Map(slots.map((slot, index) => [slot, [match[index + 1], translate(match[index + 1], depth + 1)]]));
    return en.replace(/\{(\d+)\}/g, (whole, slot, offset) => { const pair = values.get(Number(slot)); return !pair ? whole : offset && pair[0] !== pair[1] ? lowerLead(pair[1]) : pair[1]; });
  }
  // A captured value nothing matches (a name, a path, the user's own words) is kept exactly: the model may call a tool with it.
  return message;
};

export const localizeErrorMessage = (message, language) => {
  if (language !== 'en' || typeof message !== 'string' || !HAN.test(message)) return message;
  if (!exact) compile();
  return translate(message);
};
export const hasHan = text => typeof text === 'string' && HAN.test(text);
export const localizeErrorBody = (body, language) => language === 'en' && body && typeof body === 'object' && hasHan(body.error) ? { ...body, error: localizeErrorMessage(body.error, language) } : body;

// Tool failures are read by the model, never by the user: English at the one host boundary that hands tools to the session.
const english = value => typeof value === 'string' ? localizeErrorMessage(value, 'en') : Array.isArray(value) ? value.map(english) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, english(item)])) : value;
export const englishToolText = text => {
  if (!hasHan(text)) return text;
  if (/^\s*[{[]/.test(text)) try { const value = JSON.parse(text), next = english(value); return JSON.stringify(next) === JSON.stringify(value) ? text : JSON.stringify(next, null, /^\{\n( +)"/.exec(text)?.[1].length); } catch {}
  return localizeErrorMessage(text, 'en');
};
export const englishToolResult = result => result?.isError && Array.isArray(result.content) && result.content.some(item => item?.type === 'text' && hasHan(item.text)) ? { ...result, content: result.content.map(item => item?.type === 'text' && hasHan(item.text) ? { ...item, text: englishToolText(item.text) } : item) } : result;
export const englishToolError = error => {
  if (!error || typeof error !== 'object' || !hasHan(error.message)) return error;
  const message = englishToolText(error.message);
  try { error.message = message; return error; } catch { return Object.assign(new Error(message), error); }
};
export const englishToolExecute = execute => (...args) => {
  const rethrow = error => { throw englishToolError(error); };
  try { const outcome = execute(...args); return typeof outcome?.then === 'function' ? outcome.then(englishToolResult, rethrow) : englishToolResult(outcome); } catch (error) { return rethrow(error); }
};
