/**
 * The interface language the user picked in the app. The client syncs it into
 * `settings.interfaceLanguage`; text the host generates for the user to read
 * (gene summaries, guard titles, generation lines, announcements) follows it.
 * Unset means Chinese, the language the app shipped with.
 */
export const INTERFACE_LANGUAGES = ['zh', 'en'];
export const interfaceLanguageOf = state => (state?.settings?.interfaceLanguage === 'en' ? 'en' : 'zh');
export const LANGUAGE_NAMES = { zh: 'Simplified Chinese', en: 'English' };
/** Pick the variant for a language: inLanguage('en', { zh: '…', en: '…' }). */
export const inLanguage = (language, variants) => variants[language] ?? variants.zh;
