import { reflectProjectLearning, decideInitiative, resolveCompletionTimeoutPolicy, type ModelConfig, type LearningEpisode, type LearningRequestReceipt, type CompletionTimeoutPolicy } from '@rna-agent/sdk';
import { iterateCompletion, streamCompletion, resolveCompletionTimeoutPolicy as providerPolicy } from '@rna-agent/sdk/providers';
declare const model: ModelConfig;
declare const episodes: LearningEpisode[];
const policy: CompletionTimeoutPolicy = resolveCompletionTimeoutPolicy({ idleTimeoutMs: 120000, totalTimeoutMs: 900000 });
const samePolicy = providerPolicy();
const review = await reflectProjectLearning({ model, episodes, timeoutMs: 250000, idleTimeoutMs: 120000, totalTimeoutMs: 900000, requestControl: { onUsage(receipt: LearningRequestReceipt) { const hard: number | undefined = receipt.timeoutPolicy?.totalTimeoutMs; console.log(hard); } } });
const choice = await decideInitiative({ model, policy: { decisionTimeoutMs: 250000 } });
if (choice.status === 'decided') { const hard: number = choice.timeoutPolicy.totalTimeoutMs; console.log(hard); }
const stream = iterateCompletion(streamCompletion, { model, messages: [], idleTimeoutMs: 120000, totalTimeoutMs: 900000 }, { timeoutMs: 250000 });
// @ts-expect-error only bounded numeric timeout policy metadata is public
policy.privateResponse = 'no';
// @ts-expect-error deadline configuration is in milliseconds
resolveCompletionTimeoutPolicy({ totalTimeoutMs: '15min' });
console.log(review.request.timeoutPolicy, samePolicy, stream);
