import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { SubscriptionAuthManager } from '../../packages/sdk/src/subscription-auth.mjs';

const fail = (message, status = 400, code = 'SUBSCRIPTION_AUTH') => { throw Object.assign(new Error(message), { status, code }); };
export const CODEX_ENDPOINT = 'https://chatgpt.com/backend-api';
const validSecret = value => typeof value === 'string' && value.length > 0 && value.length < 32768 && !/[\r\n\0]/u.test(value);
export const subscriptionAuthCatalog = () => [
  { id: 'openai-codex', name: 'OpenAI · ChatGPT / Codex', supported: true, methods: ['browser', 'device_code'], protocol: 'openai-codex', baseUrl: CODEX_ENDPOINT, description: '通过浏览器或设备码登录。模型和使用额度由你的 ChatGPT 账户决定，独立于 API Key 计费。' },
  // Anthropic's terms (2026-02-19) allow Free/Pro/Max logins only in Claude Code and Claude.ai; third-party apps,
  // including ones driving the official client, are not permitted. Claude is used here with an API key.
  { id: 'anthropic', name: 'Anthropic · Claude 订阅', supported: false, methods: [], reason: 'Anthropic 只允许在 Claude Code 和 Claude.ai 中使用 Claude 订阅登录，第三方应用（包括驱动官方 Claude Code 的应用）不在允许范围内。在 Rna 中使用 Claude 请添加 Anthropic API Key，按用量计费。', alternative: 'anthropic-api-key' },
  { id: 'kimi-coding', name: 'Kimi Coding 订阅', supported: false, methods: ['coding_plan_key'], interactiveOnly: true, reason: 'Kimi Coding 套餐 Key 可用于交互聊天；后台主动协作与进化使用独立的开放平台 API Key。' }
];

/** One SDK manager per configured account; tokens and pending login secrets
 * never enter configuration, project snapshots, events or public flow status. */
export class SubscriptionAuthService {
  constructor(configuration, { managerFactory = options => new SubscriptionAuthManager(options), now = Date.now, fetch: fetcher } = {}) {
    this.configuration = configuration; this.file = `${configuration.store.file}.subscriptions`; this.managerFactory = managerFactory; this.now = now; this.fetch = fetcher;
    this.managers = new Map(); this.flows = new Map(); this.generations = new Map(); this.closed = false;
    try { const stat = lstatSync(this.file); if (!stat.isFile() || stat.isSymbolicLink()) fail('订阅凭据路径必须是普通文件。', 500); this.records = JSON.parse(readFileSync(this.file, 'utf8')); chmodSync(this.file, 0o600); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('订阅凭据文件无法安全读取；请检查文件格式与权限。'); this.records = {}; }
    if (!this.records || typeof this.records !== 'object' || Array.isArray(this.records)) throw new Error('订阅凭据文件格式无效。');
    for (const value of Object.values(this.records)) { this.validateCredential(value.credential); if (typeof value.revision !== 'string') throw new Error('订阅凭据版本无效。'); }
  }
  validateCredential(value) {
    if (!value || value.provider !== 'openai-codex' || !validSecret(value.accessToken) || !validSecret(value.refreshToken) || !validSecret(value.accountId) || !Number.isFinite(value.expiresAt) || value.expiresAt <= 0) fail('订阅服务未返回完整的授权凭据。', 502);
    return { provider: value.provider, accessToken: value.accessToken, refreshToken: value.refreshToken, accountId: value.accountId, expiresAt: value.expiresAt };
  }
  provider(id) { return this.configuration.store.state.configuration.providers.find(row => row.id === id) ?? fail('供应商不存在。', 404); }
  requireSubscription(id) {
    const p = this.provider(id);
    if (p.authMode !== 'subscription' || p.authProvider !== 'openai-codex' || p.protocol !== 'openai-codex' || p.baseUrl !== CODEX_ENDPOINT) fail('此提供商尚未配置受支持的订阅登录。');
    return p;
  }
  write(records) {
    if (this.closed) fail('订阅服务已关闭。', 503);
    const temporary = `${this.file}.tmp-${process.pid}-${randomUUID()}`;
    try { writeFileSync(temporary, JSON.stringify(records), { mode: 0o600, flag: 'wx' }); chmodSync(temporary, 0o600); renameSync(temporary, this.file); }
    finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    this.records = records;
  }
  catalog() { return subscriptionAuthCatalog(); }
  revision(id) { return this.records[id]?.revision ?? 'signed-out'; }
  secretValues() { return Object.values(this.records).flatMap(row => [row.credential.accessToken, row.credential.refreshToken]); }
  publicFlow(flow) {
    if (!flow) return {};
    const result = { attemptId: flow.flowId, method: flow.method, loginState: flow.status, loginExpiresAt: flow.expiresAt };
    for (const [from, to] of [['url', 'authorizationUrl'], ['verificationUri', 'verificationUrl']]) if (flow[from]) {
      let url; try { url = new URL(flow[from]); } catch { fail('订阅登录地址无效。', 502); }
      if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || url.username || url.password) fail('订阅登录地址不受支持。', 502);
      result[to] = url.href;
    }
    if (typeof flow.userCode === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(flow.userCode)) result.userCode = flow.userCode;
    if (flow.status === 'pending' && flow.method === 'browser') result.canPasteCallback = true;
    if (['error', 'expired'].includes(flow.status)) result.error = flow.status === 'expired' ? '登录已过期，请重新开始。' : '订阅认证未完成，请重试；未保存服务端原始错误或凭据。';
    return result;
  }
  status(id) {
    this.provider(id); const record = this.records[id], flow = this.flows.get(id), pending = flow?.status === 'pending';
    return { providerId: id, authenticated: Boolean(record), state: pending ? 'awaiting_authorization' : flow?.status === 'error' ? 'failed' : record ? 'authenticated' : 'signed_out', expiresAt: record?.credential.expiresAt ?? null, ...this.publicFlow(flow) };
  }
  manager(id) {
    this.requireSubscription(id); if (this.closed) fail('订阅服务已关闭。', 503);
    const generation = this.generations.get(id) ?? 0;
    if (!this.managers.has(id)) this.managers.set(id, this.managerFactory({ now: this.now, ...(this.fetch ? { fetch: this.fetch } : {}),
      readCredential: () => { this.requireSubscription(id); return structuredClone(this.records[id]?.credential ?? null); },
      writeCredential: (_provider, value, metadata = {}) => {
        if ((this.generations.get(id) ?? 0) !== generation) fail('凭据配置已变化，已丢弃旧授权结果。', 409);
        this.requireSubscription(id); const next = { ...this.records }, previous = next[id];
        if (value == null) delete next[id];
        else { const credential = this.validateCredential(value); next[id] = { credential, revision: metadata.operation === 'refresh' && previous?.credential.accountId === credential.accountId ? previous.revision : randomUUID(), authorizedAt: metadata.operation === 'refresh' && previous ? previous.authorizedAt : this.now() }; }
        this.write(next);
      },
      onChange: flow => { this.publicFlow(flow); this.flows.set(id, structuredClone(flow)); }
    }));
    return this.managers.get(id);
  }
  async start(id, { method = 'browser' } = {}) {
    this.requireSubscription(id); if (!['browser', 'device_code'].includes(method)) fail('登录方式必须为 browser 或 device_code。');
    try { const flow = await this.manager(id).begin('openai-codex', { method }); this.flows.set(id, flow); return this.status(id); }
    catch { fail('无法开始订阅登录，请检查网络或改用设备码登录。', 502); }
  }
  async complete(id, { attemptId, callbackUrl } = {}) {
    this.requireSubscription(id); const flow = this.flows.get(id);
    if (!flow || flow.flowId !== attemptId || flow.status !== 'pending' || flow.method !== 'browser') fail('登录流程已结束或不匹配，请重新开始。', 409);
    if (typeof callbackUrl !== 'string' || callbackUrl.length > 10000) fail('请填写浏览器返回的完整回调地址。');
    try { this.flows.set(id, await this.manager(id).complete(attemptId, { callbackUrl })); return this.status(id); }
    catch { fail('回调校验或订阅认证失败，请确认地址属于本次登录。', 400); }
  }
  cancel(id, { attemptId } = {}) {
    this.provider(id); const flow = this.flows.get(id);
    if (attemptId && flow?.flowId !== attemptId) fail('登录流程已变化，未取消其他流程。', 409);
    if (flow) this.managers.get(id)?.cancel(flow.flowId);
    return this.status(id);
  }
  async logout(id) {
    this.provider(id); const manager = this.managers.get(id);
    if (manager) await manager.logout('openai-codex');
    else { const next = { ...this.records }; delete next[id]; this.write(next); }
    this.flows.delete(id); return this.status(id);
  }
  forget(id) {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1); this.managers.get(id)?.close(); this.managers.delete(id); this.flows.delete(id);
    if (this.records[id]) { const next = { ...this.records }; delete next[id]; this.write(next); }
  }
  async resolve(id, options) { return this.manager(id).credential('openai-codex', options); }
  resolver(id) { return options => this.resolve(id, options); }
  close() { this.closed = true; for (const manager of this.managers.values()) manager.close(); this.flows.clear(); }
}
