/**
 * Presence for one open conversation. Typing is reported every few seconds while
 * the user types (proactive messages wait). Reading is reported while the
 * conversation is in front (window visible and focused), as a slow heartbeat, so
 * messages held while the user was away arrive when they look at the
 * conversation, not only after they type. Leaving releases the report with its
 * receipt, so another client's newer report (the CLI) is never cleared.
 */
export const TYPING_EVERY_MS = 2500
/** A typing report stays live for 10 s on the daemon; reading waits that long before replacing it. */
export const TYPING_FRESH_MS = 10_000
/** The daemon keeps a reading report for 45 s; it is renewed well before. */
export const READING_EVERY_MS = 30_000

export type PresenceBody = { typing: boolean; visible: boolean; expectedReceiptId?: string | null }
type Saved = { receiptId?: unknown } | null | undefined

export function presenceReporter({ send, here, now = Date.now }: { send: (body: PresenceBody) => Promise<Saved>; here: () => boolean; now?: () => number }) {
  let typedAt = -Infinity, sentAt = -Infinity, claimed = false, typingSent = false, owned: string | null = null, stopped = false
  const post = (body: PresenceBody) => {
    sentAt = now(); claimed = body.visible; typingSent = body.typing
    if (!body.visible) owned = null
    return send(body).then(saved => { if (body.visible && typeof saved?.receiptId === 'string') owned = saved.receiptId }).catch(() => {})
  }
  return {
    /** A keystroke in the composer. */
    typed() {
      if (stopped) return
      const at = now(); if (at - typedAt < TYPING_EVERY_MS) return
      typedAt = at; void post({ typing: true, visible: true })
    },
    /** Called on an interval and on focus, blur and visibility changes. */
    check() {
      if (stopped || now() - typedAt < TYPING_FRESH_MS) return
      if (here()) { if (!claimed || typingSent || now() - sentAt >= READING_EVERY_MS) void post({ typing: false, visible: true }) }
      else if (claimed) void post({ typing: false, visible: false, expectedReceiptId: owned })
    },
    /** The conversation closed or changed. */
    stop() {
      if (stopped) return
      stopped = true
      if (claimed) void post({ typing: false, visible: false, expectedReceiptId: owned })
    },
  }
}

/** The conversation is in front of the user: the page is visible and the window has focus. */
export const inFront = () => document.visibilityState === 'visible' && document.hasFocus()
