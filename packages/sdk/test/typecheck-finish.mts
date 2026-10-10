import { createSession, type SessionOptions, type SessionEvent } from '@rna-agent/sdk';
declare const options: SessionOptions;
const session = await createSession({ ...options, maxFinishContinuations: 1, beforeFinish: ({ signal, snapshot, message, continuations, remainingContinuations }) => {
  signal.throwIfAborted();
  const pending: true | undefined = snapshot.recovery.pendingFinish;
  const phase: typeof snapshot.phase = 'reviewing';
  if (continuations || !remainingContinuations || !pending || !message.finishReviewRequired) return;
  return { feedback: [{ source: 'fixture-check', text: `Actual ${phase} evidence only.` }] };
} });
const onEvent = (event: SessionEvent) => {
  if (event.type === 'finish_review') console.log(event.status, event.continuations, event.code);
};
onEvent;
// @ts-expect-error finish checks return sourced observations, not a new permission grant
const invalid: SessionOptions['beforeFinish'] = () => ({ authorization: 'execute' });
invalid;
await session.dispose();
