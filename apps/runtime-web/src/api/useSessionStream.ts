// 会话流 hook：订阅 GET /runtime/sessions/:id/stream（SSE），事件归并交给
// streamState 纯函数；发消息 / 打断走 HTTP 端点。
//   - EventSource 断线自动重连并自带 Last-Event-ID 续传（浏览器原生行为）；
//   - 终态（RUN_FINISHED / RUN_ERROR）后回拉一次会话详情对齐真源；
//   - 页面关闭只断订阅，不打断后端生成；打断必须显式点按钮。
import { useEffect, useReducer } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ArtifactView, MessageView, SessionDetail } from '@cb/shared';
import { ApiError, isUnauthenticated } from './client.js';
import { loginUrl } from '../navigation/login.js';
import { interruptSession, sendSessionMessage } from './runtime.js';
import { reportClientEvent } from './telemetry.js';
import {
  initialStreamUiState,
  isTerminalEvent,
  parseStreamEvent,
  streamUiReducer,
  type StreamUiState,
} from './streamState.js';

export interface SessionStream extends StreamUiState {
  /** 画布产物列表（map 展平，稳定给渲染用）。 */
  artifactList: ArtifactView[];
  selectArtifact: (id: string) => void;
  send: (text: string) => void;
  interrupt: () => void;
}

export function useSessionStream(
  sessionId: string | undefined,
  detailArtifacts: ArtifactView[] | undefined,
): SessionStream {
  const qc = useQueryClient();
  const [state, dispatch] = useReducer(streamUiReducer, initialStreamUiState);

  // 详情到达/回拉后，把落库产物种进画布（同 id 覆盖，真源优先）。
  useEffect(() => {
    if (detailArtifacts) dispatch({ kind: 'seed-artifacts', artifacts: detailArtifacts });
  }, [detailArtifacts]);

  useEffect(() => {
    if (!sessionId) return;
    dispatch({ kind: 'reset' });
    const url = `/api/v1/runtime/sessions/${sessionId}/stream`;
    const source = new EventSource(url, { withCredentials: true });

    source.onmessage = (raw) => {
      const event = parseStreamEvent(raw.data as string);
      if (!event) return;
      dispatch({ kind: 'stream-event', event });
      if (isTerminalEvent(event)) {
        void qc.invalidateQueries({ queryKey: ['session', sessionId] });
        void qc.invalidateQueries({ queryKey: ['sessions'] });
      }
    };
    source.onerror = () => {
      // readyState CONNECTING = 浏览器在自动重连（带 Last-Event-ID），不打扰；
      // CLOSED = 致命（如 401/404），提示刷新。
      if (source.readyState !== EventSource.CLOSED) return;
      reportClientEvent('sse_error', { message: 'session stream closed', url });
      dispatch({ kind: 'error', message: '事件流连接不上，请刷新页面重试。' });
    };
    return () => source.close();
  }, [sessionId, qc]);

  const send = (text: string): void => {
    const trimmed = text.trim();
    if (!sessionId || !trimmed || state.running) return;
    dispatch({ kind: 'turn-accepted' });
    sendSessionMessage(sessionId, trimmed)
      .then((message) => {
        // 202 带回已落库的 user 消息：直接写进详情缓存，聊天流立即可见。
        qc.setQueryData<SessionDetail>(['session', sessionId], (cur) =>
          cur ? { ...cur, messages: appendMessage(cur.messages, message) } : cur,
        );
      })
      .catch((err: unknown) => {
        // 登录态失效：跳创作端登录（回来落在当前会话页）。
        if (isUnauthenticated(err)) {
          window.location.assign(loginUrl());
          return;
        }
        // 409 SESSION_BUSY 等：userMessage 已是人话（「等上一轮结束」），直接展示。
        const message = err instanceof ApiError ? err.userMessage : '发送失败，请重试。';
        dispatch({ kind: 'error', message });
      });
  };

  const interrupt = (): void => {
    if (!sessionId) return;
    void interruptSession(sessionId).catch(() => undefined);
  };

  return {
    ...state,
    artifactList: Object.values(state.artifacts),
    selectArtifact: (id) => dispatch({ kind: 'select-artifact', id }),
    send,
    interrupt,
  };
}

function appendMessage(messages: MessageView[], message: MessageView): MessageView[] {
  if (messages.some((m) => m.id === message.id)) return messages;
  return [...messages, message];
}
