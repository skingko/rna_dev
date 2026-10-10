export const CHAT_COMMANDS = ['/help','/status','/project','/sources','/source','/versions','/initiative','/background','/goal','/feedback','/steer','/followup','/pause','/resume','/stop','/retry','/compact','/recovery','/mode','/model','/attach','/attachments','/detach','/send','/permission','/export','/inbox','/withdraw','/quit'];
export const completeCommand = line => [line.startsWith('/') && !line.includes(' ') ? CHAT_COMMANDS.filter(command => command.startsWith(line)) : [], line];
export function createLineQueue(handle) {
  let chain = Promise.resolve(), cancelled = false;
  return { push(line) { if (!cancelled) chain = chain.then(() => cancelled ? undefined : handle(line)); return chain; }, drain() { return chain; }, cancel() { cancelled = true; } };
}
export function incrementalItem(previous, next) {
  if (JSON.stringify(previous) === JSON.stringify(next)) return null;
  if (previous?.kind === 'assistant' && next.kind === 'assistant' && !next.interaction && typeof next.text === 'string' && next.text.startsWith(previous.text ?? '')) {
    const text = next.text.slice((previous.text ?? '').length); return text ? { ...next, text, continuation: true } : null;
  }
  return next;
}
