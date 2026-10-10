import { sessionSummary } from './api-v2.mjs';

// Side chat (辅助对话, docs/specs/stream-protocol-v2.md "Side chats"): a secondary
// conversation bound to a main session. It reads a bounded, deterministic tail
// context of the parent (no model call) and never writes to the parent except
// through an explicit promote. Plan mode = read-only tools by default.
const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });
const clip = (text, max) => { const value = String(text ?? '').trim(); return value.length > max ? `${value.slice(0, max)}…` : value; };
export const SIDE_CONTEXT_KEY = 'side-chat-parent';
export const isSideSession = session => session?.kind === 'side';
const retained = item => !item.sourceDeleted && !item.contextRevoked && !item.streaming;

export function sideChatContext(parent, selection = null, { turns = 8, perItem = 1200, total = 12000 } = {}) {
  const rows = []; let size = 0;
  for (const item of [...(parent.items ?? [])].reverse()) {
    if (rows.length >= turns || size >= total) break;
    if (!['user', 'assistant'].includes(item.kind) || !retained(item) || typeof item.text !== 'string' || !item.text.trim()) continue;
    const text = clip(item.text, Math.min(perItem, total - size)); size += text.length;
    rows.unshift({ id: item.id, role: item.kind, text, at: item.createdAt ?? null });
  }
  return { parentSessionId: parent.id, parentTitle: parent.title ?? null, recentTurns: rows, selection,
    instruction: 'This is a side conversation next to the main conversation named parentTitle. recentTurns is a bounded excerpt of the main conversation and selection is the passage the user selected there; use them as background for the user\'s questions here. Nothing said here reaches or changes the main conversation unless the user explicitly promotes an answer. Tools are read-only unless the user switches this side chat to build mode.' };
}
// The seed rides at the context tail (after the stable prefix) once per revision.
/** A fork's context: the earlier conversation up to where it branched (plan §4.5). */
export const FORK_CONTEXT_KEY = 'fork-origin';
export function forkContextUpdate(session) {
  if (!session?.forkContext) return null;
  return { key: FORK_CONTEXT_KEY, source: 'fork-origin', text: JSON.stringify(session.forkContext) };
}
export function sideChatContextUpdate(session) {
  if (!isSideSession(session) || !session.sideContext) return null;
  return { key: SIDE_CONTEXT_KEY, source: 'side-chat-parent', text: JSON.stringify(session.sideContext) };
}

export class SideChatService {
  constructor(store) { this.store = store; }
  parent(id) {
    const session = this.store.state.sessions.find(row => row.id === id);
    if (!session) throw fail('会话不存在。', 'SIDE_CHAT_PARENT_NOT_FOUND', 404);
    return session;
  }
  create(parentId, input = {}) {
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['selection'].includes(key))) throw fail('辅助对话参数无效。', 'SIDE_CHAT_ARGUMENTS_INVALID');
    const parent = this.parent(parentId);
    if (isSideSession(parent)) throw fail('辅助对话内不能再开启辅助对话。', 'SIDE_CHAT_NESTED', 409);
    let selection = null;
    if (input.selection !== undefined && input.selection !== null) {
      const { text, itemId } = input.selection;
      if (typeof input.selection !== 'object' || Object.keys(input.selection).some(key => !['text', 'itemId'].includes(key)) || typeof text !== 'string' || !text.trim() || text.length > 20000) throw fail('selection 必须为 {text: 1–20000 字符, itemId?}。', 'SIDE_CHAT_SELECTION_INVALID');
      if (itemId !== undefined && (typeof itemId !== 'string' || !parent.items.some(row => row.id === itemId))) throw fail('selection.itemId 不在主会话中。', 'SIDE_CHAT_SELECTION_INVALID');
      selection = { text: clip(text, 8000), ...(itemId ? { itemId, role: parent.items.find(row => row.id === itemId).kind } : {}) };
    }
    const title = selection ? `辅助对话：${clip(selection.text.replace(/\s+/gu, ' '), 24)}` : '辅助对话';
    const session = this.store.createSideChat(parentId, { title, selection: selection ? { itemId: selection.itemId ?? null, excerpt: clip(selection.text, 200) } : null, sideContext: sideChatContext(parent, selection) });
    return sessionSummary(session);
  }
  list(parentId) {
    this.parent(parentId);
    return { parentSessionId: parentId, sideChats: this.store.state.sessions.filter(row => isSideSession(row) && row.parentSessionId === parentId).map(sessionSummary) };
  }
  promote(sideId, input = {}) {
    if (!input || Object.keys(input).some(key => key !== 'itemId') || typeof input.itemId !== 'string') throw fail('请提供 itemId。', 'SIDE_CHAT_ARGUMENTS_INVALID');
    return this.store.promoteSideChat(sideId, input.itemId);
  }
}

export function createSideChatRoutes({ sideChats, body }) {
  return async function route(req, { pathname, send }) {
    const fork = pathname.match(/^\/api\/v2\/sessions\/([a-zA-Z0-9-]+)\/fork$/u);
    if (fork && req.method === 'POST') { const input = await body(req); if (!input || typeof input.itemId !== 'string' || Object.keys(input).some(key => key !== 'itemId')) throw fail('请提供 itemId。', 'FORK_ARGUMENTS_INVALID'); send(201, sessionSummary(sideChats.store.forkSession(fork[1], input.itemId))); return true; }
    const match = pathname.match(/^\/api\/v2\/sessions\/([a-zA-Z0-9-]+)\/side-chats(\/promote)?$/u);
    if (!match) return false;
    if (!match[2] && req.method === 'GET') { send(200, sideChats.list(match[1])); return true; }
    if (!match[2] && req.method === 'POST') { send(201, sideChats.create(match[1], await body(req, 128 * 1024))); return true; }
    if (match[2] && req.method === 'POST') { send(200, sideChats.promote(match[1], await body(req))); return true; }
    return false;
  };
}
