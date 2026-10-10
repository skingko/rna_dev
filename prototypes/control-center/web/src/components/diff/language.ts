/** Which syntax colour a changed file's diff gets: the file preview's rules, by name. */
import { previewSpec } from '@/components/preview/registry'
import { normalizeLang } from '@/lib/highlight'

/** The Shiki language for a file's diff (`undefined` for plain text and for names that say nothing). */
export function diffLanguage(path: string | null | undefined): string | undefined {
  if (!path) return undefined
  return normalizeLang(previewSpec(path).lang) ?? undefined
}
