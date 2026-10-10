/**
 * HTML (sandboxed static render + source), PDF (the browser's own viewer on a
 * typed blob URL), and the fallback cards for Office documents and other
 * binary files (metadata + download).
 */
import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, FileQuestion, FileText, Globe, Presentation } from 'lucide-react'
import { ModeSwitch, Notice, StateCard, Toolbar, ToolbarButton, DownloadButton } from '../parts'
import { useHostedView } from '../view-context'
import { openHtmlInBrowser } from '@/components/side-panel/open'
import { HTML_SANDBOX, sandboxedHtml } from '../html-sandbox'
import { extOf, fileName, formatBytes } from '../registry'
import { CodePreview } from './CodePreview'
import { t as tr, localized } from '@/i18n'

export function HtmlPreview({ text, projectId, path }: { text: string; projectId?: string; path?: string }) {
  const hosted = useHostedView()
  const [localMode, setMode] = useState<'preview' | 'source'>('preview')
  const mode = hosted ?? localMode
  const doc = useMemo(() => sandboxedHtml(text), [text])
  const [opening, setOpening] = useState(false)
  const openBrowser = projectId && path ? async () => {
    setOpening(true)
    try { await openHtmlInBrowser(projectId, path) } finally { setOpening(false) }
  } : null
  return (
    <>
      <Toolbar>
        {openBrowser && <ToolbarButton label={tr('在浏览器中打开')} disabled={opening} onClick={() => void openBrowser()}><Globe /></ToolbarButton>}
        {!hosted && <ModeSwitch label={tr('HTML 显示方式')} value={mode} onChange={setMode} items={[{ id: 'preview', label: tr('预览') }, { id: 'source', label: tr('源码') }]} />}
      </Toolbar>
      {mode === 'source' ? <CodePreview text={text} lang="html" /> : (
        <>
          <Notice tone="muted">{tr('静态预览：脚本、表单与网络请求均已禁用。需要交互时请在文件页使用「运行预览」。')}</Notice>
          <iframe title={tr('HTML 静态预览')} srcDoc={doc} sandbox={HTML_SANDBOX} referrerPolicy="no-referrer" className="min-h-0 w-full flex-1 border-0 bg-white" />
        </>
      )}
    </>
  )
}

export function PdfPreview({ blob, name }: { blob: Blob; name: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    // Force the type so the blob can only ever be handled by the PDF viewer.
    const next = URL.createObjectURL(blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' }))
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob])
  if (!url) return null
  return (
    <>
      <Toolbar>
        <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-fg-3 hover:bg-hover hover:text-fg"><ExternalLink className="size-3.5" />{tr('新窗口打开')}</a>
      </Toolbar>
      <iframe title={tr('PDF 预览：{name}', { name })} src={url} className="min-h-0 w-full flex-1 border-0 bg-inset" />
    </>
  )
}

const OFFICE_LABEL: Record<string, string> = localized({ docx: 'Word 文档', doc: 'Word 文档', odt: '文本文档', rtf: '富文本文档', pages: 'Pages 文稿', pptx: 'PowerPoint 演示文稿', ppt: 'PowerPoint 演示文稿', odp: '演示文稿', key: 'Keynote 演示文稿', ods: '电子表格', numbers: 'Numbers 表格' })

export function OfficeCard({ projectId, path, size }: { projectId: string; path: string; size?: number | null }) {
  const ext = extOf(path)
  const slides = ['pptx', 'ppt', 'odp', 'key'].includes(ext)
  return (
    <StateCard icon={slides ? <Presentation /> : <FileText />} title={fileName(path)}
      detail={<>{OFFICE_LABEL[ext] ?? ext.toUpperCase()}{size ? ` · ${formatBytes(size)}` : ''}<br />{tr('此格式暂不支持在工作台内预览，请下载后用本机应用打开。')}</>}>
      <DownloadButton projectId={projectId} path={path} variant="button" />
    </StateCard>
  )
}

export function BinaryCard({ projectId, path, size, type, reason }: { projectId: string; path: string; size?: number | null; type?: string; reason?: string }) {
  return (
    <StateCard icon={<FileQuestion />} title={fileName(path)}
      detail={<>{[type || (extOf(path) ? extOf(path).toUpperCase() : tr('未知类型')), size ? formatBytes(size) : ''].filter(Boolean).join(' · ')}<br />{reason ?? tr('这是二进制文件，无法以文本预览。')}</>}>
      <DownloadButton projectId={projectId} path={path} variant="button" />
    </StateCard>
  )
}
