/**
 * When a host (the 审查 tab) owns the 预览 / 源码 switch, it provides the
 * chosen view here and renderers drop their own inner mode toggles.
 * null = the renderer shows its own switch (standalone file preview).
 */
import { createContext, useContext } from 'react'

export type HostedView = 'preview' | 'source'
export const PreviewViewContext = createContext<HostedView | null>(null)
/** The host-chosen view, or null when the renderer owns its toggle. */
export const useHostedView = () => useContext(PreviewViewContext)
