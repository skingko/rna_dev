/**
 * Markdown documents through the shared Markdown pipeline (GFM tables, task
 * lists, Shiki code blocks) in a document measure. Relative images load from
 * the workspace (blob URLs); relative links open the target file in the
 * preview dock. Long documents render in block chunks as the reader scrolls.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Components } from 'react-markdown'
import { Markdown, splitBlocks } from '@/components/markdown/Markdown'
import { ModeSwitch, Toolbar } from '../parts'
import { DocumentLink, MarkdownImage } from '../WorkspaceMedia'
import { CodePreview } from './CodePreview'
import { useHostedView } from '../view-context'
import { t as tr } from '@/i18n'

const CHUNK = 60

export function MarkdownPreview({ projectId, path, text }: { projectId: string; path: string; text: string }) {
  const hosted = useHostedView()
  const [localMode, setMode] = useState<'preview' | 'source'>('preview')
  const mode = hosted ?? localMode
  const blocks = useMemo(() => splitBlocks(text), [text])
  const [shown, setShown] = useState(CHUNK)
  const sentinel = useRef<HTMLDivElement>(null)
  useEffect(() => { setShown(CHUNK) }, [text])
  useEffect(() => {
    const node = sentinel.current
    if (!node || shown >= blocks.length || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) setShown(n => n + CHUNK) }, { rootMargin: '800px 0px' })
    io.observe(node)
    return () => io.disconnect()
  }, [shown, blocks.length, mode])
  const visible = useMemo(() => visiblePrefix(text, blocks, shown), [blocks, shown, text])
  const overrides = useMemo<Components>(() => ({
    img: ({ src, alt }) => <MarkdownImage projectId={projectId} documentPath={path} src={typeof src === 'string' ? src : ''} alt={alt ?? ''} />,
    a: ({ href, children }) => <DocumentLink projectId={projectId} documentPath={path} href={href ?? ''}>{children}</DocumentLink>,
    table: ({ children }) => <div className="md-table-wrap"><table>{children}</table></div>,
  }), [projectId, path])

  return (
    <>
      {!hosted && (
        <Toolbar>
          <ModeSwitch label={tr('Markdown 显示方式')} value={mode} onChange={setMode} items={[{ id: 'preview', label: tr('预览') }, { id: 'source', label: tr('源码') }]} />
        </Toolbar>
      )}
      {mode === 'source' ? <CodePreview text={text} lang="markdown" defaultWrap /> : (
        <div className="min-h-0 flex-1 overflow-auto" tabIndex={0} role="region" aria-label={tr('Markdown 阅读')}>
          <article className="mx-auto w-full max-w-[780px] px-7 pb-16 pt-7 max-sm:px-4">
            <Markdown text={visible} variant="document" overrides={overrides} />
            {shown < blocks.length && (
              <div ref={sentinel} className="mt-6 flex justify-center">
                <button type="button" onClick={() => setShown(n => n + CHUNK)} className="h-7 rounded-md px-3 text-[12.5px] text-fg-3 hover:bg-hover hover:text-fg">{tr('继续加载（剩余 {count} 段）', { count: blocks.length - shown })}</button>
              </div>
            )}
          </article>
        </div>
      )}
    </>
  )
}

/** The first `shown` blocks as Markdown. Block tokens carry no trailing blank
 * line (whitespace tokens are dropped), so they are rejoined with one: joining
 * them bare merges a heading and every following paragraph into one line. */
export function visiblePrefix(text: string, blocks: string[], shown: number) {
  return shown >= blocks.length ? text : blocks.slice(0, shown).map(block => block.replace(/\n+$/, '')).join('\n\n')
}
