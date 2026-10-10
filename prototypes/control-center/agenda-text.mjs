import { inLanguage } from './interface-language.mjs';

// An evolution request (the user asked Rna to improve itself) is kept as an agenda row. The stored line is what the model
// reads, so its prefix is fixed English; the user's views show it in the interface language. Rows written before this
// carry the Chinese prefix: they read as English to the model and render in either language for the user. The row is
// recognised by `source.from`, so a row whose text the user edited (no prefix any more) is left as written.
const PREFIX = Object.freeze({ en: 'Evolution request: ', zh: '进化请求：' });
const rest = row => {
  if (row?.source?.from !== 'evolution_request' || typeof row.text !== 'string') return null;
  const prefix = Object.values(PREFIX).find(value => row.text.startsWith(value));
  return prefix ? row.text.slice(prefix.length) : null;
};

/** The line stored for a new evolution request. */
export const evolutionRequestText = text => `${PREFIX.en}${text}`;
/** An agenda row's text as the model reads it. */
export const agendaModelText = row => { const tail = rest(row); return tail === null ? row?.text : `${PREFIX.en}${tail}`; };
/** An agenda row's text as the user reads it, in the interface language. */
export const agendaUserText = (row, language) => { const tail = rest(row); return tail === null ? row?.text : `${inLanguage(language, PREFIX)}${tail}`; };
/** An agenda row for the user: the same row, with its text in the interface language (the row itself is returned when nothing changes). */
export const agendaForUser = (row, language) => { const text = agendaUserText(row, language); return text === row?.text ? row : { ...row, text }; };
