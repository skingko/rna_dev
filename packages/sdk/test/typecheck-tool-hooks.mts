import { createSession, type SessionOptions, type SessionEvent } from '@rna-agent/sdk';
declare const options: SessionOptions;
const session = await createSession({ ...options,
  beforeTool: async ({ tool, args, signal, toolCallId, callKey }) => {
    signal.throwIfAborted();
    const target: string = typeof args.path === 'string' ? args.path : '';
    if (tool.effect === 'write' && target.startsWith('private/')) return { block: true, reason: `${toolCallId}/${callKey}: not here.`, code: 'host_policy', details: { path: target } };
  },
  afterTool: ({ result, isError }) => isError ? undefined : { content: [{ type: 'text', text: `\n\n[Automatic checks] ${result.content.length} block(s) checked.` }], details: { checked: true } },
});
const onEvent = (event: SessionEvent) => {
  if (event.type === 'tool_execution_end' && event.refusalReceipt) console.log(event.refusalReceipt.code, event.refusalReceipt.neverExecuted);
};
onEvent;
// @ts-expect-error a hook refuses or lets a call through; it never hands back rewritten arguments
const rewrite: SessionOptions['beforeTool'] = () => ({ block: false, args: { path: 'elsewhere' } });
rewrite;
// @ts-expect-error an after hook appends text; it cannot turn a result into an error
const flip: SessionOptions['afterTool'] = () => ({ isError: true });
flip;
await session.dispose();
