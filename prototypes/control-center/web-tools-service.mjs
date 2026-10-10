import { createWebTools, WEB_PROVIDERS, WEB_TOOL_DECLARATIONS } from '../../packages/sdk/src/web-providers.mjs';

const unavailable = () => ({ isError: true, content: [{ type: 'text', text: '全局联网工具已关闭，请在设置中开启联网搜索与抓取。' }], details: { code: 'WEB_TOOLS_DISABLED', executed: false } });
const closed = () => ({ isError: true, content: [{ type: 'text', text: '联网服务正在关闭；本次请求未执行。' }], details: { code: 'WEB_TOOLS_CLOSED', executed: false } });
/** The configured web search service, 'fastcrw' for a configuration saved before there was a choice. */
export const webProviderOf = config => (Object.hasOwn(WEB_PROVIDERS, config?.provider) ? config.provider : 'fastcrw');
/** Global read capabilities, independent of project capability assignments.
 * Credentials/configuration are resolved at execution, never embedded in a
 * model-visible descriptor or a pinned conversation's tool closure. The two
 * tools read the same to the model whichever service is configured.
 */
export class WebToolsService {
  constructor(store, { fetchImpl, directFetch } = {}) {
    this.store = store; this.fetchImpl = fetchImpl; this.directFetch = directFetch; this.controllers = new Set(); this.closed = false;
    this.descriptors = WEB_TOOL_DECLARATIONS.map(tool => ({ ...tool, enabled: true, trusted: true, permission: 'read', effect: 'read', idempotent: true, execute: (id, args, signal) => this.execute(tool.name, id, args, signal) }));
  }
  enabled() { return !this.closed && this.store.state.configuration?.webTools?.enabled === true; }
  revision() { return this.enabled() ? 'web-tools-enabled-v2' : 'web-tools-disabled-v2'; }
  tools() { return this.enabled() ? this.descriptors : []; }
  async execute(name, id, args, signal, { connectionTest = false } = {}) {
    signal?.throwIfAborted(); if (this.closed) return closed(); if (!this.enabled() && !connectionTest) return unavailable();
    const controller = new AbortController(); this.controllers.add(controller);
    try {
      const config = { ...this.store.state.configuration.webTools }, provider = webProviderOf(config);
      const apiKey = this.store.configurationService.secret('webTools', config);
      // Resolve the live credential, then recheck revocation/configuration at
      // dispatch. A retained descriptor must not use a revoked configuration.
      const current = () => { const now = this.store.state.configuration.webTools; return !this.closed && (connectionTest || this.enabled()) && webProviderOf(now) === provider && now.baseUrl === config.baseUrl && now.timeoutMs === config.timeoutMs && this.store.configurationService.secret('webTools', now) === apiKey; };
      const fetchImpl = (url, options) => { if (!current()) controller.abort(); controller.signal.throwIfAborted(); return (this.fetchImpl ?? globalThis.fetch)(url, options); };
      const tools = createWebTools({ provider, baseUrl: config.baseUrl, timeoutMs: config.timeoutMs, apiKey, fetchImpl,
        // A service that only searches has web_fetch read the page from this machine; the same revocation check applies.
        ...(this.directFetch ? { directFetch: (url, options) => { if (!current()) controller.abort(); controller.signal.throwIfAborted(); return this.directFetch(url, options); } } : {}) });
      return await tools.find(tool => tool.name === name).execute(id, args, AbortSignal.any([controller.signal, signal].filter(Boolean)));
    } finally { this.controllers.delete(controller); }
  }
  async test({ signal } = {}) {
    const checks = [], provider = webProviderOf(this.store.state.configuration.webTools);
    for (const [name, args] of [['web_search', { query: 'example domain', limit: 1 }], ['web_fetch', { url: 'https://example.com/', maxChars: 1000 }]]) {
      const result = await this.execute(name, 'connection-check', args, signal, { connectionTest: true });
      checks.push({ tool: name, ok: !result.isError, ...(result.isError ? { code: result.details?.code ?? 'WEB_TOOLS_UNAVAILABLE', message: result.details?.message ?? '联网服务未通过检查。' } : {}) });
      // A rejected key or an empty account fails every request the same way.
      if (['FASTCRW_AUTH', 'WEB_AUTH', 'WEB_QUOTA', 'WEB_TOOLS_CLOSED'].includes(result.details?.code)) break;
    }
    const failed = checks.find(check => !check.ok);
    return { ok: !failed && checks.length === 2, provider, service: WEB_PROVIDERS[provider].label, reader: WEB_PROVIDERS[provider].reader, checks, ...(failed ? { code: failed.code, message: failed.message } : {}), testedTools: checks.filter(check => check.ok).map(check => check.tool) };
  }
  close() { this.closed = true; for (const controller of this.controllers) controller.abort(); this.controllers.clear(); }
}
