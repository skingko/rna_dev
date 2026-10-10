import { providerDiagnostic } from '../../packages/sdk/src/provider-diagnostics.mjs';
import { inLanguage } from './interface-language.mjs';

const MESSAGES = {
  model_access_denied: { zh: '当前订阅或接入端点未授权使用所选模型。请切换套餐支持的模型，或配置有该模型权限的 API 接入；重复重试无法解除权限限制。', en: 'Your plan or endpoint is not authorized for the selected model. Switch to a model your plan includes, or set up API access that has it; retrying will not lift the restriction.' },
  authentication: { zh: '模型登录或凭据无效、已过期。请在模型设置中重新登录或更新 API Key 后重试。', en: 'The model sign-in or credentials are invalid or expired. Sign in again or update the API key in model settings, then retry.' },
  permission: { zh: '当前凭据没有访问所选模型或接入端点的权限。请切换已授权的模型或检查供应商权限后重试。', en: 'These credentials cannot access the selected model or endpoint. Switch to an authorized model or check the provider permissions, then retry.' },
  model_unavailable: { zh: '当前接入端点找不到所选模型。请在模型设置中核对模型 ID 和接入地址，或切换可用模型。', en: 'The endpoint cannot find the selected model. Check the model ID and address in model settings, or switch to an available model.' },
  quota_exhausted: { zh: '模型服务额度不足。请检查供应商账户额度，或切换有额度的接入后重试。', en: 'The model service is out of quota. Check the provider account balance, or switch to an endpoint with quota, then retry.' },
  rate_limit: { zh: '模型服务当前限流。请稍后重试，或切换其他可用模型。', en: 'The model service is rate limiting requests. Retry later, or switch to another available model.' },
  server_unavailable: { zh: '模型服务暂时不可用。请稍后重试，或切换其他可用接入。', en: 'The model service is temporarily unavailable. Retry later, or switch to another endpoint.' },
  invalid_request: { zh: '模型服务未接受请求配置。请核对所选模型、接入地址、输出上限和推理设置后重试。', en: 'The model service did not accept the request settings. Check the selected model, address, output limit and reasoning settings, then retry.' },
  context_limit: { zh: '当前模型的上下文容量不足。请切换容量更大的模型，或整理较早上下文后继续。', en: 'The conversation no longer fits this model’s context. Switch to a model with a larger context, or compact earlier context and continue.' },
  redirect_rejected: { zh: '模型地址发生了重定向。为避免转发凭据，请在模型设置中填写供应商的直接 API 地址。', en: 'The model address redirected. To avoid forwarding credentials, enter the provider’s direct API address in model settings.' },
  connection: { zh: '未能连接模型服务。请检查接入地址和网络后重试；已完成的操作仍保留。', en: 'Could not reach the model service. Check the address and network, then retry; finished steps are kept.' },
  timeout: { zh: '模型响应超时。已完成的操作仍保留，请稍后重试或切换其他可用模型。', en: 'The model took too long to respond. Finished steps are kept; retry later or switch to another available model.' },
  vision_required: { zh: '本轮新加入、尚未被查看的图片需要图像输入，但所选模型未确认支持图片。请刷新模型目录，或切换已识别支持图片的模型后继续；较早已查看过的图片会以文字占位保留，不会阻止后续对话。', en: 'The new images in this turn need image input, but the selected model is not known to support images. Refresh the model list, or switch to a model that supports images; images already viewed earlier stay as text placeholders and do not block the conversation.' },
  image_limit: { zh: '图片数量或体积超过本次请求限制。请减少本批图片或缩小单张图片后继续。', en: 'Too many images, or images too large, for one request. Send fewer images or smaller ones, then continue.' },
  image_invalid: { zh: '图片数据或格式无法用于模型请求。请重新添加 PNG、JPEG、GIF 或 WebP 图片后重试。', en: 'The image data or format cannot be sent to the model. Add the image again as PNG, JPEG, GIF or WebP, then retry.' },
  provider_failure: { zh: '模型服务未返回完整、有效的响应。请稍后重试或切换其他可用模型；已完成的操作仍保留。', en: 'The model service did not return a complete, valid response. Retry later or switch to another available model; finished steps are kept.' },
  refusal: { zh: '模型的安全审查拒绝了这一轮请求，没有给出回答。可以换一种说法重试，或切换其他可用模型；已完成的操作仍保留。', en: 'The model’s safety review declined this request and gave no answer. Rephrase and retry, or switch to another available model; finished steps are kept.' }
};

/** User-facing guidance is host-authored, never the provider's echoed body; it follows the interface language. */
export function runtimeFailureMessage(error, language = 'zh') {
  const diagnostic = providerDiagnostic(error);
  if (!diagnostic) return undefined;
  const label = inLanguage(language, { zh: { code: '供应商代码', shape: '响应', join: '；' }, en: { code: 'provider code', shape: 'response', join: '; ' } });
  const details = [diagnostic.status && `HTTP ${diagnostic.status}`, diagnostic.providerCode && `${label.code} ${diagnostic.providerCode}`, diagnostic.responseShape && `${label.shape} ${diagnostic.responseShape}`].filter(Boolean);
  const suffix = details.length ? inLanguage(language, { zh: `（${details.join(label.join)}）`, en: ` (${details.join(label.join)})` }) : '';
  const prefix = diagnostic.purpose === 'compaction' ? inLanguage(language, { zh: '上下文压缩未完成，原始对话已保留。', en: 'Context compaction did not finish; the original conversation is kept. ' }) : '';
  return `${prefix}${inLanguage(language, MESSAGES[diagnostic.category] ?? MESSAGES.provider_failure)}${suffix}`;
}
