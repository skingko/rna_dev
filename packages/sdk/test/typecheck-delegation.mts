import { BUILTIN_AGENT_ROLES, DelegationError, createDelegationTools, runDelegatedAgent, delegationSteps, conversationExcerpt, agentMergeTool, createWorkspaceTools, AGENT_MERGE_TOOL_NAME, AGENT_MERGE_ACTIONS, AGENT_MERGE_TEXT, DELEGATE_ISOLATION_TEXT, DELEGATION_TOOL_NAMES, type Session, type AgentTool, type DelegatedAgentResult, type DelegatedAgentEvent, type CompactOptions, type DelegationControlHandlers, type AgentMergeArgs, type ToolResult } from '@rna-agent/sdk';
declare const session: Session;
const cancellation = new AbortController();
const generated: CompactOptions = { generate: true, signal: cancellation.signal, instructions: 'Keep exact paths.' };
await session.compact(generated);
await session.compact({ summarize: ({ messages, previousSummary, instructions, signal }) => { signal.throwIfAborted(); return `${previousSummary ?? ''} ${instructions} ${messages.length}`; } });
// @ts-expect-error generate is an explicit boolean
await session.compact({ generate: 'true' });
// @ts-expect-error cancellation must be an AbortSignal
await session.compact({ signal: cancellation });
const role = BUILTIN_AGENT_ROLES[0].id;
const progress: DelegatedAgentEvent[] = [];
const steps: number | null = delegationSteps(role), excerpt: string | null = conversationExcerpt(['Keep the tone.']);
const result: DelegatedAgentResult = await runDelegatedAgent({ role, task: 'Inspect files.', sessionId: 'child', signal: cancellation.signal, conversation: ['Keep the tone.'],
  onUpdate: event => { progress.push(event); },
  createChild: async ({ sessionId, readOnly, maxSteps, stepLimitBehavior, delegationDepth, systemPrompt, onEvent }) => {
    const depth: 1 = delegationDepth;
    const policy: 'summarize' = stepLimitBehavior;
    console.log(sessionId, readOnly, maxSteps, depth, policy, systemPrompt, onEvent);
    return session;
  }
});
const completed: 'completed' = result.status;
const summarized: boolean = result.stepLimitReached;
const tools: AgentTool[] = createDelegationTools(async (_callId, args, signal, onUpdate) => {
  signal.throwIfAborted(); onUpdate?.({ content: [{ type: 'text', text: `${args.role} ${args.files?.join(',') ?? ''} ${args.includeConversation === true}` }] });
  return { content: [{ type: 'text', text: args.task }], details: { status: completed } };
});
const failure = new DelegationError('Unknown result', 'delegation_unresolved');
failure.details = { cleanupUncertain: true };
// @ts-expect-error role must be a built-in role
await runDelegatedAgent({ role: 'arbitrary', task: 'work', sessionId: 'child', signal: cancellation.signal, createChild: async () => session });
// @ts-expect-error explicit cancellation signal is required
await runDelegatedAgent({ role: 'scout', task: 'inspect', sessionId: 'child', createChild: async () => session });
// @ts-expect-error child factory must return a Session
await runDelegatedAgent({ role: 'scout', task: 'inspect', sessionId: 'child', signal: cancellation.signal, createChild: async () => 'not a session' });
console.log(tools, result.usage.totalTokens, steps, excerpt, summarized);
// @ts-expect-error the attached words are a list of the user's messages
await runDelegatedAgent({ role: 'scout', task: 'inspect', sessionId: 'child', signal: cancellation.signal, conversation: 'text', createChild: async () => session });

// agent_merge (worktree isolation, 0.63): one more control handler, and the fixed names and texts.
const reply = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const control: DelegationControlHandlers = {
  status: async () => reply('{}'), message: async ({ callId }) => reply(callId), wait: async () => reply('{}'), cancel: async ({ agentId }) => reply(agentId),
  merge: async ({ agentId, changeId, action, path, page, take, callId }, signal) => { signal.throwIfAborted(); return reply(JSON.stringify({ agentId, changeId, action, path, page, take: take?.map(item => `${item.path}:${item.side}`), callId })); }
};
const withMerge: AgentTool[] = createDelegationTools(async () => reply('started'), control);
const merger: AgentTool = agentMergeTool(async (args: AgentMergeArgs & { callId: string }) => reply(args.callId));
const mergeName: 'agent_merge' = AGENT_MERGE_TOOL_NAME, lastName: 'agent_merge' = DELEGATION_TOOL_NAMES[6], firstAction: 'merge' = AGENT_MERGE_ACTIONS[0];
const texts: string[] = [AGENT_MERGE_TEXT, DELEGATE_ISOLATION_TEXT];
const takeArgs: AgentMergeArgs = { agentId: 'agent-1', action: 'take', take: [{ path: 'a.png', side: 'incoming' }] };
// @ts-expect-error a side is current or incoming
const badSide: AgentMergeArgs = { agentId: 'agent-1', action: 'take', take: [{ path: 'a.png', side: 'theirs' }] };
// @ts-expect-error the five actions only
const badAction: AgentMergeArgs = { agentId: 'agent-1', action: 'apply' };
// @ts-expect-error a control set without merge is incomplete
const incomplete: DelegationControlHandlers = { status: control.status, message: control.message, wait: control.wait, cancel: control.cancel };
// An isolated worktree's tools: sandboxed commands that may not write the project folder.
const sandboxed = await createWorkspaceTools('/tmp/worktree', { includeMutations: true, sandbox: true, sandboxExtra: ['/tmp/cache'], sandboxDeny: ['/tmp/project'] });
// @ts-expect-error the deny list is a list of paths
await createWorkspaceTools('/tmp/worktree', { sandboxDeny: '/tmp/project' });
console.log(withMerge, merger, mergeName, lastName, firstAction, texts, takeArgs, badSide, badAction, incomplete, sandboxed);
