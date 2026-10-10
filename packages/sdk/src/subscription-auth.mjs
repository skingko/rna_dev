import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

/** Authentication protocol references: mu 1272e53, MIT (see docs/research/mu-subscription-reference-20260927.md).
 * Credentials are returned only through explicit private APIs; public flows contain no bearer or refresh tokens. */
export const SUBSCRIPTION_PROVIDERS = Object.freeze([
  Object.freeze({ id: 'openai-codex', name: 'OpenAI Codex / ChatGPT', methods: ['browser', 'device_code'], protocol: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api', documentation: 'https://developers.openai.com/codex/auth' }),
  Object.freeze({ id: 'kimi-coding', name: 'Kimi Code', methods: ['coding_plan_key'], protocol: 'anthropic', baseUrl: 'https://api.kimi.com/coding', compatibility: 'Third-party access uses a Coding Plan key; OAuth is reserved for official clients.', interactiveOnly: true, documentation: 'https://www.kimi.com/en/help/kimi-code/membership-guide' }),
  Object.freeze({ id: 'zhipu-coding', name: '智谱 GLM Coding Plan', methods: ['coding_plan_key'], protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', documentation: 'https://docs.bigmodel.cn/cn/coding-plan/overview' }),
  Object.freeze({ id: 'zai-coding', name: 'Z.AI GLM Coding Plan', methods: ['coding_plan_key'], protocol: 'openai', baseUrl: 'https://api.z.ai/api/coding/paas/v4', documentation: 'https://zcode.z.ai/en/docs/configuration' }),
  Object.freeze({ id: 'anthropic', name: 'Anthropic', methods: ['api_key'], subscriptionStatus: 'official_client_only', documentation: 'https://code.claude.com/docs/en/legal-and-compliance' }),
]);
const OPENAI = 'https://auth.openai.com';
const CLIENTS = { 'openai-codex': 'app_EMoamEEZ73f0CkXaXp7hrann' };
const REDIRECT = 'http://localhost:1455/auth/callback';
const sensitiveString = value => typeof value === 'string' && value.length > 0 && value.length < 32768 && !/[\r\n\0]/.test(value);
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export class SubscriptionAuthError extends Error {
  constructor(message, code = 'auth_error', status) { super(message); this.name = 'SubscriptionAuthError'; this.code = code; if (status) this.status = status; }
}
const aborted = () => new SubscriptionAuthError('订阅登录已取消', 'aborted');
function accountId(token) {
  try { const value = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())['https://api.openai.com/auth']?.chatgpt_account_id; return sensitiveString(value) ? value : undefined; } catch { return undefined; }
}
function credential(provider, body, now, previous) {
  if (!sensitiveString(body?.access_token) || !sensitiveString(body.refresh_token ?? previous?.refreshToken) || !Number.isFinite(body.expires_in) || body.expires_in <= 0 || body.expires_in > 365 * 86400) throw new SubscriptionAuthError('订阅服务返回了不完整的登录凭据', 'invalid_response');
  const result = { provider, accessToken: body.access_token, refreshToken: body.refresh_token ?? previous.refreshToken, expiresAt: now + body.expires_in * 1000 };
  if (provider === 'openai-codex') { result.accountId = accountId(result.accessToken); if (!result.accountId) throw new SubscriptionAuthError('登录凭据缺少 ChatGPT 账户标识', 'invalid_response'); }
  return result;
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => { if (signal.aborted) return reject(aborted()); const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); }; const cancel = () => { finish(); reject(aborted()); }; const timer = setTimeout(() => { finish(); resolve(); }, ms); signal.addEventListener('abort', cancel, { once: true }); });
}

export class SubscriptionAuthManager {
  #read; #write; #fetch; #now; #change; #flows = new Map(); #refreshes = new Map(); #generations = new Map(); #writes = new Map(); #refreshControllers = new Map(); #closed = false; #sleep;
  constructor({ readCredential, writeCredential, fetch: fetcher = globalThis.fetch, now = Date.now, onChange = () => {}, sleep: sleeper = sleep } = {}) {
    if (typeof readCredential !== 'function' || typeof writeCredential !== 'function') throw new TypeError('Credential read/write callbacks are required.');
    this.#read = readCredential; this.#write = writeCredential; this.#fetch = fetcher; this.#now = now; this.#change = onChange; this.#sleep = sleeper;
  }
  #publish(flow, patch) { Object.assign(flow.public, patch); if (flow.public.status !== 'pending') { delete flow.public.url; delete flow.public.userCode; delete flow.public.verificationUri; } try { Promise.resolve(this.#change(structuredClone(flow.public))).catch(() => {}); } catch {} }
  flow(id) { const flow = this.#flows.get(id); return flow ? structuredClone(flow.public) : null; }
  async #request(url, fields, signal, json = false) {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    let response, reader;
    const wait = async promise => {
      requestSignal.throwIfAborted(); let cancel;
      try { return await Promise.race([promise, new Promise((_, reject) => { cancel = () => reject(aborted()); requestSignal.addEventListener('abort', cancel, { once: true }); })]); }
      finally { requestSignal.removeEventListener('abort', cancel); }
    };
    try {
      const pending = Promise.resolve(this.#fetch(url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' }, body: json ? JSON.stringify(fields) : new URLSearchParams(fields), redirect: 'manual', signal: requestSignal }));
      void pending.then(late => { if (requestSignal.aborted) void late.body?.cancel().catch(() => {}); }, () => {});
      response = await wait(pending);
      if (response.status >= 300 && response.status < 400) throw new SubscriptionAuthError('订阅认证服务重定向被拒绝', 'redirect_rejected', response.status);
      if (!response.body) throw new SubscriptionAuthError('订阅认证服务返回空响应', 'invalid_response', response.status);
      reader = response.body.getReader(); const chunks = []; let length = 0;
      while (true) { const { value, done } = await wait(reader.read()); if (done) break; length += value.byteLength; if (length > 131072) throw new SubscriptionAuthError('订阅认证响应超过大小上限', 'invalid_response'); chunks.push(value); }
      let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(); } catch { throw new SubscriptionAuthError('订阅认证服务返回了无效响应', 'invalid_response', response.status); }
      return { response, data };
    } catch (error) {
      if (signal.aborted) throw aborted();
      if (requestSignal.aborted) throw new SubscriptionAuthError('订阅认证请求超时', 'auth_timeout');
      if (error instanceof SubscriptionAuthError) throw error;
      throw new SubscriptionAuthError('无法连接订阅认证服务', 'connection');
    } finally { if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); } else if (response?.body) void response.body.cancel().catch(() => {}); }
  }
  async #exchange(provider, fields, signal, previous) {
    const { response, data } = await this.#request(`${OPENAI}/oauth/token`, { client_id: CLIENTS[provider], ...fields }, signal);
    if (!response.ok) throw new SubscriptionAuthError(response.status === 401 || response.status === 403 || data?.error === 'invalid_grant' ? '订阅登录已失效，请重新登录' : `订阅认证失败（HTTP ${response.status}）`, response.status === 401 || response.status === 403 || data?.error === 'invalid_grant' ? 'reauth_required' : 'http_error', response.status);
    const result = credential(provider, data, this.#now(), previous);
    if (previous?.accountId && result.accountId !== previous.accountId) throw new SubscriptionAuthError('订阅账户发生变化，请重新登录确认', 'reauth_required');
    return result;
  }
  async begin(provider, { method = 'browser', signal } = {}) {
    if (this.#closed) throw new SubscriptionAuthError('订阅认证服务已关闭', 'auth_closed');
    if (!CLIENTS[provider] || !['browser', 'device_code'].includes(method)) throw new SubscriptionAuthError('该供应商不支持此订阅登录方式', 'unsupported_auth');
    for (const flow of this.#flows.values()) if (flow.public.provider === provider && flow.public.status === 'pending') this.cancel(flow.public.flowId);
    // Bound public history and never retain a completed flow's verifier/device secret.
    for (const [id, flow] of this.#flows) if (flow.public.status !== 'pending' && (this.#flows.size >= 24 || flow.public.expiresAt < this.#now())) this.#flows.delete(id);
    this.#generations.set(provider, (this.#generations.get(provider) ?? 0) + 1);
    const controller = new AbortController(), id = randomBytes(18).toString('base64url');
    const flow = { public: { flowId: id, provider, method, status: 'pending', expiresAt: this.#now() + 15 * 60000 }, controller, generation: this.#generations.get(provider) ?? 0 };
    this.#flows.set(id, flow);
    flow.abort = () => this.cancel(id); signal?.addEventListener('abort', flow.abort, { once: true }); flow.externalSignal = signal;
    flow.timer = setTimeout(() => { this.#publish(flow, { status: 'expired', error: '登录已超时，请重新开始' }); this.#cleanup(flow); }, 15 * 60000); flow.timer.unref?.();
    if (signal?.aborted) { this.cancel(id); return this.flow(id); }
    try {
      if (method === 'browser') {
        flow.verifier = randomBytes(32).toString('base64url'); flow.state = randomBytes(32).toString('base64url');
        const url = new URL(`${OPENAI}/oauth/authorize`);
        for (const [key, value] of Object.entries({ response_type: 'code', client_id: CLIENTS[provider], redirect_uri: REDIRECT, scope: 'openid profile email offline_access', code_challenge: createHash('sha256').update(flow.verifier).digest('base64url'), code_challenge_method: 'S256', state: flow.state, id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'rna-agent' })) url.searchParams.set(key, value);
        await this.#listen(flow); this.#publish(flow, { url: url.href, callback: REDIRECT, manualCallback: !flow.server });
      } else {
        const { response, data } = await this.#request(`${OPENAI}/api/accounts/deviceauth/usercode`, { client_id: CLIENTS[provider] }, controller.signal, true);
        if (!response.ok) throw new SubscriptionAuthError(`订阅设备登录不可用（HTTP ${response.status}）`, 'http_error', response.status);
        flow.device = data.device_auth_id;
        if (!sensitiveString(flow.device) || !sensitiveString(data.user_code)) throw new SubscriptionAuthError('设备登录响应缺少验证码', 'invalid_response');
        const interval = Math.min(60, Math.max(1, Number(data.interval) || 5));
        const expiresIn = Math.min(900, Math.max(1, Number(data.expires_in) || 900));
        this.#publish(flow, { userCode: data.user_code, verificationUri: `${OPENAI}/codex/device`, intervalSeconds: interval, expiresAt: this.#now() + expiresIn * 1000 });
        void this.#poll(flow, interval).catch(error => this.#fail(flow, error));
      }
      return this.flow(id);
    } catch (error) { this.#fail(flow, error); throw error; }
  }
  async #listen(flow) {
    const server = createServer(async (req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      try {
        const url = new URL(req.url, REDIRECT);
        if (req.method !== 'GET' || url.pathname !== '/auth/callback') { res.writeHead(404); res.end('Not found'); return; }
        if (!equal(url.searchParams.get('state'), flow.state)) { res.writeHead(400); res.end('Invalid OAuth state'); return; }
        await this.complete(flow.public.flowId, { callbackUrl: url.href }); res.end('<!doctype html><meta charset="utf-8"><title>Rna Agent</title><p>登录成功，可以关闭此页面并返回 Rna Agent。</p>');
      } catch { res.writeHead(400); res.end('Login failed. Return to Rna Agent to retry.'); }
    });
    await new Promise(resolve => { server.once('error', () => { server.close(); resolve(); }); server.listen(1455, '127.0.0.1', () => { flow.server = server; resolve(); }); });
    if (flow.public.status !== 'pending') server.close();
  }
  async complete(id, { callbackUrl } = {}) {
    const flow = this.#flows.get(id); if (!flow || flow.public.status !== 'pending' || flow.public.method !== 'browser') throw new SubscriptionAuthError('没有等待浏览器回调的登录流程', 'invalid_flow');
    if (this.#now() >= flow.public.expiresAt) { this.#publish(flow, { status: 'expired', error: '登录已超时，请重新开始' }); this.#cleanup(flow); throw new SubscriptionAuthError('登录已超时，请重新开始', 'expired_token'); }
    if (flow.exchange) return flow.exchange;
    let url; try { url = new URL(callbackUrl); } catch { throw new SubscriptionAuthError('请粘贴完整的登录回调地址', 'invalid_callback'); }
    if (url.origin !== new URL(REDIRECT).origin || url.pathname !== '/auth/callback' || !equal(url.searchParams.get('state'), flow.state)) throw new SubscriptionAuthError('登录回调的地址或校验状态不匹配', 'invalid_callback');
    if (url.searchParams.get('error')) { this.cancel(id); throw new SubscriptionAuthError('订阅登录未获授权', 'access_denied'); }
    const code = url.searchParams.get('code'); if (!sensitiveString(code)) throw new SubscriptionAuthError('登录回调缺少授权码', 'invalid_callback');
    flow.exchange = (async () => { try { const value = await this.#exchange(flow.public.provider, { grant_type: 'authorization_code', code, code_verifier: flow.verifier, redirect_uri: REDIRECT }, flow.controller.signal); await this.#save(flow, value); return this.flow(id); } catch (error) { this.#fail(flow, error); throw error; } })();
    return flow.exchange;
  }
  async #poll(flow, interval) {
    const provider = flow.public.provider, signal = flow.controller.signal;
    while (flow.public.status === 'pending' && this.#now() < flow.public.expiresAt) {
      await this.#sleep(interval * 1000, signal); if (this.#now() >= flow.public.expiresAt) break;
      const { response, data } = await this.#request(`${OPENAI}/api/accounts/deviceauth/token`, { device_auth_id: flow.device, user_code: flow.public.userCode }, signal, true);
      if (response.ok) {
        let value;
        { if (!sensitiveString(data.authorization_code) || !sensitiveString(data.code_verifier)) throw new SubscriptionAuthError('设备授权响应不完整', 'invalid_response'); value = await this.#exchange(provider, { grant_type: 'authorization_code', code: data.authorization_code, code_verifier: data.code_verifier, redirect_uri: `${OPENAI}/deviceauth/callback` }, signal); }
        await this.#save(flow, value); return;
      }
      const error = typeof data?.error === 'string' ? data.error : data?.error?.code;
      if (error === 'slow_down') { interval = Math.min(60, interval + 5); this.#publish(flow, { intervalSeconds: interval }); continue; }
      if ([403, 404].includes(response.status) || ['authorization_pending', 'deviceauth_authorization_pending'].includes(error)) continue;
      throw new SubscriptionAuthError(error === 'access_denied' ? '订阅登录未获授权' : error === 'expired_token' ? '设备验证码已过期' : `设备登录失败（HTTP ${response.status}）`, ['access_denied', 'expired_token'].includes(error) ? error : 'http_error', response.status);
    }
    if (flow.public.status === 'pending') { this.#publish(flow, { status: 'expired', error: '设备验证码已过期' }); this.#cleanup(flow); }
  }
  #persist(provider, value, metadata, { generation, signal } = {}) {
    const current = () => !this.#closed && !signal?.aborted && (generation === undefined || (this.#generations.get(provider) ?? 0) === generation);
    const prior = this.#writes.get(provider) ?? Promise.resolve();
    const write = prior.catch(() => {}).then(async () => {
      if (!current()) throw aborted();
      const previous = await this.#read(provider);
      if (!current()) throw aborted();
      try { await this.#write(provider, value, metadata); }
      catch { throw new SubscriptionAuthError('无法安全保存订阅凭据，请重试登录', 'credential_storage_failed'); }
      // A user can cancel or log out while an asynchronous sink is committing.
      // Restore its previous state before releasing the queue; a queued logout
      // then writes null last, and a later login cannot be overwritten.
      if (!current()) {
        try { await this.#write(provider, previous ?? null, { operation: 'rollback' }); }
        catch { throw new SubscriptionAuthError('订阅凭据写入未能确认撤销，请退出登录后重试', 'credential_storage_failed'); }
        throw aborted();
      }
    });
    this.#writes.set(provider, write);
    void write.then(() => { if (this.#writes.get(provider) === write) this.#writes.delete(provider); }, () => { if (this.#writes.get(provider) === write) this.#writes.delete(provider); });
    return write;
  }
  async #save(flow, value) {
    if (flow.public.status !== 'pending') throw aborted();
    await this.#persist(value.provider, value, { operation: 'login' }, { generation: flow.generation, signal: flow.controller.signal });
    this.#publish(flow, { status: 'complete', accountId: value.accountId }); this.#cleanup(flow);
  }
  #fail(flow, error) { if (flow.public.status !== 'pending') return; this.#publish(flow, { status: 'error', error: error instanceof SubscriptionAuthError ? error.message : '订阅登录失败，请重试', errorCode: error instanceof SubscriptionAuthError ? error.code : 'auth_error' }); this.#cleanup(flow); }
  #cleanup(flow) { clearTimeout(flow.timer); flow.externalSignal?.removeEventListener('abort', flow.abort); flow.controller.abort(); flow.server?.close(); delete flow.server; delete flow.verifier; delete flow.state; delete flow.device; delete flow.public.url; delete flow.public.userCode; delete flow.public.verificationUri; }
  cancel(id) { const flow = this.#flows.get(id); if (flow?.public.status === 'pending') { if ((this.#generations.get(flow.public.provider) ?? 0) === flow.generation) this.#generations.set(flow.public.provider, flow.generation + 1); this.#publish(flow, { status: 'cancelled' }); this.#cleanup(flow); } return this.flow(id); }
  async logout(provider) { if (this.#closed) throw new SubscriptionAuthError('订阅认证服务已关闭', 'auth_closed'); this.#refreshControllers.get(provider)?.abort(); this.#generations.set(provider, (this.#generations.get(provider) ?? 0) + 1); for (const flow of this.#flows.values()) if (flow.public.provider === provider) this.cancel(flow.public.flowId); await this.#persist(provider, null, { operation: 'logout' }); }
  async credential(provider, { signal, forceRefresh = false } = {}) {
    if (this.#closed) throw new SubscriptionAuthError('订阅认证服务已关闭', 'auth_closed');
    if (!CLIENTS[provider]) throw new SubscriptionAuthError('不支持的订阅认证供应商', 'unsupported_auth');
    signal?.throwIfAborted(); const value = await this.#read(provider);
    if (!value || value.provider !== provider || !sensitiveString(value.accessToken) || !sensitiveString(value.refreshToken) || !Number.isFinite(value.expiresAt)) throw new SubscriptionAuthError('请先登录订阅账户', 'reauth_required');
    if (!forceRefresh && value.expiresAt > this.#now() + 60000) return structuredClone(value);
    let pending = this.#refreshes.get(provider);
    if (!pending) {
      const generation = this.#generations.get(provider) ?? 0, controller = new AbortController(); this.#refreshControllers.set(provider, controller);
      pending = (async () => { try { const result = await this.#exchange(provider, { grant_type: 'refresh_token', refresh_token: value.refreshToken }, controller.signal, value); if ((this.#generations.get(provider) ?? 0) !== generation) throw aborted(); await this.#persist(provider, result, { operation: 'refresh' }, { generation }); return result; } catch (error) { if (error.code === 'reauth_required' && (this.#generations.get(provider) ?? 0) === generation) await this.#persist(provider, null, { operation: 'invalidated' }, { generation }); throw error; } finally { this.#refreshes.delete(provider); if (this.#refreshControllers.get(provider) === controller) this.#refreshControllers.delete(provider); } })();
      this.#refreshes.set(provider, pending);
    }
    if (!signal) return structuredClone(await pending);
    let cancel; try { return structuredClone(await Promise.race([pending, new Promise((_, reject) => { cancel = () => reject(aborted()); signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel(); })])); } finally { signal.removeEventListener('abort', cancel); }
  }
  close() { this.#closed = true; for (const provider of Object.keys(CLIENTS)) this.#generations.set(provider, (this.#generations.get(provider) ?? 0) + 1); for (const controller of this.#refreshControllers.values()) controller.abort(); for (const flow of this.#flows.values()) this.cancel(flow.public.flowId); }
}

/** Per-request credentials stay in this closure, never in the durable model snapshot. */
export function createSubscriptionCompletion({ resolveCredential } = {}) {
  if (typeof resolveCredential !== 'function') throw new TypeError('resolveCredential is required.');
  return async function* subscriptionCompletion(input) {
    const { streamCompletion } = await import('./providers.mjs');
    const provider = input.model?.subscriptionProvider ?? (input.model?.protocol === 'openai-codex' ? 'openai-codex' : undefined);
    if (!provider) { yield* streamCompletion(input); return; }
    yield* streamCompletion({ ...input, apiKey: options => resolveCredential(provider, options) });
  };
}
