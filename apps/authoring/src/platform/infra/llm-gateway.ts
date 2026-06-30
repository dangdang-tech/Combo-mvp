// B-06 · LLM Gateway 真实现入口(脚手架兼容层)。
// 真实现落 ./llm/ 模块(限流/重试/超时/降级/计费记账/流式);本文件保持脚手架对外签名不变:
//   createLlmGateway(env): LlmGatewayPort / probeLlm() / LLM_RETRY_LIMIT。
// infra/index.ts 经 `export * from './llm-gateway.js'` 透出,无需改动。
import { LLM_MAX_RETRIES } from '@cb/shared';

export { createLlmGateway, probeLlm } from './llm/index.js';

/** 重试上限(脊柱 §3.1:≤2 后才落终态错误信封)。供调用方/单测引用。 */
export const LLM_RETRY_LIMIT = LLM_MAX_RETRIES;
