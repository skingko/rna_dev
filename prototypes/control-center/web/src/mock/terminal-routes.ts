/**
 * S2 mock terminal service: a fake line-discipline shell per terminal that
 * echoes input, understands a handful of commands and keeps a replay buffer
 * so reconnects (`?lastEventId=`) resume like the real host.
 */
import { ApiError, type EventSourceLike } from '@/api/transport'
import { encodeB64 } from '@/api/side-panel-api'

type Listener = (ev: MessageEvent) => void

class FakeShell {
  seq = 0
  buffer: { seq: number; b64: string }[] = []
  line = ''
  exited = false
  sources = new Set<MockTerminalSource>()
  cols = 80
  rows = 24
  constructor(readonly id: string, readonly projectId: string, readonly cwd: string, readonly title: string) {
    this.emit(`\x1b[2mRna mock terminal · ${cwd}\x1b[0m\r\n\x1b[2mTry: help, ls, pwd, echo hi, npm run dev, exit\x1b[0m\r\n`) // i18n-ignore: terminal output
    this.emit(this.prompt())
  }
  prompt() { return `\x1b[1;32mrna\x1b[0m:\x1b[1;34m${this.short()}\x1b[0m$ ` }
  short() { return `~/${this.cwd.split('/').filter(Boolean).at(-1) ?? ''}` }
  info() { return { id: this.id, title: this.title, cwd: this.cwd, shell: '/bin/zsh', capability: 'pty', exited: this.exited } }

  emit(text: string) {
    const entry = { seq: ++this.seq, b64: encodeB64(text) }
    this.buffer.push(entry)
    if (this.buffer.length > 2000) this.buffer.shift()
    for (const source of this.sources) source.emit('data', entry)
  }

  input(data: string) {
    if (this.exited) return
    for (let i = 0; i < data.length; i++) {
      const ch = data[i]
      if (ch === '\x1b') { // skip escape sequences (arrows etc.)
        const m = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(data.slice(i))
        i += (m?.[0].length ?? 1) - 1
        continue
      }
      if (ch === '\r' || ch === '\n') { this.emit('\r\n'); this.run(this.line.trim()); this.line = ''; continue }
      if (ch === '\x7f' || ch === '\b') { if (this.line) { this.line = this.line.slice(0, -1); this.emit('\b \b') } continue }
      if (ch === '\x03') { this.line = ''; this.emit(`^C\r\n${this.prompt()}`); continue }
      if (ch === '\x0c') { this.emit(`\x1b[2J\x1b[H${this.prompt()}${this.line}`); continue }
      if (ch < ' ') continue
      this.line += ch
      this.emit(ch)
    }
  }

  run(cmd: string) {
    const [name, ...args] = cmd.split(/\s+/)
    const out = (text: string) => this.emit(text.replace(/\n/g, '\r\n'))
    switch (name) {
      case '': break
      case 'help': out('help  ls  pwd  echo  date  whoami  clear  npm run dev  exit\n'); break
      case 'ls': out('\x1b[1;34msrc\x1b[0m  \x1b[1;34mpublic\x1b[0m  index.html  package.json  README.md  vite.config.ts\n'); break
      case 'pwd': out(`${this.cwd}\n`); break
      case 'echo': out(`${args.join(' ')}\n`); break
      case 'date': out(`${new Date().toString()}\n`); break
      case 'whoami': out('apple\n'); break
      case 'clear': this.emit('\x1b[2J\x1b[H'); break
      case 'exit': this.exited = true; for (const source of this.sources) source.emit('exit', { code: 0, signal: null }); return
      case 'npm':
        if (args.join(' ') === 'run dev') {
          out('\n> ink-bird@0.1.0 dev\n> vite\n\n  \x1b[32mVITE v8.3.1\x1b[0m  ready in 312 ms\n\n  ➜  Local:   \x1b[36mhttp://localhost:5173/\x1b[0m\n  ➜  press \x1b[1mh + enter\x1b[0m to show help\n')
          break
        }
        out(`npm: unknown command ${args.join(' ')}\n`); break
      default: out(`zsh: command not found: ${name}\n`)
    }
    this.emit(this.prompt())
  }
}

export class MockTerminalSource implements EventSourceLike {
  readyState = 0
  onopen: ((ev: Event) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  private listeners = new Map<string, Set<Listener>>()
  constructor(private store: TerminalStore, path: string) {
    const url = new URL(path, 'http://mock')
    const id = decodeURIComponent(url.pathname.split('/')[4] ?? '')
    const since = Number(url.searchParams.get('lastEventId')) || 0
    setTimeout(() => {
      if (this.readyState === 2) return
      const shell = store.shells.get(id)
      if (!shell) { this.readyState = 2; this.onerror?.(new Event('error')); return }
      this.readyState = 1
      this.onopen?.(new Event('open'))
      this.emit('hello', { ...shell.info(), replay: since ? 'partial' : 'full' })
      for (const entry of shell.buffer) if (entry.seq > since) this.emit('data', entry)
      if (shell.exited) { this.emit('exit', { code: 0, signal: null }); return }
      shell.sources.add(this)
    }, 40)
  }
  addEventListener(type: string, listener: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }
  close() {
    this.readyState = 2
    for (const shell of this.store.shells.values()) shell.sources.delete(this)
  }
  emit(type: string, data: { seq?: number } | object) {
    if (this.readyState !== 1) return
    const seq = (data as { seq?: number }).seq
    const ev = new MessageEvent(type, { data: JSON.stringify(data), lastEventId: seq ? String(seq) : '' })
    for (const listener of this.listeners.get(type) ?? []) listener(ev)
  }
}

export class TerminalStore {
  shells = new Map<string, FakeShell>()
  private count = 0
  constructor(private workspace: (projectId: string) => string | undefined) {}

  isStream(path: string) { return /^\/api\/v2\/terminals\/[^/]+\/stream/.test(path) }
  openStream(path: string) { return new MockTerminalSource(this, path) }

  /** Route handler; undefined when the path is not a terminal route. */
  handle(method: string, url: URL, body: Record<string, unknown>): unknown {
    const p = url.pathname
    let m: RegExpMatchArray | null
    if ((m = p.match(/^\/api\/v2\/projects\/([^/]+)\/terminals$/))) {
      const projectId = decodeURIComponent(m[1])
      if (method === 'GET') return { terminals: [...this.shells.values()].filter(s => s.projectId === projectId).map(s => s.info()) }
      const cwd = this.workspace(projectId)
      if (!cwd) throw new ApiError('项目不存在', 404)
      const id = `term-${Math.random().toString(36).slice(2, 8)}`
      const shell = new FakeShell(id, projectId, cwd, `zsh ${++this.count}`)
      shell.cols = Number(body.cols) || 80
      shell.rows = Number(body.rows) || 24
      this.shells.set(id, shell)
      return shell.info()
    }
    if ((m = p.match(/^\/api\/v2\/terminals\/([^/]+)(?:\/(input|resize))?$/))) {
      const shell = this.shells.get(decodeURIComponent(m[1]))
      if (!shell) throw new ApiError('终端不存在', 404)
      if (method === 'DELETE') { this.shells.delete(shell.id); for (const s of shell.sources) s.emit('exit', { code: null, signal: 'SIGHUP' }); return { ok: true } }
      if (m[2] === 'input') { shell.input(new TextDecoder().decode(Uint8Array.from(atob(String(body.b64 ?? '')), c => c.charCodeAt(0)))); return { ok: true } }
      if (m[2] === 'resize') { shell.cols = Number(body.cols) || shell.cols; shell.rows = Number(body.rows) || shell.rows; return { ok: true } }
    }
    return undefined
  }
}
