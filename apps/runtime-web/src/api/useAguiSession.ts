// 显式 Run 版会话 hook：POST /sessions/:id/runs 触发，EventSource 订阅 /runs/:id/events。
// 断开页面只关闭订阅，不打断后端执行；打断必须显式调用 interrupt。
import { useEffect, useRef, useState } from 'react';
import { EventType } from '@ag-ui/core';
import type {
  ArtifactRef,
  CreateRunResult,
  LockedElement,
  RuntimeArtifact,
  SessionDetail,
  TrialProcessState,
} from '@cb/shared';
import { apiPost } from './client.js';
import { clientTraceHeaders, reportClientEvent } from './telemetry.js';

export interface AguiUiMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  artifacts: ArtifactRef[];
}

interface ArtifactState {
  artifacts?: Record<string, RuntimeArtifact>;
  activeArtifactKey?: string | null;
  trialProcess?: TrialProcessState;
}

export interface AguiSession {
  messages: AguiUiMessage[];
  artifacts: RuntimeArtifact[];
  activeKey: string | null;
  trialProcess: TrialProcessState | null;
  isRunning: boolean;
  error: string | null;
  setActiveKey: (key: string | null) => void;
  send: (text: string, lockedElements?: LockedElement[]) => void;
  interrupt: () => void;
}

function readArtifacts(state: ArtifactState): {
  list: RuntimeArtifact[];
  active: string | null;
} {
  const map = state.artifacts ?? {};
  return { list: Object.values(map), active: state.activeArtifactKey ?? null };
}

function ptrDecode(seg: string): string {
  return seg.replace(/~1/g, '/').replace(/~0/g, '~');
}

function applyStateDelta(state: ArtifactState, delta: unknown): ArtifactState {
  if (!Array.isArray(delta)) return state;
  const next: ArtifactState = {
    artifacts: { ...(state.artifacts ?? {}) },
    activeArtifactKey: state.activeArtifactKey ?? null,
    trialProcess: state.trialProcess,
  };
  for (const op of delta) {
    if (!op || typeof op !== 'object') continue;
    const patch = op as { op?: string; path?: string; value?: unknown };
    if (patch.op !== 'add' && patch.op !== 'replace') continue;
    if (patch.path === '/activeArtifactKey') {
      next.activeArtifactKey = typeof patch.value === 'string' ? patch.value : null;
      continue;
    }
    if (patch.path === '/trialProcess') {
      next.trialProcess = patch.value as TrialProcessState;
      continue;
    }
    const prefix = '/artifacts/';
    if (patch.path?.startsWith(prefix)) {
      const key = ptrDecode(patch.path.slice(prefix.length));
      next.artifacts![key] = patch.value as RuntimeArtifact;
    }
  }
  return next;
}

function lastArtifactKey(artifacts: RuntimeArtifact[]): string | null {
  return artifacts.at(-1)?.artifactKey ?? null;
}

export function useAguiSession(
  sessionId: string | undefined,
  detail: SessionDetail | undefined,
): AguiSession {
  const sourceRef = useRef<EventSource | null>(null);
  const activeRunRef = useRef<string | null>(null);
  const stateRef = useRef<ArtifactState>({});

  const [messages, setMessages] = useState<AguiUiMessage[]>([]);
  const [artifacts, setArtifacts] = useState<RuntimeArtifact[]>([]);
  const [activeKey, setActiveKeyState] = useState<string | null>(null);
  const [trialProcess, setTrialProcess] = useState<TrialProcessState | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId || !detail || detail.session.id !== sessionId) return;
    sourceRef.current?.close();
    sourceRef.current = null;
    activeRunRef.current = null;
    const artifactMap = Object.fromEntries(detail.artifacts.map((a) => [a.artifactKey, a]));
    stateRef.current = {
      artifacts: artifactMap,
      activeArtifactKey: lastArtifactKey(detail.artifacts),
    };
    setMessages(
      detail.messages.map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
        artifacts: m.artifacts,
      })),
    );
    setArtifacts(detail.artifacts);
    setActiveKeyState(lastArtifactKey(detail.artifacts));
    setTrialProcess(null);
    setIsRunning(false);
    setError(null);
    return () => {
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [sessionId, detail]);

  const attachEvents = (runId: string, eventsUrl: string, after = 0, attempt = 0): void => {
    sourceRef.current?.close();
    let lastSeenEventId = after;
    const trace = clientTraceHeaders();
    const params = new URLSearchParams();
    params.set('traceId', trace.traceId);
    if (after > 0) params.set('after', String(after));
    const url = `${eventsUrl}${eventsUrl.includes('?') ? '&' : '?'}${params.toString()}`;
    const source = new EventSource(url, { withCredentials: true });
    sourceRef.current = source;
    activeRunRef.current = runId;
    setIsRunning(true);

    source.onmessage = (event) => {
      const numericEventId = Number(event.lastEventId);
      if (Number.isFinite(numericEventId) && numericEventId > 0) lastSeenEventId = numericEventId;
      let frame: { type?: string; messageId?: string; delta?: unknown; message?: string };
      try {
        frame = JSON.parse(event.data) as typeof frame;
      } catch {
        return;
      }
      switch (frame.type) {
        case EventType.RUN_STARTED:
          setIsRunning(true);
          break;
        case EventType.TEXT_MESSAGE_START:
          if (typeof frame.messageId === 'string') {
            const messageId = frame.messageId;
            setMessages((cur) =>
              cur.some((m) => m.id === messageId)
                ? cur
                : [...cur, { id: messageId, role: 'assistant', text: '', artifacts: [] }],
            );
          }
          break;
        case EventType.TEXT_MESSAGE_CONTENT:
          if (typeof frame.messageId === 'string' && typeof frame.delta === 'string') {
            const messageId = frame.messageId;
            const delta = frame.delta;
            setMessages((cur) =>
              cur.map((m) => (m.id === messageId ? { ...m, text: `${m.text}${delta}` } : m)),
            );
          }
          break;
        case EventType.STATE_SNAPSHOT:
          stateRef.current = (frame as { snapshot?: ArtifactState }).snapshot ?? {};
          {
            const s = readArtifacts(stateRef.current);
            setArtifacts(s.list);
            setActiveKeyState((cur) => s.active ?? cur);
            setTrialProcess(stateRef.current.trialProcess ?? null);
          }
          break;
        case EventType.STATE_DELTA:
          stateRef.current = applyStateDelta(stateRef.current, frame.delta);
          {
            const s = readArtifacts(stateRef.current);
            setArtifacts(s.list);
            setActiveKeyState((cur) => s.active ?? cur);
            setTrialProcess(stateRef.current.trialProcess ?? null);
          }
          break;
        case EventType.RUN_ERROR:
          reportClientEvent('sse_error', {
            traceId: trace.traceId,
            message: frame.message ?? 'runtime run error',
            url,
            source: 'runtime-web',
          });
          setError(frame.message ?? '对话失败，请重试。');
          setIsRunning(false);
          activeRunRef.current = null;
          source.close();
          break;
        case EventType.RUN_FINISHED:
          setIsRunning(false);
          activeRunRef.current = null;
          source.close();
          break;
        default:
          break;
      }
    };

    source.onerror = () => {
      source.close();
      if (activeRunRef.current === runId && attempt < 3) {
        window.setTimeout(() => attachEvents(runId, eventsUrl, lastSeenEventId, attempt + 1), 600);
        return;
      }
      reportClientEvent('sse_error', {
        traceId: trace.traceId,
        message: 'runtime event stream disconnected',
        url,
        source: 'runtime-web',
      });
      setError('事件流连接中断，可刷新会话恢复。');
      setIsRunning(false);
    };
  };

  const send = (text: string, lockedElements?: LockedElement[]): void => {
    if (!sessionId || isRunning) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    setError(null);
    const userId = `u-${Date.now()}`;
    setMessages((cur) => [...cur, { id: userId, role: 'user', text: trimmed, artifacts: [] }]);
    setIsRunning(true);
    void apiPost<CreateRunResult>(`/runtime/sessions/${sessionId}/runs`, {
      contentParts: [{ type: 'text', text: trimmed }],
      ...(lockedElements && lockedElements.length > 0 ? { lockedElements } : {}),
    })
      .then((result) => attachEvents(result.run.id, result.eventsUrl))
      .catch(() => {
        setIsRunning(false);
        setError('无法启动运行，请重试。');
      });
  };

  const interrupt = (): void => {
    const runId = activeRunRef.current;
    if (!runId) return;
    void apiPost(`/runtime/runs/${runId}/interrupt`).catch(() => undefined);
  };

  return {
    messages,
    artifacts,
    activeKey,
    trialProcess,
    isRunning,
    error,
    setActiveKey: setActiveKeyState,
    send,
    interrupt,
  };
}
