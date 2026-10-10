/**
 * 终端 tab (lazy chunk with xterm.js). One host terminal per tab: created
 * with the measured size, streamed over SSE (`data {seq, b64}` / `exit`),
 * input and resize posted back. Reconnects resume after the last seen `seq`
 * (the host replays its scrollback), so a remount or a dropped connection
 * never loses output. A tab hidden for 30 s closes its stream (connection
 * budget) and resumes the same way when shown again. Enabled only when the project may run commands
 * (permission 读写并执行命令) and with `capabilities.terminal`.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { ClipboardPaste, Copy, Eraser, Loader2, RotateCcw, ShieldAlert, SquareTerminal } from 'lucide-react'
import { getTransport } from '@/api/client'
import { decodeB64, encodeB64, isUnsupported, terminalApi, type TerminalExitEvent, type TerminalHello, type TerminalInfo } from '@/api/side-panel-api'
import { ApiError } from '@/api/transport'
import type { EventSourceLike } from '@/api/transport'
import { useApp, useProject } from '@/store/app-store'
import { updateTab, type SideTabData } from '@/store/side-panel-store'
import { toast } from '@/store/ui-store'
import { openPermissionsForTerminal } from '@/components/projects/PermissionsDialog'
import { typingElsewhere, useStreamWhileVisible } from '@/components/workspace/visibility'
import { Button, IconButton } from '@/components/ui/primitives'
import { prettyPath } from '@/lib/format'
import { cn } from '@/lib/utils'
import { t as tr, useT } from '@/i18n'

type TerminalTabData = Extract<SideTabData, { type: 'terminal' }>

export default function TerminalTab({ tab, active }: { tab: TerminalTabData; active: boolean }) {
  const t = useT()
  const project = useProject(tab.projectId)
  const capability = useApp(s => s.capabilities?.terminal)
  if (!capability) {
    return <Gate icon={<SquareTerminal />} title={t('终端暂不可用')} detail={t('当前的 Rna 服务没有提供终端能力。更新 Rna 后即可在侧边面板中运行命令。')} />
  }
  if (project?.permissions?.workspace !== 'execute') {
    return (
      <Gate icon={<ShieldAlert />} tone="warning" title={t('终端需要「读写并执行命令」权限')} detail={t('终端以当前用户身份在项目目录中运行命令。把项目的对话执行权限改为「读写并执行命令」后即可使用。')}>
        <Button size="sm" variant="secondary" onClick={() => openPermissionsForTerminal(tab.projectId)}>{t('更改项目权限…')}</Button>
      </Gate>
    )
  }
  return <TerminalSession key={tab.terminalId ?? 'new'} tab={tab} active={active} cwdFallback={project.workspacePath ?? null} />
}

function Gate({ icon, title, detail, tone, children }: { icon: React.ReactNode; title: string; detail: string; tone?: 'warning'; children?: React.ReactNode }) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center p-6">
      <div className="flex max-w-[340px] flex-col items-center gap-2 text-center">
        <span className={cn('grid size-10 place-items-center rounded-xl bg-subtle text-fg-3 [&_svg]:size-5', tone === 'warning' && 'bg-warning-soft text-warning-text')}>{icon}</span>
        <p className="text-[13.5px] font-medium text-fg">{title}</p>
        <p className="text-[12.5px] leading-relaxed text-fg-3">{detail}</p>
        {children && <div className="mt-2">{children}</div>}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ theme */

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

function terminalTheme(): ITheme {
  const dark = document.documentElement.classList.contains('dark')
  return {
    background: css('--bg-inset') || (dark ? '#1c1c1c' : '#f6f7f9'),
    foreground: css('--text-primary') || (dark ? '#e6e6e6' : '#1b2130'),
    cursor: css('--accent') || '#4f63d8',
    cursorAccent: css('--bg-inset') || '#ffffff',
    selectionBackground: dark ? 'rgba(140, 160, 255, 0.28)' : 'rgba(79, 99, 216, 0.18)',
    ...(dark ? {
      black: '#3a3a3a', red: '#f07178', green: '#9ccf7a', yellow: '#e6c07b', blue: '#82aaff', magenta: '#c792ea', cyan: '#89ddff', white: '#d0d0d0',
      brightBlack: '#6b6b6b', brightRed: '#ff8b92', brightGreen: '#b4e08f', brightYellow: '#f5d38f', brightBlue: '#a0bfff', brightMagenta: '#dcb0f5', brightCyan: '#a6e8ff', brightWhite: '#ffffff',
    } : {
      black: '#1b2130', red: '#c2362b', green: '#17784b', yellow: '#9a6412', blue: '#3f51bf', magenta: '#8b3fb3', cyan: '#12788a', white: '#9aa3b2',
      brightBlack: '#6b7385', brightRed: '#d0453a', brightGreen: '#1f9d63', brightYellow: '#b7791f', brightBlue: '#4f63d8', brightMagenta: '#a651d1', brightCyan: '#1592a8', brightWhite: '#c9ced8',
    }),
  }
}

/* ---------------------------------------------------------- session */

type Status = 'connecting' | 'live' | 'reconnecting' | 'exited' | 'gone' | 'error'

/** One create per tab across StrictMode double-mounts. */
const creating = new Map<string, Promise<TerminalInfo>>()

function TerminalSession({ tab, active, cwdFallback }: { tab: TerminalTabData; active: boolean; cwdFallback: string | null }) {
  const t = useT()
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const [status, setStatus] = useState<Status>('connecting')
  const [info, setInfo] = useState<TerminalInfo | null>(tab.terminalId ? { id: tab.terminalId, title: tab.title } : null)
  const [exit, setExit] = useState<TerminalExitEvent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  // A failed create leaves terminalId null, so 新建终端 cannot restart it by clearing the id: it counts attempts.
  const [attempt, setAttempt] = useState(0)
  const terminalId = tab.terminalId ?? null
  // Connection budget (design 1.8): the stream stays open while shown and a while after.
  const streaming = useStreamWhileVisible(active)
  /** Where the stream stopped, kept across pauses: resuming replays only what came after. */
  const position = useRef<{ id: string | null; lastSeq: number; exited: boolean }>({ id: null, lastSeq: 0, exited: false })

  /* xterm instance: one per mounted session */
  useEffect(() => {
    const el = host.current
    if (!el) return
    const instance = new Terminal({
      fontFamily: css('--font-mono') || 'ui-monospace, Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      macOptionIsMeta: true,
      theme: terminalTheme(),
    })
    const addon = new FitAddon()
    instance.loadAddon(addon)
    instance.open(el)
    try { addon.fit() } catch { /* hidden */ }
    // Ctrl+Shift+C / Ctrl+Shift+V (Linux/Windows habit); ⌘C copies a selection on macOS; ⌘K clears the screen as in
    // Terminal.app (the app's ⌘K search yields while the terminal has focus). Ctrl+K stays the shell's kill-line.
    instance.attachCustomKeyEventHandler(ev => {
      if (ev.type !== 'keydown') return true
      const key = ev.key.toLowerCase()
      if (ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey && key === 'k') { instance.clear(); return false }
      if ((ev.ctrlKey && ev.shiftKey && key === 'c') || (ev.metaKey && key === 'c' && instance.hasSelection())) {
        void navigator.clipboard?.writeText(instance.getSelection()).catch(() => {})
        return false
      }
      if (ev.ctrlKey && ev.shiftKey && key === 'v') { void pasteInto(instance); return false }
      return true
    })
    term.current = instance
    fit.current = addon
    const themeObserver = new MutationObserver(() => { instance.options.theme = terminalTheme() })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => { themeObserver.disconnect(); instance.dispose(); term.current = null; fit.current = null }
  }, [])

  /* create the host terminal once we know our size */
  useEffect(() => {
    if (terminalId) return
    const instance = term.current
    const size = { cols: instance?.cols ?? 80, rows: instance?.rows ?? 24 }
    let pending = creating.get(tab.id)
    if (!pending) {
      pending = terminalApi.create(tab.projectId, size, tab.sessionId)
      creating.set(tab.id, pending)
      pending.finally(() => creating.delete(tab.id)).catch(() => {})
    }
    let live = true
    pending.then(created => {
      if (!live) return
      updateTab(tab.id, { terminalId: created.id, title: created.title ?? null })
    }).catch(e => {
      if (!live) return
      setStatus('error')
      const code = e instanceof ApiError ? e.code : undefined
      setErrorCode(code ?? null)
      setError(code === 'TERMINAL_PERMISSION_DENIED' ? tr('终端需要「读写并执行命令」权限')
        : code === 'TERMINAL_LIMIT' || code === 'TERMINAL_RATE_LIMITED' ? tr('终端数量已达上限，请先关闭不用的终端。')
          : isUnsupported(e) && !code ? tr('当前的 Rna 服务没有提供终端能力。更新 Rna 后即可在侧边面板中运行命令。') : (e as Error).message)
    })
    return () => { live = false }
  }, [terminalId, tab.id, tab.projectId, attempt])

  /* stream + input + resize; hidden for a while, the stream closes and later resumes after the last seen `seq` */
  useEffect(() => {
    const instance = term.current
    if (!terminalId || !instance) return
    if (position.current.id !== terminalId) position.current = { id: terminalId, lastSeq: 0, exited: false }
    const seen = position.current
    if (!streaming || seen.exited) return
    let source: EventSourceLike | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let attempts = 0
    let closed = false
    let exitWritten = false
    /** `fallback` terminals (script(1)) cannot be resized: fit locally, never post sizes. */
    let noResize = false
    let inputChain: Promise<unknown> = Promise.resolve()

    const connect = () => {
      if (closed) return
      source?.close()
      const next = getTransport().openStream(terminalApi.streamPath(terminalId, seen.lastSeq))
      source = next
      next.onopen = () => { attempts = 0; setStatus('live') }
      next.onerror = () => {
        if (closed || seen.exited) return
        if (next.readyState === 2) scheduleReconnect()
        else setStatus('reconnecting')
      }
      next.addEventListener('hello', ev => {
        attempts = 0
        setStatus('live')
        try {
          const hello = JSON.parse(ev.data) as Partial<TerminalHello>
          // `reset`: our position fell out of the host buffer; it replays everything, so start clean.
          if (hello?.replay === 'reset') { instance.reset(); seen.lastSeq = 0 }
          if (hello?.capability === 'fallback') noResize = true
          if (hello && (hello.title || hello.cwd || hello.shell || hello.capability)) {
            setInfo(prev => ({ ...(prev ?? { id: terminalId }), ...hello, id: terminalId }))
            if (hello.title) updateTab(tab.id, { title: hello.title })
          }
        } catch { /* hello without body */ }
      })
      next.addEventListener('data', ev => {
        try {
          const data = JSON.parse(ev.data) as { seq: number; b64: string }
          if (typeof data.seq === 'number' && data.seq <= seen.lastSeq) return // replay overlap
          if (typeof data.seq === 'number') seen.lastSeq = data.seq
          instance.write(decodeB64(data.b64))
        } catch { /* malformed frame */ }
      })
      next.addEventListener('exit', ev => {
        seen.exited = true
        let payload: TerminalExitEvent = {}
        try { payload = JSON.parse(ev.data) as TerminalExitEvent } catch { /* no body */ }
        setExit(payload)
        setStatus('exited')
        if (!exitWritten) instance.write(`\r\n\x1b[2m${tr('[进程已退出{detail}]', { detail: payload.code !== undefined && payload.code !== null ? ` · ${payload.code}` : payload.signal ? ` · ${payload.signal}` : '' })}\x1b[0m\r\n`)
        exitWritten = true
        next.close()
      })
    }
    const scheduleReconnect = async () => {
      if (closed || seen.exited || retry) return
      setStatus('reconnecting')
      attempts++
      // After a few failures, check the terminal still exists before retrying forever.
      if (attempts >= 3) {
        try {
          const current = await terminalApi.get(terminalId)
          if (current.status === 'exited' || current.exited) { seen.exited = true; setExit(current.exit ?? {}); setStatus('exited'); return }
        } catch (e) {
          if (e instanceof ApiError && e.status === 404) { setStatus('gone'); return }
        }
      }
      retry = setTimeout(() => { retry = null; connect() }, Math.min(10_000, 500 * 2 ** Math.min(attempts, 5)))
    }

    connect()
    const onData = instance.onData(data => {
      if (seen.exited) return
      const b64 = encodeB64(data)
      inputChain = inputChain.then(() => terminalApi.input(terminalId, b64)).catch(() => { /* the stream reports loss */ })
    })

    // Fit on container resize; tell the host the new grid (debounced).
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    let sent = { cols: instance.cols, rows: instance.rows }
    const refit = () => {
      const el = host.current
      if (!el || el.clientWidth === 0 || el.clientHeight === 0) return
      try { fit.current?.fit() } catch { return }
      if (instance.cols === sent.cols && instance.rows === sent.rows) return
      if (resizeTimer) clearTimeout(resizeTimer)
      if (noResize) return
      resizeTimer = setTimeout(() => {
        sent = { cols: instance.cols, rows: instance.rows }
        void terminalApi.resize(terminalId, sent).then(r => { if (r?.resized === false) noResize = true }).catch(() => {})
      }, 120)
    }
    const observer = new ResizeObserver(() => requestAnimationFrame(refit))
    if (host.current) observer.observe(host.current)
    refit()
    void terminalApi.resize(terminalId, { cols: instance.cols, rows: instance.rows }).then(r => { if (r?.resized === false) noResize = true }).catch(() => {})

    return () => {
      closed = true
      source?.close()
      if (retry) clearTimeout(retry)
      if (resizeTimer) clearTimeout(resizeTimer)
      observer.disconnect()
      onData.dispose()
    }
  }, [terminalId, tab.id, tab.projectId, streaming])

  // Focus + refit when the tab becomes visible; never taking the keyboard from someone typing elsewhere.
  useEffect(() => {
    if (!active) return
    const frame = requestAnimationFrame(() => {
      try { fit.current?.fit() } catch { /* hidden */ }
      if (!typingElsewhere(host.current)) term.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [active])

  const copy = () => {
    const text = term.current?.getSelection() ?? ''
    if (!text) { toast(t('先在终端中选中要复制的文字')); return }
    void navigator.clipboard?.writeText(text).then(() => toast(t('已复制')), () => toast(t('无法访问剪贴板'), 'danger'))
  }
  const restart = useCallback(() => {
    if (terminalId) void terminalApi.remove(terminalId).catch(() => {})
    setExit(null); setError(null); setErrorCode(null); setStatus('connecting')
    term.current?.reset()
    if (terminalId) updateTab(tab.id, { terminalId: null, title: null })
    else setAttempt(n => n + 1)
  }, [terminalId, tab.id])

  const title = info?.title || tab.title || t('终端')
  const cwd = info?.cwd ?? cwdFallback
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-inset" data-terminal-status={status}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line-faint bg-base pl-3 pr-1.5">
        <StatusLight status={status} />
        <span className="min-w-0 truncate text-[12.5px] font-medium text-fg" title={title}>{title}</span>
        {cwd && <span className="hidden min-w-0 truncate font-mono text-[11.5px] text-fg-4 sm:inline" title={cwd}>{prettyPath(cwd)}</span>}
        {info?.capability === 'fallback' && <span className="shrink-0 rounded bg-subtle px-1.5 py-px text-[10.5px] text-fg-3" title={t('没有伪终端：不支持全屏程序与作业控制。')}>{t('兼容模式')}</span>}
        <span className="flex-1" />
        {status === 'reconnecting' && <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-fg-4"><Loader2 className="size-3 spin" />{t('正在重新连接…')}</span>}
        <IconButton label={t('复制')} onClick={copy}><Copy /></IconButton>
        <IconButton label={t('粘贴')} disabled={status !== 'live'} onClick={() => term.current && void pasteInto(term.current)}><ClipboardPaste /></IconButton>
        <IconButton label={t('清屏')} onClick={() => term.current?.clear()}><Eraser /></IconButton>
        <IconButton label={t('重新启动终端')} onClick={restart}><RotateCcw /></IconButton>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={host} className="absolute inset-0 px-2 pb-1 pt-2" data-terminal-host />
        {(status === 'exited' || status === 'gone' || status === 'error') && (
          <div className="absolute inset-x-3 bottom-3 flex items-center gap-2 rounded-lg bg-elevated px-3 py-2 text-[12.5px] shadow-md">
            <span className="min-w-0 flex-1 truncate text-fg-2">
              {status === 'exited' ? exitText(exit)
                : status === 'gone' ? t('终端会话已结束或服务已重启。') : error}
            </span>
            {(exit?.reason === 'permission' || errorCode === 'TERMINAL_PERMISSION_DENIED')
              ? <Button size="sm" variant="secondary" onClick={() => openPermissionsForTerminal(tab.projectId)}>{t('更改项目权限…')}</Button>
              : <Button size="sm" variant="secondary" leading={<RotateCcw className="size-3.5" />} onClick={restart}>{t('新建终端')}</Button>}
          </div>
        )}
      </div>
    </div>
  )
}

/** Why the terminal ended, in words (`exit.reason` from the host). */
function exitText(exit: TerminalExitEvent | null): string {
  switch (exit?.reason) {
    case 'permission': return tr('项目已不能执行命令（权限不是「读写并执行命令」），终端已关闭。')
    case 'idle': return tr('终端长时间未使用，已自动关闭。')
    case 'daemon_stopped': return tr('Rna 服务已停止，终端已关闭。')
    default: return tr('终端已退出{detail}', { detail: exit?.code !== undefined && exit?.code !== null ? tr('（退出码 {code}）', { code: exit.code }) : '' })
  }
}

async function pasteInto(instance: Terminal) {
  try {
    const text = await navigator.clipboard.readText()
    if (text) instance.paste(text)
  } catch { toast(tr('无法访问剪贴板'), 'danger') }
}

function StatusLight({ status }: { status: Status }) {
  const color = status === 'live' ? 'bg-success' : status === 'exited' || status === 'gone' || status === 'error' ? 'bg-idle' : 'bg-warning'
  return <span className={cn('size-1.5 shrink-0 rounded-full', color)} aria-hidden />
}
