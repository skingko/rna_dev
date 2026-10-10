// Evidence rows as the judge reads them (shared by the initiative gate and the internal-effort judgment).
const excerpt = (value, limit) => { const text = String(value ?? ''); return text.length <= limit ? text : `${text.slice(0, Math.floor(limit * .55))} […excerpt…] ${text.slice(-Math.floor(limit * .35))}`; };

/** A gate evidence row as readable text. A conversation result is stored as JSON whose first ~200 characters are ids
 * (sessionId, turnId, messageId): the judge saw about 90 characters of the reply and no receipt. Here it reads as the
 * request, the reply excerpt and the receipt names; a folder change as its paths. Unknown shapes pass through. */
export function evidenceText(row) {
  const raw = String(row?.summary ?? row?.text ?? ''); let value;
  try { value = JSON.parse(raw); } catch { return raw; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return raw;
  if (row?.type === 'conversation_result' || typeof value.turnId === 'string') {
    const requests = Array.isArray(value.requests) ? value.requests : [], tools = Array.isArray(value.tools) ? value.tools : [], request = requests.at(-1)?.text, reply = value.final?.text;
    // Receipts first: the row is clipped at its end, and the receipts are the short, host-recorded part.
    return [`foreground turn ${value.status ?? 'ended'}.`, tools.length ? `Tool receipts: ${tools.map(tool => `${tool.name} ${tool.status}`).join(', ')}${value.omitted?.toolResults > 0 ? ' (and earlier ones)' : ''}.` : 'No tool receipts.',
      request ? `Request: ${excerpt(request, 120)}` : '', reply ? `Reply: ${excerpt(reply, 200)}` : 'No reply.'].filter(Boolean).join(' ');
  }
  if (Array.isArray(value.changes)) return `Files changed in the project folder: ${value.changes.slice(0, 8).map(change => `${change.path} (${change.change})`).join(', ')}${value.truncated || value.changes.length > 8 ? ' and others' : ''}.`;
  if (row?.type === 'project_state') return `Project description: ${[value.overview, value.focus].filter(text => typeof text === 'string' && text.trim()).map(text => excerpt(text, 180)).join(' Focus: ')}`;
  if (row?.type === 'schedule_state') return `Registered schedules: ${(Array.isArray(value.schedules) ? value.schedules : []).map(item => `${item.purposeKey ?? item.id} (${item.enabled ? 'on' : 'off'})`).join(', ') || 'none'}.`;
  if (row?.type === 'scheduled_occurrence') return `Scheduled task due: ${value.title ?? 'scheduled task'}.`;
  return raw;
}
