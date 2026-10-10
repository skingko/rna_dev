/**
 * The single per-file view switch of the 审查 tab: 预览 / 源码 / 差异.
 * 预览 only for types that render differently from their source, 源码 for
 * anything readable as text, 差异 only when the session changed the file.
 * Default: 预览 for new rendered documents (Markdown, HTML, tables…); 差异 for
 * new code (it has no rendered form) and for every modified file.
 */
import { previewSpec } from '@/components/preview/registry'

export type ReviewMode = 'preview' | 'source' | 'diff'

/** Kinds whose rendering differs from the raw text (Markdown, HTML, JSON tree, tables, images, PDF, sheets). */
const RENDERED = new Set(['markdown', 'html', 'json', 'table', 'excel', 'image', 'pdf'])

export function reviewModes(input: { path: string | null; hasChange: boolean; created?: boolean }): { modes: ReviewMode[]; fallback: ReviewMode } {
  const modes: ReviewMode[] = []
  const spec = input.path ? previewSpec(input.path) : null
  if (spec && RENDERED.has(spec.kind)) modes.push('preview')
  if (spec && spec.load === 'text') modes.push('source')
  if (input.hasChange) modes.push('diff')
  const fallback: ReviewMode = input.created && modes.includes('preview') ? 'preview'
    : input.hasChange ? 'diff'
      : modes[0] ?? 'diff'
  return { modes: modes.length ? modes : ['diff'], fallback }
}

/** The mode to show: the explicit choice when still offered, else the default. */
export function resolveReviewMode(choice: ReviewMode | undefined, available: { modes: ReviewMode[]; fallback: ReviewMode }): ReviewMode {
  return choice && available.modes.includes(choice) ? choice : available.fallback
}
