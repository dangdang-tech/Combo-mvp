// ErrorState（F-03，硬规则「绝不裸露错误码」）——统一错误态。
//
// 唯一可渲染 = userMessage（人话）+ 按 action 给退路按钮（retry / change_input / escalate）。
// 对外信封无 code（D1）：traceId 仅作可选「反馈代码」小字（便于用户报障，但它不是错误码）。
import type { ReactElement } from 'react';
import {
  DISPLAYABLE_ACTIONS,
  CLIENT_FALLBACK_TRACE_ID,
  sanitizeErrorBody,
  type ErrorBody,
  type ErrorAction,
} from '@cb/shared';
import { ApiError } from '../api/client.js';

export interface ErrorStateProps {
  /** 接受 ApiError / 原始 ErrorBody / 任意未知异常（都收敛成人话）。 */
  error: unknown;
  /** action=retry 时的重试回调；不传则不渲染重试按钮。 */
  onRetry?: () => void;
  /** action=change_input 时的「去修改」回调（如返回上一步）。 */
  onChangeInput?: () => void;
  /** action=escalate 时的「去登录 / 联系支持」回调。 */
  onEscalate?: () => void;
  /** 覆盖 escalate 退路按钮文案（如会话过期场景用「去登录」）；不传走默认「去处理」。 */
  escalateLabel?: string;
}

const ACTION_LABEL: Record<ErrorAction, string> = {
  retry: '重试',
  change_input: '去修改',
  escalate: '去处理',
  wait: '稍候',
  none: '知道了',
};

/**
 * 把任意异常收敛为可安全展示的 ErrorBody（永远有人话 + 退路），并**白名单重建**安全字段（Codex r2 P1 / D1）。
 * 三种来源都通吃，让 HTTP / SSE error 帧 / useSSE 解包后的 state.error 走同一渲染路径：
 *   1. ApiError —— typed client 抛出的（envelope.error 已在 client 层重建过，这里再过一遍是幂等的）。
 *   2. 完整对外 ErrorEnvelope（`{ error: {...} }`）—— 原始 HTTP/SSE body，取内层重建。
 *   3. 裸 ErrorBody（已带 userMessage）—— useSSE 已解包后存进 state.error 的形态，直接重建。
 * 关键：绝不 shape-check 后强转原始对象（会把 code/status/stack/原始 message 留在对象里），
 * 一律经 {@link sanitizeErrorBody} 逐字段摘取，未列字段天然不进结果。
 */
export function toErrorBody(error: unknown): ErrorBody {
  if (error instanceof ApiError) return sanitizeErrorBody(error.envelope.error);
  if (typeof error === 'object' && error !== null) {
    // 完整对外 ErrorEnvelope：取内层重建。
    const inner = (error as { error?: { userMessage?: unknown } }).error;
    if (typeof inner?.userMessage === 'string') {
      return sanitizeErrorBody(inner);
    }
  }
  // 裸 ErrorBody / 任意可疑输入：sanitizeErrorBody 内部自带白名单 + 兜底人话。
  return sanitizeErrorBody(error);
}

export function ErrorState({
  error,
  onRetry,
  onChangeInput,
  onEscalate,
  escalateLabel,
}: ErrorStateProps): ReactElement {
  const body = toErrorBody(error);
  const showAction = (DISPLAYABLE_ACTIONS as readonly string[]).includes(body.action);

  const handler =
    body.action === 'retry'
      ? onRetry
      : body.action === 'change_input'
        ? onChangeInput
        : body.action === 'escalate'
          ? onEscalate
          : undefined;

  // escalate 可由调用方覆盖按钮文案（如「去登录」）；其余 action 沿用默认标签，行为不变。
  const actionLabel =
    body.action === 'escalate' && escalateLabel ? escalateLabel : ACTION_LABEL[body.action];

  return (
    <div role="alert" className="cb-error-state" data-action={body.action}>
      {/* 唯一主文案：人话 userMessage。对外信封无 code（D1），无可裸露。 */}
      <p className="cb-error-state__message">{body.userMessage}</p>
      {showAction && handler && (
        <button type="button" className="cb-error-state__action" onClick={handler}>
          {actionLabel}
        </button>
      )}
      {/* traceId 仅作「反馈代码」小字（报障用），不是错误码、不是主文案；兜底哨兵不展示。 */}
      {body.traceId && body.traceId !== CLIENT_FALLBACK_TRACE_ID && (
        <p className="cb-error-state__trace">
          反馈代码：<code>{body.traceId}</code>
        </p>
      )}
    </div>
  );
}
