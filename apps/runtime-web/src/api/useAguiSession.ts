// 显式 Run 版会话 hook：POST /sessions/:id/runs 触发，EventSource 订阅 /runs/:id/events。
// 断开页面只关闭订阅，不打断后端执行；打断必须显式调用 interrupt。
import { useEffect, useRef, useState } from 'react';
import { EventType } from '@ag-ui/core';
import { useQueryClient } from '@tanstack/react-query';
import {
  selectPrimaryArtifactKey,
  type ArtifactRef,
  type CreateRunResult,
  type LockedElement,
  type RunIntent,
  type RuntimeArtifact,
  type SessionDetail,
  type TrialProcessState,
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
  send: (text: string, lockedElements?: LockedElement[], intent?: RunIntent) => boolean;
  interrupt: (fallbackRunId?: string) => void;
}

function readArtifacts(state: ArtifactState): {
  list: RuntimeArtifact[];
  active: string | null;
} {
  const map = state.artifacts ?? {};
  const list = Object.values(map);
  return {
    list,
    active: selectPrimaryArtifactKey(list) ?? state.activeArtifactKey ?? null,
  };
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

export function useAguiSession(
  sessionId: string | undefined,
  detail: SessionDetail | undefined,
): AguiSession {
  const qc = useQueryClient();
  const sourceRef = useRef<EventSource | null>(null);
  const activeRunRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const sessionIdRef = useRef(sessionId);
  const hydratedDetailRef = useRef<SessionDetail | null>(null);
  const stateRef = useRef<ArtifactState>({});

  const [messages, setMessages] = useState<AguiUiMessage[]>([]);
  const [artifacts, setArtifacts] = useState<RuntimeArtifact[]>([]);
  const [activeKey, setActiveKeyState] = useState<string | null>(null);
  const [trialProcess, setTrialProcess] = useState<TrialProcessState | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshSessionState = (): void => {
    if (!sessionId) return;
    void qc.invalidateQueries({ queryKey: ['session', sessionId] });
    void qc.invalidateQueries({ queryKey: ['sessions'] });
    void qc.invalidateQueries({ queryKey: ['studio', sessionId] });
  };

  // Switching sessions owns connection cleanup. A background detail refetch must
  // never tear down the active run that is producing the next Studio revision.
  useEffect(() => {
    sessionIdRef.current = sessionId;
    sourceRef.current?.close();
    sourceRef.current = null;
    activeRunRef.current = null;
    busyRef.current = false;
    hydratedDetailRef.current = null;
    stateRef.current = {};
    setMessages([]);
    setArtifacts([]);
    setActiveKeyState(null);
    setTrialProcess(null);
    setIsRunning(false);
    setError(null);
    return () => {
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [sessionId]);

  // React Query may replace `detail` while a POST or SSE run is active. Hydrate
  // only when idle; the run-finished invalidation will then deliver the durable
  // transcript and artifacts without erasing optimistic/streaming state.
  useEffect(() => {
    if (
      !sessionId ||
      !detail ||
      detail.session.id !== sessionId ||
      busyRef.current ||
      hydratedDetailRef.current === detail
    ) {
      return;
    }
    hydratedDetailRef.current = detail;
    const artifactMap = Object.fromEntries(detail.artifacts.map((a) => [a.artifactKey, a]));
    const primaryArtifactKey = selectPrimaryArtifactKey(detail.artifacts);
    stateRef.current = {
      artifacts: artifactMap,
      activeArtifactKey: primaryArtifactKey,
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
    setActiveKeyState(primaryArtifactKey);
    setTrialProcess(null);
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
          busyRef.current = false;
          setIsRunning(false);
          activeRunRef.current = null;
          source.close();
          refreshSessionState();
          break;
        case EventType.RUN_FINISHED:
          busyRef.current = false;
          setIsRunning(false);
          activeRunRef.current = null;
          source.close();
          refreshSessionState();
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
      busyRef.current = false;
      setIsRunning(false);
      activeRunRef.current = null;
      refreshSessionState();
    };
  };

  const send = (text: string, lockedElements?: LockedElement[], intent?: RunIntent): boolean => {
    if (!sessionId || busyRef.current) return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    busyRef.current = true;
    setError(null);
    const userId = `u-${Date.now()}`;
    setMessages((cur) => [...cur, { id: userId, role: 'user', text: trimmed, artifacts: [] }]);
    setIsRunning(true);
    void apiPost<CreateRunResult>(`/runtime/sessions/${sessionId}/runs`, {
      contentParts: [{ type: 'text', text: trimmed }],
      ...(lockedElements && lockedElements.length > 0 ? { lockedElements } : {}),
      ...(intent ? { intent } : {}),
    })
      .then((result) => {
        if (sessionIdRef.current !== sessionId) return;
        attachEvents(result.run.id, result.eventsUrl);
      })
      .catch(() => {
        if (sessionIdRef.current !== sessionId) return;
        busyRef.current = false;
        setIsRunning(false);
        setError('无法启动运行，请重试。');
      });
    return true;
  };

  const interrupt = (fallbackRunId?: string): void => {
    const runId = activeRunRef.current ?? fallbackRunId;
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
