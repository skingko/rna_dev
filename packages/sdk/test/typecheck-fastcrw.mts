import { createFastCrwTools, normalizeFastCrwBaseUrl, FastCrwError, type FastCrwToolsOptions, type AgentTool } from '@rna-agent/sdk';

const transport: typeof fetch = (input, init) => fetch(input, init);
const options: FastCrwToolsOptions = {
  baseUrl: normalizeFastCrwBaseUrl('https://example.test/v1'), apiKey: 'type-fixture',
  timeoutMs: 30000, maxResponseBytes: 2097152, maxContentChars: 40000, fetchImpl: transport,
};
const tools: AgentTool[] = createFastCrwTools(options);
const controller = new AbortController();
void tools[0]?.execute('call', { query: 'source', limit: 3, sources: ['web', 'news'] }, controller.signal);
void tools[1]?.execute('fetch', { url: 'https://example.test/source', maxChars: 1000 }, controller.signal);
const error: Error = new FastCrwError('FASTCRW_TIMEOUT', { timeoutMs: 30000 });
if (error instanceof FastCrwError) {
  const code: string = error.code;
  const details: Record<string, unknown> = error.details;
  void code; void details;
}
// @ts-expect-error An explicit configured service URL is required.
createFastCrwTools();
// @ts-expect-error The credential is a string, not a browser storage object.
createFastCrwTools({ baseUrl: 'https://example.test', apiKey: { value: 'x' } });
// @ts-expect-error Milliseconds must be a number.
createFastCrwTools({ baseUrl: 'https://example.test', timeoutMs: '30000' });
// @ts-expect-error Request headers cannot be injected through configuration.
createFastCrwTools({ baseUrl: 'https://example.test', headers: { Authorization: 'x' } });
// @ts-expect-error Response-body size limits are numeric bytes.
createFastCrwTools({ baseUrl: 'https://example.test', maxResponseBytes: false });
// @ts-expect-error Base URL normalization takes a string.
normalizeFastCrwBaseUrl(123);
