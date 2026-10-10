/**
 * Images from workspace bytes (blob URL; SVG renders as <img>, so its scripts
 * never run). Fit / 1:1 / step zoom, Ctrl/⌘ + wheel zoom around the pointer,
 * drag to pan, keyboard + - 0 1 on the focused canvas.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent } from 'react'
import { Maximize, Minus, Plus } from 'lucide-react'
import { ImageOff } from 'lucide-react'
import { StateCard, Toolbar, ToolbarButton } from '../parts'
import { t as tr } from '@/i18n'

export const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8]
/** Next zoom step up/down from the current scale. */
export function stepZoom(scale: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find(s => s > scale + 1e-6) ?? ZOOM_STEPS.at(-1)!
  return [...ZOOM_STEPS].reverse().find(s => s < scale - 1e-6) ?? ZOOM_STEPS[0]
}

export function ImagePreview({ blob, name }: { blob: Blob; name: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [failed, setFailed] = useState(false)
  const [zoom, setZoom] = useState<'fit' | number>('fit')
  const [fitScale, setFitScale] = useState(1)
  const box = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null)

  useEffect(() => {
    // SVG bytes may arrive as octet-stream from older hosts; give <img> the right type.
    const typed = /\.svg$/i.test(name) && blob.type !== 'image/svg+xml' ? new Blob([blob], { type: 'image/svg+xml' }) : blob
    const next = URL.createObjectURL(typed)
    setUrl(next); setNatural(null); setFailed(false); setZoom('fit')
    return () => URL.revokeObjectURL(next)
  }, [blob, name])

  useLayoutEffect(() => {
    const el = box.current
    if (!el || !natural) return
    const measure = () => setFitScale(Math.min(1, (el.clientWidth - 48) / natural.w, (el.clientHeight - 48) / natural.h))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [natural])

  const scale = zoom === 'fit' ? fitScale : zoom
  const setScale = (next: number, anchor?: { x: number; y: number }) => {
    const el = box.current
    const clamped = Math.min(ZOOM_STEPS.at(-1)!, Math.max(ZOOM_STEPS[0], next))
    if (el && anchor) {
      // Keep the point under the pointer stationary.
      const ratio = clamped / scale
      const ax = anchor.x + el.scrollLeft, ay = anchor.y + el.scrollTop
      requestAnimationFrame(() => { el.scrollLeft = ax * ratio - anchor.x; el.scrollTop = ay * ratio - anchor.y })
    }
    setZoom(clamped)
  }
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    setScale(scale * Math.exp(-e.deltaY / 300), { x: e.clientX - rect.left, y: e.clientY - rect.top })
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === '+' || e.key === '=') { e.preventDefault(); setScale(stepZoom(scale, 1)) }
    else if (e.key === '-') { e.preventDefault(); setScale(stepZoom(scale, -1)) }
    else if (e.key === '0') { e.preventDefault(); setZoom('fit') }
    else if (e.key === '1') { e.preventDefault(); setZoom(1) }
  }
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = box.current
    if (!el || (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)) return
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = box.current, d = drag.current
    if (!el || !d) return
    el.scrollLeft = d.left - (e.clientX - d.x); el.scrollTop = d.top - (e.clientY - d.y)
  }

  if (failed) return <StateCard tone="danger" icon={<ImageOff />} title={tr('图片无法显示')} detail={tr('文件可能已损坏，或不是浏览器支持的图片格式。')} />
  return (
    <>
      <Toolbar>
        <ToolbarButton label={tr('缩小')} onClick={() => setScale(stepZoom(scale, -1))} disabled={scale <= ZOOM_STEPS[0]}><Minus /></ToolbarButton>
        <button type="button" onClick={() => setZoom(zoom === 1 ? 'fit' : 1)} aria-label={tr('切换适应窗口与原始大小')} className="h-7 min-w-[48px] rounded-md px-1.5 text-[12px] tabular-nums text-fg-2 hover:bg-hover">{Math.round(scale * 100)}%</button>
        <ToolbarButton label={tr('放大')} onClick={() => setScale(stepZoom(scale, 1))} disabled={scale >= ZOOM_STEPS.at(-1)!}><Plus /></ToolbarButton>
        <ToolbarButton label={tr('适应窗口')} active={zoom === 'fit'} onClick={() => setZoom('fit')}><Maximize /></ToolbarButton>
      </Toolbar>
      <div ref={box} tabIndex={0} role="img" aria-label={tr('图片预览：{name}', { name })} onWheel={onWheel} onKeyDown={onKey}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}
        className="preview-checker relative min-h-0 flex-1 cursor-grab overflow-auto outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--line-focus)]">
        <div className="grid min-h-full min-w-full place-items-center p-6" style={natural ? { width: Math.max(natural.w * scale + 48, 0), height: Math.max(natural.h * scale + 48, 0) } : undefined}>
          {url && (
            <img src={url} alt={name} draggable={false} onError={() => setFailed(true)}
              onLoad={e => setNatural({ w: e.currentTarget.naturalWidth || 300, h: e.currentTarget.naturalHeight || 150 })}
              style={natural ? { width: natural.w * scale, height: natural.h * scale, maxWidth: 'none' } : { maxWidth: '100%' }}
              className="select-none rounded-sm shadow-[0_0_0_1px_var(--line-faint),var(--shadow-sm)]" />
          )}
        </div>
      </div>
      {natural && <p className="shrink-0 border-t border-line-faint px-4 py-1 text-[11.5px] tabular-nums text-fg-4">{natural.w} × {natural.h} px</p>}
    </>
  )
}
