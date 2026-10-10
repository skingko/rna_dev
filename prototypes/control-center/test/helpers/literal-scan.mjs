// Lexical scan for the error-text coverage test: every string and template literal with the callee chain of the parentheses around it.
const REGEX_PREV = /[(,=:\[!&|?{};+\-*%<>~^]$/;
export const IDEOGRAPH = /[㐀-鿿]/;
export function scanLiterals(src) {
  const out = [], stack = [], n = src.length, lineStarts = [0]; let i = 0, lastSig = '', lastWord = '';
  for (let k = 0; k < n; k++) if (src[k] === '\n') lineStarts.push(k + 1);
  const line = pos => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; } return lo + 1; };
  const calleeAt = pos => {
    let j = pos - 1; while (j >= 0 && /\s/.test(src[j])) j--; const end = j + 1;
    while (j >= 0 && /[\w$.?]/.test(src[j])) j--; const name = src.slice(j + 1, end).replace(/\?\./g, '.');
    let k = j; while (k >= 0 && /\s/.test(src[k])) k--; return (src.slice(Math.max(0, k - 2), k + 1) === 'new' ? 'new ' : '') + name;
  };
  const readString = q => { const start = i; i++; let val = ''; while (i < n && src[i] !== q) { if (src[i] === '\\') { val += src[i] + src[i + 1]; i += 2; } else val += src[i++]; } i++; return { kind: q, raw: val, start }; };
  const readTemplate = () => {
    const start = i, parts = []; let cur = ''; i++;
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') { cur += src[i] + src[i + 1]; i += 2; }
      else if (src[i] === '$' && src[i + 1] === '{') {
        parts.push(cur); cur = ''; i += 2; let depth = 1; const exprStart = i;
        while (i < n && depth) { const c = src[i]; if (c === '{') depth++; else if (c === '}') { depth--; if (!depth) break; } else if (c === "'" || c === '"') { readString(c); continue; } else if (c === '`') { readTemplate(); continue; } i++; }
        parts.push({ expr: src.slice(exprStart, i) }); i++;
      } else cur += src[i++];
    }
    parts.push(cur); i++; return { kind: '`', parts, start };
  };
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); i = i < 0 ? n : i + 2; continue; }
    if (c === "'" || c === '"' || c === '`') { const literal = c === '`' ? readTemplate() : readString(c); literal.callees = stack.map(row => row.callee); literal.line = line(literal.start); literal.before = src.slice(Math.max(0, literal.start - 14), literal.start); out.push(literal); lastSig = 'x'; continue; }
    if (c === '/' && (lastSig === '' || REGEX_PREV.test(lastSig) || /^(return|typeof|case|in|of|throw|else|do)$/.test(lastWord))) {
      i++; let inClass = false;
      while (i < n && (src[i] !== '/' || inClass)) { if (src[i] === '\\') i++; else if (src[i] === '[') inClass = true; else if (src[i] === ']') inClass = false; else if (src[i] === '\n') break; i++; }
      i++; while (/[a-z]/.test(src[i] ?? '')) i++; lastSig = 'x'; lastWord = ''; continue;
    }
    if (c === '(') stack.push({ callee: calleeAt(i) }); else if (c === ')') stack.pop();
    if (!/\s/.test(c)) {
      lastSig = c;
      if (/[\w$]/.test(c)) { let j = i; while (/[\w$]/.test(src[j] ?? '')) j++; lastWord = src.slice(i, j); i = j; lastSig = 'x'; continue; }
      lastWord = '';
    }
    i++;
  }
  return out;
}

const ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
export const cook = raw => raw.replace(/\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r?\n)|([\s\S]))/g, (whole, braced, unicode, hex, newline, plain) => braced ? String.fromCodePoint(parseInt(braced, 16)) : unicode || hex ? String.fromCharCode(parseInt(unicode || hex, 16)) : newline ? '' : ESCAPES[plain] ?? plain);

/** The texts a literal can produce, with every `${expr}` replaced by a sample value; `${cond ? `：${x}` : ''}` yields both forms. */
export function sampleTexts(literal) {
  if (literal.kind !== '`') return [cook(literal.raw)];
  let texts = [''];
  for (const part of literal.parts) {
    if (typeof part === 'string') { texts = texts.map(text => text + cook(part)); continue; }
    const optional = /\?\s*`((?:[^`\\]|\\.)*)`\s*:\s*''\s*$/.exec(part.expr), options = optional ? ['', cook(optional[1]).replace(/\$\{[^}]*\}/g, 'X')] : ['X'];
    texts = texts.flatMap(text => options.map(option => text + option));
  }
  return texts;
}
