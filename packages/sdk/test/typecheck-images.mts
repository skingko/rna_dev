import { createSession, buildRequest, normalizeImage, prepareContext, type ImageBlock, type ImageOffload, type ModelConfig, type Message, type SessionEvent } from '../src/index.js';
const image: ImageBlock = { type: 'image', mimeType: 'image/png', data: 'base64' };
const model: ModelConfig = { providerId: 'fixture', modelId: 'vision', protocol: 'openai', baseUrl: 'https://example.test/v1', input: ['text', 'image'], contextWindow: 64000, maxOutputTokens: 1000 };
const messages: Message[] = [{ role: 'user', content: [image] }, { role: 'toolResult', toolCallId: 'x', content: [image] }];
buildRequest({ model, messages }); normalizeImage(image);
async function use() { const session = await createSession({ model, stateDir: '/tmp/typecheck-only' }); await session.prompt('Inspect', { images: [image] }); await session.dispose(); }
void use;
// @ts-expect-error Raw URLs are deliberately not supported image inputs.
const remote: ImageBlock = { type: 'image', mimeType: 'image/png', url: 'https://example.test/image.png' };
// @ts-expect-error SVG is not a permitted pixel image format.
const svg: ImageBlock = { type: 'image', mimeType: 'image/svg+xml', data: 'base64' };
void remote; void svg;
const offload: ImageOffload = { id: 'projection', reason: 'request-image-budget', targets: [{ messageId: 'old', imageIndexes: [0] }], before: { count: 17, bytes: 100 }, after: { count: 16, bytes: 90 } };
const event: SessionEvent = { type: 'image_offload', ...offload, sessionId: 'session', seq: 1, time: '2026-09-27' };
prepareContext({ sessionId: 'session', messages, imageOffloadId: offload.id, imageOffloads: new Map([['old', new Set([0])]]) });
void event;
