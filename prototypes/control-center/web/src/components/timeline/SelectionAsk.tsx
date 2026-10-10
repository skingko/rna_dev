/**
 * Text-selection popover on assistant messages in the main timeline:
 * "在辅助对话中提问" opens a new 辅助对话 in the side panel seeded with the
 * selection (plus 复制). Appears after a mouse or keyboard selection inside
 * one `[data-assistant-item]`, hides on scroll, Escape or collapse.
 */
import { useEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Copy, MessagesSquare } from 'lucide-react'
import { useApp } from '@/store/app-store'
import { toast } from '@/store/ui-store'
import { selectionSeed } from '@/lib/side-session'
import { openSideChat } from '@/components/side-panel/open'
import { useT } from '@/i18n'

interface Anchor { text: string; itemId: string; x: number; y: number; below: boolean }

/** The selection when it lies within a single assistant message inside `root`. */
export function readSelection(root: HTMLElement | null): Omit<Anchor, 'x' | 'y' | 'below'> & { rect: DOMRect } | null {
  const selection = typeof window === 'undefined' ? null : window.getSelection()
  if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  const start = (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement)?.closest<HTMLElement>('[data-assistant-item]')
  const end = (range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement)?.closest<HTMLElement>('[data-assistant-item]')
  if (!start || start !== end || !root.contains(start)) return null
  const text = selectionSeed(selection.toString())
  if (!text) return null
  return { text, itemId: start.dataset.assistantItem!, rect: range.getBoundingClientRect() }
}

export function SelectionAsk({ sessionId, scrollRef }: { sessionId: string; scrollRef: RefObject<HTMLDivElement | null> }) {
  const t = useT()
  const enabled = useApp(s => Boolean(s.capabilities?.sideChat))
  const [anchor, setAnchor] = useState<Anchor | null>(null)

  useEffect(() => {
    const root = scrollRef.current
    if (!enabled || !root) return
    const update = () => {
      const found = readSelection(root)
      if (!found) { setAnchor(null); return }
      const { rect } = found
      const below = rect.top < 72
      setAnchor({ text: found.text, itemId: found.itemId, x: Math.min(window.innerWidth - 120, Math.max(120, rect.left + rect.width / 2)), y: below ? rect.bottom + 8 : rect.top - 8, below })
    }
    const onUp = () => requestAnimationFrame(update)
    const onKeyUp = (e: KeyboardEvent) => { if (e.shiftKey || e.key === 'Shift') update() }
    const onSelectionChange = () => { if (window.getSelection()?.isCollapsed) setAnchor(null) }
    const hide = () => setAnchor(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAnchor(null) }
    root.addEventListener('mouseup', onUp)
    root.addEventListener('keyup', onKeyUp)
    root.addEventListener('scroll', hide, { passive: true })
    document.addEventListener('selectionchange', onSelectionChange)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', hide)
    return () => {
      root.removeEventListener('mouseup', onUp)
      root.removeEventListener('keyup', onKeyUp)
      root.removeEventListener('scroll', hide)
      document.removeEventListener('selectionchange', onSelectionChange)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', hide)
    }
  }, [enabled, scrollRef])

  // A new conversation drops the popover.
  useEffect(() => { setAnchor(null) }, [sessionId])

  const ask = () => {
    if (!anchor) return
    openSideChat(sessionId, { text: anchor.text, itemId: anchor.itemId })
    window.getSelection()?.removeAllRanges()
    setAnchor(null)
  }
  const copy = () => {
    if (!anchor) return
    void navigator.clipboard?.writeText(anchor.text).then(() => toast(t('已复制')), () => {})
    setAnchor(null)
  }

  return createPortal(
    <AnimatePresence>
      {anchor && (
        <motion.div
          key="selection-ask"
          role="toolbar"
          aria-label={t('所选内容')}
          data-selection-ask
          initial={{ opacity: 0, y: anchor.below ? -4 : 4, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.1 } }}
          transition={{ type: 'spring', stiffness: 560, damping: 38 }}
          onMouseDown={e => e.preventDefault()}
          style={{ left: anchor.x, top: anchor.y, translateX: '-50%', translateY: anchor.below ? 0 : '-100%' }}
          className="fixed z-50 flex items-center gap-0.5 rounded-lg bg-elevated p-1 shadow-lg"
        >
          <button type="button" onClick={ask} className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium text-fg transition-colors hover:bg-hover">
            <MessagesSquare className="size-3.5 text-accent-text" />{t('在辅助对话中提问')}
          </button>
          <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
          <button type="button" onClick={copy} aria-label={t('复制')} className="grid size-7 place-items-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg"><Copy className="size-3.5" /></button>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
