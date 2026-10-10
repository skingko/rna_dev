/**
 * Streaming-friendly Markdown. The text is split into top-level blocks with
 * marked's lexer; each block renders through a memoized react-markdown, so a
 * delta only re-parses the growing tail block. While streaming, remend closes
 * unterminated emphasis/code so partial Markdown never flickers raw syntax.
 */
import { isValidElement, memo, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import remend from 'remend'
import { Lexer } from 'marked'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'
import { cachedTokens, highlight, normalizeLang, type Token } from '@/lib/highlight'
import { t as tr } from '@/i18n'

export function splitBlocks(text: string): string[] {
  try {
    return Lexer.lex(text, { gfm: true }).map(token => token.raw).filter(raw => raw.trim() !== '')
  } catch {
    return [text]
  }
}

export const Markdown = memo(function Markdown({ text, streaming = false, variant = 'body', className, overrides }: {
  text: string; streaming?: boolean; variant?: 'body' | 'compact' | 'document'; className?: string
  /** Element renderers merged over the defaults (file preview: workspace-relative images and links). Keep the object stable. */
  overrides?: Components
}) {
  const source = useMemo(() => (streaming ? safeRemend(text) : text), [text, streaming])
  const blocks = useMemo(() => splitBlocks(source), [source])
  const merged = useMemo(() => (overrides ? { live: { ...liveComponents, ...overrides }, static: { ...staticComponents, ...overrides } } : null), [overrides])
  return (
    <div className={cn('md', variant === 'compact' && 'md-compact', variant === 'document' && 'md-doc', className)}>
      {blocks.map((raw, i) => (
        <Block key={i} raw={raw} live={streaming && i === blocks.length - 1} breaks={variant === 'compact'} components={merged ? (streaming && i === blocks.length - 1 ? merged.live : merged.static) : undefined} />
      ))}
    </div>
  )
})

function safeRemend(text: string) {
  try { return remend(text) } catch { return text }
}

const GFM = [remarkGfm]
const GFM_BREAKS = [remarkGfm, remarkBreaks]

const Block = memo(function Block({ raw, live, breaks, components: custom }: { raw: string; live: boolean; breaks: boolean; components?: Components }) {
  const components = custom ?? (live ? liveComponents : staticComponents)
  // Reasoning text treats single newlines as line breaks.
  return <ReactMarkdown remarkPlugins={breaks ? GFM_BREAKS : GFM} components={components}>{raw}</ReactMarkdown>
})

function makeComponents(live: boolean): Components {
  return {
    a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
    // Fenced/indented code always arrives as <pre><code>; inline code is a bare <code>.
    pre: ({ children }) => {
      const child = (Array.isArray(children) ? children[0] : children) as ReactElement<{ className?: string; children?: ReactNode }> | undefined
      const className = child && isValidElement(child) ? child.props.className ?? '' : ''
      const code = child && isValidElement(child) ? String(child.props.children ?? '').replace(/\n$/, '') : ''
      const match = /language-([\w+-]+)/.exec(className)
      return <CodeBlock code={code} lang={match?.[1] ?? ''} live={live} />
    },
  }
}
const liveComponents = makeComponents(true)
const staticComponents = makeComponents(false)

export function CodeBlock({ code, lang, live, header = true }: { code: string; lang: string; live?: boolean; header?: boolean }) {
  const normalized = normalizeLang(lang)
  const [tokens, setTokens] = useState<Token[][] | undefined>(() => (normalized ? cachedTokens(code, normalized) : undefined))
  useEffect(() => {
    if (live || !normalized) return
    let cancelled = false
    const hit = cachedTokens(code, normalized)
    if (hit) { setTokens(hit); return }
    // Highlight after paint so it never blocks streaming frames.
    const id = requestIdleCallbackSafe(() => {
      void highlight(code, normalized).then(result => { if (!cancelled && result) setTokens(result) })
    })
    return () => { cancelled = true; cancelIdleCallbackSafe(id) }
  }, [code, normalized, live])

  return (
    <div className="code-card">
      {header && (
        <div className="code-card-head">
          <span className="font-mono text-[11.5px] lowercase">{lang || 'text'}</span>
          <CopyButton text={code} />
        </div>
      )}
      <pre>
        <code>
          {tokens && !live
            ? tokens.map((line, i) => (
                <span key={i} className="block min-h-[1lh]">
                  {line.map((t, j) => <span key={j} className="shiki-token" style={t.style}>{t.content}</span>)}
                </span>
              ))
            : code}
        </code>
      </pre>
    </div>
  )
}

export function CopyButton({ text, label = tr('复制'), className }: { text: string; label?: ReactNode; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      onClick={e => {
        e.stopPropagation()
        void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1400) })
      }}
      className={cn('inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] text-fg-3 transition-colors hover:bg-hover hover:text-fg', className)}
    >
      {done ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      <span>{done ? tr('已复制') : label}</span>
    </button>
  )
}

type IdleHandle = number
function requestIdleCallbackSafe(fn: () => void): IdleHandle {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }
  return w.requestIdleCallback ? w.requestIdleCallback(fn, { timeout: 400 }) : window.setTimeout(fn, 32)
}
function cancelIdleCallbackSafe(id: IdleHandle) {
  const w = window as Window & { cancelIdleCallback?: (id: number) => void }
  if (w.cancelIdleCallback) w.cancelIdleCallback(id)
  else clearTimeout(id)
}
