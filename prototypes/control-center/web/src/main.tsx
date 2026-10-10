import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/app.css'
import { setTransport } from './api/client'
import { setTheme, type Theme } from './store/ui-store'
import App from './App'
import { LocaleRoot } from './i18n/LocaleRoot'
import { currentLocale } from './i18n'
import { usePreferences } from './components/settings/preferences'

async function boot() {
  const params = new URLSearchParams(location.search)
  if (params.has('mock') || import.meta.env.VITE_MOCK === '1') {
    const { MockServer } = await import('./mock/server')
    const server = new MockServer()
    setTransport(server)
    const scenario = params.get('scenario')
    // Scenario presets for development and screenshots.
    try {
      localStorage.removeItem('rna.session')
      if (scenario === 'question') localStorage.setItem('rna.session', 's-research')
      else if (scenario !== 'empty') localStorage.setItem('rna.session', 's-ui')
    } catch { /* ignore */ }
    if (params.get('theme')) setTheme(params.get('theme') as Theme)
    const lang = params.get('lang')
    if (lang === 'en' || lang === 'zh') usePreferences.setState({ language: lang })
    if (scenario === 'streaming') {
      setTimeout(() => {
        // Simulated user message for the streaming screenshot scenario.
        void import('./store/sync').then(({ sendMessage }) => sendMessage(currentLocale() === 'en'
          ? 'The command output is hard to read. Polish the terminal blocks and file-change display, and show added/removed line counts right on the diff.'
          : '命令输出太难读了，终端块和文件改动的展示再优化一下，diff 要能直接看到增删行数。')) // i18n-ignore: simulated user message
      }, Number(params.get('delay') ?? 700))
    }
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <LocaleRoot>
        <App />
      </LocaleRoot>
    </StrictMode>,
  )
}

void boot()
