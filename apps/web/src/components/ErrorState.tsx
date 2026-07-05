// ErrorState（硬规则「绝不裸露错误码」）——统一错误态。
//
// 唯一可渲染 = userMessage（人话）+ 按 action 给退路按钮（retry / change_input / escalate）。
// 对外信封无 code：traceId 仅作可选「反馈代码」小字（便于用户报障，但它不是错误码）。
import type { ReactElement } from 'react';
import {
  DISPLAYABLE_ACTIONS,
  CLIENT_FALLBACK_TRACE_ID,
  type ErrorBody,
  type ErrorAction,
} from '@cb/shared';
import { ApiError, sanitizeErrorBody, unwrapErrorBody } from '../api/client.js';

export interface ErrorStateProps {
  /** 接受 ApiError / ErrorBody / 完整 ErrorEnvelope / 任意未知异常（都收敛成人话）。 */
  error: unknown;
  /** action=retry 时的重试回调；不传则不渲染重试按钮。 */
  onRetry?: () => void;
  /** action=change_input 时的「去修改」回调。 */
  onChangeInput?: () => void;
  /** action=escalate 时的「去登录 / 联系支持」回调。 */
  onEscalate?: () => void;
  /** 覆盖 escalate 退路按钮文案（如会话过期场景用「去登录」）。 */
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
 * 把任意异常收敛为可安全展示的 ErrorBody（永远有人话 + 退路）。三种来源同一渲染路径：
 * ApiError（client 抛出）/ 完整 ErrorEnvelope（原始 HTTP/SSE body）/ 裸 ErrorBody（useTaskEvents 已解包）。
 * 一律经白名单重建，code/status/stack 天然不进结果。
 */
export function toErrorBody(error: unknown): ErrorBody {
  if (error instanceof ApiError) return sanitizeErrorBody(error.envelope.error);
  return unwrapErrorBody(error);
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

  const actionLabel =
    body.action === 'escalate' && escalateLabel ? escalateLabel : ACTION_LABEL[body.action];

  return (
    <div role="alert" className="cb-error-state" data-action={body.action}>
      {/* 唯一主文案：人话 userMessage。对外信封无 code，无可裸露。 */}
      <p className="cb-error-state__message">{body.userMessage}</p>
      {showAction && handler && (
        <button type="button" className="cb-error-state__action" onClick={handler}>
          {actionLabel}
        </button>
      )}
      {/* traceId 仅作「反馈代码」小字（报障用）；客户端兜底哨兵不展示。 */}
      {body.traceId && body.traceId !== CLIENT_FALLBACK_TRACE_ID && (
        <p className="cb-error-state__trace">
          反馈代码：<code>{body.traceId}</code>
        </p>
      )}
    </div>
  );
}
