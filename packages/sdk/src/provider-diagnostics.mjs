// Only these protocol identifiers may cross the provider boundary. An arbitrary
// error.code can contain echoed credentials or user data just like error.message.
const providerCodes = new Set(['1311', 'invalid_api_key', 'authentication_error', 'permission_denied', 'permission_error', 'model_not_found', 'insufficient_quota', 'rate_limit_exceeded', 'rate_limit_error', 'invalid_request_error', 'context_length_exceeded', 'overloaded_error']);
const categories = new Set(['model_access_denied', 'authentication', 'permission', 'model_unavailable', 'quota_exhausted', 'rate_limit', 'server_unavailable', 'invalid_request', 'context_limit', 'redirect_rejected', 'connection', 'timeout', 'vision_required', 'image_limit', 'image_invalid', 'provider_failure', 'refusal']);
export const safeProviderCode = value => providerCodes.has(String(value)) ? String(value) : undefined;
// A refusal's `stop_details.category` (an open set: cyber, bio, reasoning_extraction, ...): a short protocol token only.
export const safeRefusalCategory = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(value) ? value : undefined;
// What an unusable 2xx response looked like (its declared media type, or the SSE event name of a frame that was not
// JSON): protocol tokens only, so a broken stream can be told apart afterwards without keeping its content.
const RESPONSE_SHAPE = /^(?:not_sse|non_json_frame|empty_body)(?::[a-z0-9][a-z0-9.+/_-]{0,79})?$/;
export const safeResponseShape = value => typeof value === 'string' && RESPONSE_SHAPE.test(value) ? value : undefined;

/** Copy a closed diagnostic schema; never copy messages, URLs, headers or bodies. */
export function providerDiagnostic(error, purpose) {
  const source = error?.errorDiagnostic ?? error ?? {};
  const status = Number.isInteger(source.status) && source.status >= 100 && source.status <= 599 ? source.status : undefined;
  const providerCode = safeProviderCode(source.providerCode), responseShape = safeResponseShape(source.responseShape), refusalCategory = safeRefusalCategory(source.refusalCategory);
  let category = categories.has(source.category) ? source.category : undefined;
  if (!category) category = ({ image_not_supported: 'vision_required', image_capability_unknown: 'vision_required', image_limit: 'image_limit', invalid_image: 'image_invalid', context_limit: 'context_limit', connection: 'connection', idle_timeout: 'timeout', total_timeout: 'timeout', redirect_rejected: 'redirect_rejected', configuration: 'invalid_request', invalid_response: 'provider_failure', incomplete_stream: 'provider_failure', provider_incomplete: 'provider_failure', provider_protocol: 'provider_failure', stream_error: 'provider_failure', provider_error: 'provider_failure', thinking_binding: 'invalid_request' })[error?.code];
  if (!category && status) category = status === 401 ? 'authentication' : status === 403 ? 'permission' : status === 404 ? 'model_unavailable' : status === 429 ? 'rate_limit' : status >= 500 ? 'server_unavailable' : 'invalid_request';
  if (!category) return undefined;
  const selectedPurpose = purpose ?? source.purpose;
  return { ...(status ? { status } : {}), ...(providerCode ? { providerCode } : {}), ...(responseShape ? { responseShape } : {}), category, ...(category === 'refusal' && refusalCategory ? { refusalCategory } : {}), retryable: source.retryable === true, ...(['response', 'compaction'].includes(selectedPurpose) ? { purpose: selectedPurpose } : {}) };
}

export function classifyHttpFailure(status, providerCode, endpoint) {
  let category;
  // 1311 is a Coding Plan entitlement rejection despite its HTTP 429 status.
  // Bind this interpretation to the exact official route, never model names.
  const url = new URL(endpoint);
  if (providerCode === '1311' && url.protocol === 'https:' && !url.port && url.hostname === 'open.bigmodel.cn' && /^\/api\/coding\/paas\/v4\/chat\/completions\/?$/.test(url.pathname)) category = 'model_access_denied';
  else category = ({ invalid_api_key: 'authentication', authentication_error: 'authentication', permission_denied: 'permission', permission_error: 'permission', model_not_found: 'model_unavailable', insufficient_quota: 'quota_exhausted', rate_limit_exceeded: 'rate_limit', rate_limit_error: 'rate_limit', context_length_exceeded: 'context_limit', invalid_request_error: 'invalid_request', overloaded_error: 'server_unavailable' })[providerCode];
  const diagnostic = providerDiagnostic({ status, providerCode, category });
  // Retry only explicit temporary rejections before a stream was accepted.
  diagnostic.retryable = (status === 429 || status >= 500) && ['rate_limit', 'server_unavailable'].includes(diagnostic.category);
  return diagnostic;
}
