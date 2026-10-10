import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import Threads from './Threads'

// With the GPU disabled or blocklisted there is no WebGL context. The empty state's background then stays empty instead of its effect
// throwing, which unmounted the whole app (a blank window, found by a headless boot test of 0.71.0; 0.70.0 did the same).

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root, host: HTMLDivElement
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks() })

it('renders nothing for the background and keeps the rest of the tree when WebGL is unavailable', async () => {
  const errors: unknown[] = [], onError = (event: ErrorEvent) => { errors.push(event.error); event.preventDefault() }
  window.addEventListener('error', onError)
  try {
    await act(async () => { root.render(createElement('main', null, createElement('p', null, 'composer'), createElement(Threads, { color: [0.3, 0.4, 0.8] }))) })
  } finally { window.removeEventListener('error', onError) }
  expect(errors).toEqual([])
  expect(host.querySelector('p')?.textContent).toBe('composer')
  expect(host.querySelector('canvas')).toBeNull()
})
