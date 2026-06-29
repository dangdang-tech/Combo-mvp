// 本地兜底 ApiError 构造（F-13/F-14）——把非 ApiError 异常收敛成人话信封（永不裸错、无 code）。
//
// 容器层 catch 到非 ApiError（理论少见，client 已统一抛 ApiError）时用它兜底，保证 ErrorState 永远拿到
// userMessage + action。abort 异常由调用方单独处理（不转 ApiError）。
import { ApiError } from '../../api/index.js';

/** 把任意异常收敛成 ApiError（已是 ApiError 直接返回；否则用给定人话兜底）。 */
export function toApiError(
  e: unknown,
  fallbackMessage: string,
  action: 'retry' | 'change_input' | 'escalate' = 'retry',
): ApiError {
  if (e instanceof ApiError) return e;
  return new ApiError({
    error: {
      userMessage: fallbackMessage,
      retriable: action === 'retry',
      action,
      traceId: '',
    },
  });
}

/** 判断是否为 fetch abort（组件卸载/取消请求；不应转成错误态）。 */
export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}
