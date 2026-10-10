/**
 * Pure, framework-free session model: normalized items, offset-checked delta
 * application, and the timeline structure (turn rows + grouped steps).
 *
 * Invariants the React layer relies on:
 *  - A delta replaces exactly one item object; every other item keeps its
 *    reference, so per-item subscriptions re-render only the streaming block.
 *  - `structure` (and each row inside it) keeps its reference unless the
 *    shape of the timeline changed, so the timeline list does not re-render
 *    on text deltas.
 */
import type { DeltaEvent, Item, Session, SessionMeta, SessionPage, SessionWindow, Turn, TurnPhase } from '@/api/types'
import { BLOCK_KINDS, GROUPABLE, toolKind, type ViewKind } from '@/lib/tools'

export interface PhaseState { phase: TurnPhase; at: string; preparing?: boolean }

const ACTIVE_TURN = new Set(['running', 'pending', 'queued', 'paused'])
const turnActive = (turn: Turn | undefined) => !turn || ACTIVE_TURN.has(turn.status)
const isPreparing = (item: Item | undefined) => Boolean(item?.tool?.preparing)

export type Step =
  | { type: 'assistant'; key: string; itemId: string }
  | { type: 'tool'; key: string; itemId: string; kind: ViewKind }
  | { type: 'group'; key: string; kind: ViewKind; itemIds: string[] }
  | { type: 'notice'; key: string; itemId: string }
  | { type: 'question'; key: string; itemId: string }
  /** E2 background subagent, shown where its originating agent_* tool call was. */
  | { type: 'subagent'; key: string; itemId: string }
  /** A message the user added while the turn ran (delivery steer), where the run took it in. */
  | { type: 'user'; key: string; itemId: string }

export type Row =
  /** `errorId`: a failed turn's reason (its last runtime-error notice), shown in the answer's place rather than inside the folded process. */
  | { type: 'turn'; key: string; turnId: string; userItemId: string | null; steps: Step[]; answerId: string | null; errorId: string | null; toolCount: number }
  | { type: 'pending'; key: string; userItemId: string }
  | { type: 'item'; key: string; itemId: string }

export interface Structure { signature: string; rows: Row[] }

export interface SessionSlice {
  meta: SessionMeta
  items: Record<string, Item>
  order: string[]
  turns: Record<string, Turn>
  phases: Record<string, PhaseState>
  structure: Structure
  revision: number
  needsResync: boolean
  /**
   * B9: what of the conversation is held. Opening reads the tail window; `hasMore` while older items exist on the host
   * (paged in by `prependPage`). Absent or null: every item is held.
   */
  window?: SessionWindow | null
  /**
   * Older items than the window held: cards that still wait for the user (the snapshot's `pinned`), and items the
   * stream changed while they were not held. A page that brings one in takes the newer version (`prependPage`).
   */
  outside?: Record<string, { item: Item; revision: number }>
  /**
   * While older history is not held: ids an `items.remove` named that were not held, with the revision of the removal.
   * A page read before it (a lower `revision`) still carries them and must not bring them back (zcode puts `atRevision`
   * on range reads for this). A page read after them lands and drops them; a full read starts without any.
   */
  removed?: Record<string, number>
  /** Counts the full reads this slice came from (`createSlice`): a page asked for before the latest one is dropped. */
  epoch?: number
}

const EMPTY_STRUCTURE: Structure = { signature: '', rows: [] }

export function metaOf(session: Session | SessionMeta): SessionMeta {
  const { items: _items, turns: _turns, revision: _revision, window: _window, pinned: _pinned, ...meta } = session as Session
  void _items; void _turns; void _revision; void _window; void _pinned
  return meta
}

/** A card waiting for the user: a question or permission request still open that can be answered (host `waitingForUser`). */
export function waitingForUser(item: Item | undefined): boolean {
  const ix = item?.interaction
  return Boolean(ix && (ix.status === 'pending' || ix.status === 'interrupted') && ix.canRespond !== false)
}

/** An item of the conversation the slice knows: held, or older than the window and kept aside (`outside`). */
export function knownItem(slice: SessionSlice | undefined, id: string): Item | undefined {
  return slice?.items[id] ?? slice?.outside?.[id]?.item
}

/**
 * The cards waiting for the user anywhere in the conversation, oldest first (B9): those older than the window held
 * (the snapshot's `pinned`, with what the stream changed since), then the held ones.
 */
export function waitingCardIds(slice: SessionSlice): string[] {
  const older = Object.values(slice.outside ?? {}).map(entry => entry.item).filter(item => waitingForUser(item) && !slice.items[item.id])
    .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '')).map(item => item.id)
  return [...older, ...slice.order.filter(id => waitingForUser(slice.items[id]))]
}

export function createSlice(session: Session, previous?: SessionSlice): SessionSlice {
  const items: Record<string, Item> = {}
  const order: string[] = []
  for (const item of session.items) {
    // Keep references for unchanged items so resync does not re-render everything.
    const prev = previous?.items[item.id]
    items[item.id] = prev && sameItem(prev, item) ? prev : item
    order.push(item.id)
  }
  // Optimistic user messages survive a resync until the server echo arrives.
  if (previous) {
    for (const id of previous.order) {
      const item = previous.items[id]
      if (item?.optimistic && !matchesEcho(item, session.items)) { items[id] = item; order.push(id) }
      // Pending tool entries are display-only; keep them while their turn runs.
      else if (isPreparing(item) && !items[id] && turnActive(session.turns.find(turn => turn.id === item.turnId)) && !session.items.some(row => supersedes(row, item))) { items[id] = item; order.push(id) }
    }
  }
  const turns: Record<string, Turn> = {}
  for (const turn of session.turns) {
    const prev = previous?.turns[turn.id]
    turns[turn.id] = prev && JSON.stringify(prev) === JSON.stringify(turn) ? prev : turn
  }
  const slice: SessionSlice = {
    meta: metaOf(session),
    items, order, turns,
    phases: previous?.phases ?? {},
    structure: previous?.structure ?? EMPTY_STRUCTURE,
    revision: session.revision ?? previous?.revision ?? 0,
    needsResync: false,
    window: session.window ?? null,
    epoch: (previous?.epoch ?? 0) + 1,
  }
  // Cards older than the window that still wait for the user: known, not shown until their page is read.
  const pinned = (session.pinned ?? []).filter(item => item?.id && !items[item.id])
  if (pinned.length) slice.outside = Object.fromEntries(pinned.map(item => [item.id, { item, revision: slice.revision }]))
  slice.structure = buildStructure(slice, slice.structure)
  return slice
}

/** While older history is not held: when the first item held was created (anything earlier is outside the window). */
function windowFloor(slice: SessionSlice): string | null {
  if (!slice.window?.hasMore) return null
  for (const id of slice.order) { const row = slice.items[id]; if (row && !row.optimistic) return row.createdAt || null }
  return null
}

/** The first item held that the host knows (not an optimistic echo or a pending tool entry): where older pages start. */
export function firstHeld(slice: SessionSlice): string | undefined {
  return slice.order.find(id => !slice.items[id]?.optimistic && !slice.items[id]?.tool?.preparing)
}

/**
 * B9: a page of older history (GET …/items?before=) goes in front of what is held. Items held already and newer
 * versions the stream sent while they were outside the window win over the page; turns held already are kept. An item
 * removed after the page was read (`removed`) stays removed.
 */
export function prependPage(slice: SessionSlice, page: Pick<SessionPage, 'items' | 'turns' | 'hasMore' | 'totalCount' | 'revision'>): SessionSlice {
  const items = { ...slice.items }, outside = { ...slice.outside }, front: string[] = [], removed = slice.removed
  for (const row of page.items) {
    if (items[row.id] || (removed?.[row.id] ?? -1) > page.revision) continue
    const later = outside[row.id]
    items[row.id] = later && later.revision > page.revision ? later.item : row
    delete outside[row.id]
    front.push(row.id)
  }
  const turns = { ...slice.turns }
  for (const turn of page.turns) turns[turn.id] ??= turn
  // Removals this page already reflects cannot reach a later page (read later still): only newer ones are kept.
  const later = page.hasMore && removed ? Object.entries(removed).filter(([, at]) => at > page.revision) : []
  const next: SessionSlice = { ...slice, items, turns, outside, order: [...front, ...slice.order], window: { totalCount: page.totalCount, firstItemId: slice.window?.firstItemId ?? null, hasMore: page.hasMore }, removed: later.length ? Object.fromEntries(later) : undefined }
  next.structure = buildStructure(next, slice.structure)
  return next
}

function sameItem(a: Item, b: Item): boolean {
  if (a === b) return true
  return a.text === b.text && a.streaming === b.streaming && JSON.stringify(a) === JSON.stringify(b)
}

/** A durable tool item replaces the pending entry with the same call id. */
function supersedes(durable: Item, pending: Item): boolean {
  if (durable.kind !== 'tool' || !durable.tool || durable.tool.preparing || durable.turnId !== pending.turnId) return false
  return pending.tool?.id ? durable.tool.id === pending.tool.id : durable.tool.name === pending.tool?.name
}

function matchesEcho(optimistic: Item, items: Item[]): boolean {
  return items.some(item => item.kind === 'user' && item.text === optimistic.text && item.createdAt >= optimistic.createdAt.slice(0, 19))
}

/* ------------------------------------------------------------- deltas */

export type DeltaResult = { slice: SessionSlice; status: 'applied' | 'duplicate' | 'gap' }

function blockText(item: Item, block: DeltaEvent['block']): string {
  switch (block) {
    case 'text': return item.text ?? ''
    case 'thinking': return item.thinking?.text ?? ''
    case 'tool_output': return item.tool?.output ?? ''
    case 'tool_args': return item.tool?.argsPreview ?? ''
  }
}

function withBlockText(item: Item, block: DeltaEvent['block'], text: string, at: string): Item {
  switch (block) {
    case 'text':
      return { ...item, text, streaming: true, firstTokenAt: item.firstTokenAt ?? at }
    case 'thinking':
      return { ...item, streaming: true, thinking: { visibility: 'full', startedAt: at, endedAt: null, ...item.thinking, text } }
    case 'tool_output':
      return { ...item, tool: { name: 'tool', status: 'running', ...item.tool, output: text } }
    case 'tool_args':
      return { ...item, tool: { name: 'tool', status: 'pending', ...item.tool, argsPreview: text } }
  }
}

function placeholderFor(delta: DeltaEvent, at: string): Item {
  const tool = delta.block === 'tool_output' || delta.block === 'tool_args'
  return {
    id: delta.itemId,
    turnId: delta.turnId,
    kind: tool ? 'tool' : 'assistant',
    text: '',
    createdAt: at,
    streaming: true,
    startedAt: at,
    ...(tool ? { tool: { name: 'tool', status: 'pending' } } : {}),
  }
}

/**
 * Apply one streaming delta. `offset` is the block length before the append:
 *  - offset == length           -> append
 *  - offset + len <= length     -> duplicate (already have it), ignore
 *  - offset <  length < end     -> overlap, append only the unseen tail
 *  - offset >  length           -> gap: mark for resync, do not guess
 */
export function applyDelta(slice: SessionSlice, delta: DeltaEvent, now = new Date().toISOString()): DeltaResult {
  if (delta.block === 'tool_args' && delta.tool) return applyPendingTool(slice, delta, now)
  let item = slice.items[delta.itemId]
  let order = slice.order
  if (!item) {
    if (delta.offset !== 0) return { slice: { ...slice, needsResync: true }, status: 'gap' }
    item = placeholderFor(delta, now)
    order = [...slice.order, delta.itemId]
  }
  const current = blockText(item, delta.block)
  const length = current.length
  const end = delta.offset + delta.append.length
  if (delta.offset > length) return { slice: { ...slice, needsResync: true }, status: 'gap' }
  if (end <= length && slice.items[delta.itemId]) return { slice, status: 'duplicate' }
  const tail = delta.append.slice(length - delta.offset)
  const next = withBlockText(item, delta.block, current + tail, now)
  const nextSlice: SessionSlice = { ...slice, order, items: { ...slice.items, [delta.itemId]: next } }
  // Only structural transitions (new item, first visible text, streaming flag)
  // rebuild the timeline shape; ordinary appends touch one item only.
  const turn = delta.turnId ? slice.turns[delta.turnId] : undefined
  if (order !== slice.order || itemSignature(item, turn) !== itemSignature(next, turn)) {
    nextSlice.structure = buildStructure(nextSlice, slice.structure)
  }
  return { slice: nextSlice, status: 'applied' }
}

/**
 * A `tool_args` delta with metadata describes a pending tool entry. It is
 * display-only: a gap never triggers a resync (a late joiner still gets the
 * host-derived target), and it is ignored once the durable item exists or the
 * turn has ended.
 */
function applyPendingTool(slice: SessionSlice, delta: DeltaEvent, now: string): DeltaResult {
  const meta = delta.tool!
  const turn = delta.turnId ? slice.turns[delta.turnId] : undefined
  if (!turnActive(turn)) return { slice, status: 'duplicate' }
  const existing = slice.items[delta.itemId]
  if (existing && !isPreparing(existing)) return { slice, status: 'duplicate' }
  const probe = { kind: 'tool', turnId: delta.turnId, tool: { name: meta.name, id: meta.id ?? existing?.tool?.id } } as Item
  if (slice.order.some(id => supersedes(slice.items[id], probe))) return { slice, status: 'duplicate' }
  const current = existing?.tool?.argsPreview ?? ''
  const end = delta.offset + delta.append.length
  const text = delta.offset <= current.length && end > current.length ? current + delta.append.slice(current.length - delta.offset) : current
  const prev = existing?.tool
  const tool = {
    name: meta.name, status: 'pending', preparing: true as const, index: meta.index,
    ...(meta.id ?? prev?.id ? { id: meta.id ?? prev?.id } : {}),
    ...(meta.kind ? { kind: meta.kind } : {}),
    ...(meta.target ?? prev?.target ? { target: meta.target ?? prev?.target } : {}),
    argsPreview: text,
  }
  if (prev && JSON.stringify(prev) === JSON.stringify(tool)) return { slice, status: 'duplicate' }
  const next: Item = { id: delta.itemId, turnId: delta.turnId, kind: 'tool', text: '', createdAt: existing?.createdAt ?? now, streaming: true, startedAt: existing?.startedAt ?? now, tool }
  const order = existing ? slice.order : [...slice.order, delta.itemId]
  const nextSlice: SessionSlice = { ...slice, order, items: { ...slice.items, [delta.itemId]: next } }
  if (!existing || itemSignature(existing, turn) !== itemSignature(next, turn)) nextSlice.structure = buildStructure(nextSlice, slice.structure)
  return { slice: nextSlice, status: 'applied' }
}

function visibleAssistant(item: Item): boolean {
  return Boolean(item.text?.trim()) || Boolean(item.thinking && (item.thinking.text?.trim() || item.thinking.visibility === 'hidden'))
}

/* ------------------------------------------------------- persisted events */

export function upsertItems(slice: SessionSlice, incoming: Item[], revision = slice.revision): SessionSlice {
  const items = { ...slice.items }
  let order = slice.order
  let appended: string[] | null = null
  let removedOptimistic = false
  let reordered = false
  let outside = slice.outside
  const floor = windowFloor(slice)
  for (let item of incoming) {
    // An older item the window does not hold (its feedback or card changed, a pinned card was answered): not appended
    // at the end, remembered for the page that brings it in.
    if (!items[item.id] && (outside?.[item.id] || floor && item.createdAt && item.createdAt < floor)) { outside = { ...outside, [item.id]: { item, revision } }; continue }
    // The durable tool item takes the pending entry's place (and its layout).
    const pendingId = item.kind === 'tool' && !items[item.id] ? order.find(id => isPreparing(items[id]) && supersedes(item, items[id])) : undefined
    if (pendingId) {
      delete items[pendingId]
      order = order.map(id => (id === pendingId ? item.id : id))
      item = { ...item, preparedFrom: pendingId }
      items[item.id] = item
      reordered = true
      continue
    }
    if (!items[item.id]) {
      appended ??= []
      appended.push(item.id)
    }
    // The persisted item is authoritative over locally stitched deltas.
    const prev = items[item.id]
    if (prev?.preparedFrom && !item.preparedFrom) item = { ...item, preparedFrom: prev.preparedFrom }
    items[item.id] = prev && sameItem(prev, item) ? prev : item
    if (item.kind === 'user') {
      for (const id of order) {
        const candidate = items[id]
        if (candidate?.optimistic && candidate.text === item.text) { delete items[id]; removedOptimistic = true }
      }
    }
  }
  if (appended || removedOptimistic || reordered) {
    order = [...order, ...(appended ?? [])].filter(id => items[id])
    // Keep optimistic messages at the tail until echoed.
    const optimistic = order.filter(id => items[id].optimistic)
    if (optimistic.length) order = [...order.filter(id => !items[id].optimistic), ...optimistic]
  }
  const next: SessionSlice = { ...slice, items, order, ...(outside !== slice.outside ? { outside } : {}) }
  next.structure = buildStructure(next, slice.structure)
  return next
}

/** `revision`: the removal's; an id not held is remembered while older history is not held (`removed`). */
export function removeItems(slice: SessionSlice, ids: string[], revision = slice.revision): SessionSlice {
  const drop = new Set(ids)
  const items = { ...slice.items }
  for (const id of ids) delete items[id]
  let outside = slice.outside
  if (outside && ids.some(id => outside![id])) { outside = { ...outside }; for (const id of ids) delete outside[id] }
  const unheld = slice.window?.hasMore ? ids.filter(id => !slice.items[id]) : []
  const removed = unheld.length ? { ...slice.removed, ...Object.fromEntries(unheld.map(id => [id, revision])) } : slice.removed
  const next: SessionSlice = { ...slice, items, order: slice.order.filter(id => !drop.has(id)), ...(outside !== slice.outside ? { outside } : {}), ...(removed !== slice.removed ? { removed } : {}) }
  next.structure = buildStructure(next, slice.structure)
  return next
}

export function upsertTurns(slice: SessionSlice, incoming: Turn[]): SessionSlice {
  const turns = { ...slice.turns }
  for (const turn of incoming) turns[turn.id] = { ...turns[turn.id], ...turn }
  // Pending tool entries never outlive their turn (e.g. a call that was never executed).
  const ended = new Set(incoming.filter(turn => !turnActive(turns[turn.id])).map(turn => turn.id))
  const stale = ended.size ? slice.order.filter(id => isPreparing(slice.items[id]) && ended.has(slice.items[id].turnId ?? '')) : []
  if (stale.length) {
    const items = { ...slice.items }
    for (const id of stale) delete items[id]
    const next: SessionSlice = { ...slice, turns, items, order: slice.order.filter(id => items[id]) }
    next.structure = buildStructure(next, slice.structure)
    return next
  }
  const next: SessionSlice = { ...slice, turns }
  next.structure = buildStructure(next, slice.structure)
  return next
}

export function patchMeta(slice: SessionSlice, fields: Partial<SessionMeta>): SessionSlice {
  return { ...slice, meta: { ...slice.meta, ...fields } }
}

export function setPhase(slice: SessionSlice, turnId: string, phase: PhaseState): SessionSlice {
  return { ...slice, phases: { ...slice.phases, [turnId]: phase } }
}

export function addOptimistic(slice: SessionSlice, item: Item): SessionSlice {
  const next: SessionSlice = { ...slice, items: { ...slice.items, [item.id]: item }, order: [...slice.order, item.id] }
  next.structure = buildStructure(next, slice.structure)
  return next
}

/* ------------------------------------------------------------ structure */

function itemSignature(item: Item, turn: Turn | undefined): string {
  const tk = item.tool ? `${toolKind(item.tool)}${item.tool.preparing ? '~' : ''}` : ''
  const sub = item.subagent?.toolCallId ?? ''
  const vis = item.kind === 'assistant' ? `${visibleAssistant(item) ? 'v' : 'e'}${item.streaming ? 's' : ''}${item.text?.trim() ? 't' : ''}` : ''
  return `${item.id}:${item.kind}:${item.turnId ?? ''}:${item.source ?? ''}:${tk}:${vis}:${item.optimistic ? 'o' : ''}:${turn?.status ?? ''}:${sub}`
}

const isProactive = (item: Item) => item.source === 'initiative'
/** A turn still under way: the conversation with it is not finished yet. */
const OPEN_TURN = new Set(['running', 'paused'])

/**
 * Build turn rows. A turn row holds the user message, its process steps and
 * the final answer (last assistant text with no tool after it). Proactive
 * messages, and items with no turn, become standalone rows in place — except
 * that a proactive message arriving while a turn is under way (the turn is
 * still open, or more of its own steps came after it) is shown just before
 * that turn, so the conversation in progress stays at the bottom next to the
 * composer; it keeps that place after the turn ends, so nothing jumps.
 */
export function buildStructure(slice: Pick<SessionSlice, 'items' | 'order' | 'turns'>, previous: Structure = EMPTY_STRUCTURE): Structure {
  const signature = slice.order.map(id => itemSignature(slice.items[id], slice.items[id]?.turnId ? slice.turns[slice.items[id].turnId!] : undefined)).join('|')
  if (signature === previous.signature) return previous

  type Draft = { turnId: string; userItemId: string | null; members: Item[] }
  const rows: (Draft | Row)[] = []
  const drafts = new Map<string, Draft>()
  // Where each turn's own items end in arrival order (proactive items never count as a turn's own).
  const lastOwn = new Map<string, number>()
  slice.order.forEach((id, index) => { const item = slice.items[id]; if (item?.turnId && !item.optimistic && !isProactive(item)) lastOwn.set(item.turnId, index) })
  const underWay = (draft: Draft, index: number) => (lastOwn.get(draft.turnId) ?? -1) > index || OPEN_TURN.has(slice.turns[draft.turnId]?.status ?? '')
  for (const [index, id] of slice.order.entries()) {
    const item = slice.items[id]
    if (!item) continue
    if (item.optimistic) { rows.push({ type: 'pending', key: `pending:${id}`, userItemId: id }); continue }
    if (isProactive(item)) {
      const row: Row = { type: 'item', key: `item:${id}`, itemId: id }
      // The most recent turn this message arrived in the middle of, if any.
      const open = [...drafts.values()].reverse().find(draft => underWay(draft, index))
      if (open) rows.splice(rows.indexOf(open), 0, row); else rows.push(row)
      continue
    }
    if (!item.turnId) { rows.push({ type: 'item', key: `item:${id}`, itemId: id }); continue }
    let draft = drafts.get(item.turnId)
    if (!draft) {
      draft = { turnId: item.turnId, userItemId: null, members: [] }
      drafts.set(item.turnId, draft)
      rows.push(draft)
    }
    const turn = slice.turns[item.turnId]
    if (item.kind === 'user' && (turn?.userItemId ? turn.userItemId === item.id : draft.userItemId === null && item.source !== 'subagent')) {
      // A subagent result that woke an idle session is already shown by the notice posted just before its turn.
      if (!repeatsNotice(item, slice.items[slice.order[index - 1]])) draft.userItemId = item.id
    } else draft.members.push(item)
  }

  const built: Row[] = rows.map(row => ('type' in row ? row : finishTurn(row, slice.turns[row.turnId])))
  const prevByKey = new Map(previous.rows.map(r => [r.key, r]))
  const shared = built.map(row => {
    const prev = prevByKey.get(row.key)
    return prev && JSON.stringify(prev) === JSON.stringify(row) ? prev : row
  })
  return { signature, rows: shared }
}

function repeatsNotice(item: Item, previous: Item | undefined): boolean {
  return item.source === 'subagent' && Boolean(item.agentId) && previous?.kind === 'notice' && previous.source === 'subagent' && previous.agentId === item.agentId
}

function finishTurn(draft: { turnId: string; userItemId: string | null; members: Item[] }, turn: Turn | undefined): Row {
  const members = draft.members
  // Final answer: last assistant item with text, with no tool/question/new message after it.
  let answerId: string | null = null
  for (let i = members.length - 1; i >= 0; i--) {
    const m = members[i]
    if (m.kind === 'tool' || m.kind === 'question' || m.kind === 'user') break
    if (m.kind === 'assistant' && m.text?.trim()) { answerId = m.id; break }
    if (m.kind === 'assistant' && m.streaming) { answerId = m.id; break }
  }
  const errorId = turn?.status === 'failed' ? members.findLast(m => m.kind === 'notice' && m.source === 'runtime-error')?.id ?? null : null
  const steps: Step[] = []
  let toolCount = 0
  // A subagent replaces the agent_consult / agent_delegate row that started it.
  const subagentByCall = new Map<string, Item>()
  for (const m of members) if (m.kind === 'subagent' && m.subagent?.toolCallId) subagentByCall.set(m.subagent.toolCallId, m)
  const placed = new Set<string>()
  for (const m of members) {
    if (m.kind === 'subagent') {
      if (!placed.has(m.id)) { placed.add(m.id); steps.push({ type: 'subagent', key: m.id, itemId: m.id }) }
      continue
    }
    if ((m.kind === 'user' || m.kind === 'notice') && m.source === 'subagent') { steps.push({ type: 'notice', key: m.id, itemId: m.id }); continue }
    if (m.kind === 'user') { steps.push({ type: 'user', key: m.id, itemId: m.id }); continue }
    if (m.id === errorId) continue
    if (m.kind === 'assistant') {
      if (m.id === answerId) {
        // The answer's own reasoning still belongs to the process.
        if (m.thinking && (m.thinking.text || m.thinking.visibility === 'hidden')) steps.push({ type: 'assistant', key: `think:${m.id}`, itemId: m.id })
        continue
      }
      if (!visibleAssistant(m) && !m.streaming) continue
      steps.push({ type: 'assistant', key: m.id, itemId: m.id })
      continue
    }
    if (m.kind === 'question') { steps.push({ type: 'question', key: m.id, itemId: m.id }); continue }
    if (m.kind === 'notice') { steps.push({ type: 'notice', key: m.id, itemId: m.id }); continue }
    if (m.kind === 'tool' && m.tool) {
      const linked = subagentByCall.get(m.tool.id ?? '') ?? subagentByCall.get(m.tool.callKey ?? '')
      if (linked) {
        toolCount++
        if (!placed.has(linked.id)) { placed.add(linked.id); steps.push({ type: 'subagent', key: linked.id, itemId: linked.id }) }
        continue
      }
      const kind = toolKind(m.tool)
      // A pending entry is always its own row, so it can morph into the executed one.
      if (m.tool.preparing) { steps.push({ type: 'tool', key: m.id, itemId: m.id, kind }); continue }
      toolCount++
      if (kind === 'question') continue // the question card item represents it
      const last = steps.at(-1)
      if (GROUPABLE.has(kind) && !BLOCK_KINDS.has(kind)) {
        if (last?.type === 'group' && last.kind === kind) { last.itemIds.push(m.id); continue }
        if (last?.type === 'tool' && last.kind === kind) {
          steps[steps.length - 1] = { type: 'group', key: `group:${last.itemId}`, kind, itemIds: [last.itemId, m.id] }
          continue
        }
      }
      steps.push({ type: 'tool', key: m.id, itemId: m.id, kind })
    }
  }
  return { type: 'turn', key: `turn:${draft.turnId}`, turnId: draft.turnId, userItemId: draft.userItemId, steps, answerId, errorId, toolCount }
}

/* --------------------------------------------------------------- timing */

/** Host turn timing beyond the shared type: the C-a attempt clock (with `pausedAt`), and the record each retry leaves. */
type TurnClock = Turn & { activeMs?: number | null; attemptStartedAt?: string | null; pausedAt?: string | null; retryHistory?: { completedAt?: string | null; retriedAt?: string | null }[] }

const parsed = (iso?: string | null) => { const ms = iso ? Date.parse(iso) : NaN; return Number.isNaN(ms) ? null : ms }

/**
 * How long a turn actually worked: its attempts added up, so the wait between a
 * failure and the user's retry (or a pause) is not counted. The host's
 * `activeMs` covers the attempts before the current one (`attemptStartedAt`);
 * older turns rebuild their attempts from `retryHistory`. `live` counts the
 * current attempt up to `now`; otherwise it ends at `completedAt`, else (a
 * paused turn) at `pausedAt` or `end`, the turn's last activity.
 */
export function turnWorkMs(turn: Turn | undefined, { live, now = Date.now(), end }: { live: boolean; now?: number; end?: string | null }): number | null {
  if (!turn) return null
  const clock = turn as TurnClock
  const stop = live ? now : parsed(turn.completedAt) ?? parsed(clock.pausedAt) ?? parsed(end)
  if (stop === null) return null
  const attempt = parsed(clock.attemptStartedAt)
  if (typeof clock.activeMs === 'number' && attempt !== null) return Math.max(0, clock.activeMs) + Math.max(0, stop - attempt)
  let start = parsed(turn.startedAt) ?? parsed(turn.createdAt)
  if (start === null) return null
  let total = 0
  for (const retry of clock.retryHistory ?? []) {
    const failed = parsed(retry.completedAt), resumed = parsed(retry.retriedAt)
    if (failed === null || resumed === null) continue
    total += Math.max(0, failed - start)
    start = resumed
  }
  return total + Math.max(0, stop - start)
}

/** The latest moment anything in the turn happened (a paused turn's end). */
export function turnLastActivity(slice: Pick<SessionSlice, 'items' | 'order'> | undefined, turnId: string): string | null {
  let last: string | null = null
  for (const id of slice?.order ?? []) {
    const item = slice!.items[id]
    if (item?.turnId !== turnId || item.optimistic) continue
    for (const at of [item.createdAt, item.endedAt, item.tool?.endedAt]) if (at && (!last || at > last)) last = at
  }
  return last
}
