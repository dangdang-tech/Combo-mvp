// AG-UI 会话 hook：用官方 @ag-ui/client 的 HttpAgent 消费 /runtime/agui。
//   HttpAgent 自管 messages + state（含流式拼接、STATE_DELTA JSON Patch 应用、顺序校验），
//   我们只把 agent.messages（对话）+ agent.state.artifacts（产物）镜像进 React state 驱动现有组件。
//   pi 仍是后端执行层；前端不再维护任何自定义协议解析。
import { useEffect, useRef, useState } from 'react';
import { HttpAgent } from '@ag-ui/client';
import type { Message } from '@ag-ui/core';
import type { RuntimeArtifact, SessionDetail } from '@cb/shared';

export interface AguiUiMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

/** 共享状态里产物的形态（与后端 agui-run 发的 STATE_DELTA 对齐）。 */
interface ArtifactState {
  artifacts?: Record<string, RuntimeArtifact>;
  activeArtifactKey?: string | null;
}

export interface AguiSession {
  messages: AguiUiMessage[];
  artifacts: RuntimeArtifact[];
  activeKey: string | null;
  isRunning: boolean;
  error: string | null;
  setActiveKey: (key: string | null) => void;
  send: (text: string) => void;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : ''))
      .join('');
  }
  return '';
}

function toUi(messages: ReadonlyArray<{ id: string; role: string; content?: unknown }>): AguiUiMessage[] {
  const out: AguiUiMessage[] = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    out.push({ id: m.id, role: m.role, text: textOf(m.content) });
  }
  return out;
}

function readArtifacts(state: ArtifactState | undefined): {
  list: RuntimeArtifact[];
  active: string | null;
} {
  const map = state?.artifacts ?? {};
  return { list: Object.values(map), active: state?.activeArtifactKey ?? null };
}

export function useAguiSession(
  sessionId: string | undefined,
  detail: SessionDetail | undefined,
): AguiSession {
  const agentRef = useRef<HttpAgent | null>(null);
  const builtFor = useRef<string | undefined>(undefined);
  const runningRef = useRef(false);
  const errorRef = useRef<string | null>(null);

  const [messages, setMessages] = useState<AguiUiMessage[]>([]);
  const [artifacts, setArtifacts] = useState<RuntimeArtifact[]>([]);
  const [activeKey, setActiveKeyState] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // 仅当 detail 确属当前 session 才建（切会话时 detail 可能还是上一会话的，须门住）。
    if (!sessionId || !detail || detail.session.id !== sessionId) return;
    if (builtFor.current === sessionId) return;
    builtFor.current = sessionId;

    const agent = new HttpAgent({ url: '/api/v1/runtime/agui', headers: {} });
    agent.threadId = sessionId;
    agent.setMessages(
      detail.messages.map((m) => ({ id: m.id, role: m.role, content: m.text }) as Message),
    );
    const initialState: ArtifactState = {
      artifacts: Object.fromEntries(detail.artifacts.map((a) => [a.artifactKey, a])),
      activeArtifactKey: detail.artifacts.at(-1)?.artifactKey ?? null,
    };
    agent.setState(initialState);
    agentRef.current = agent;

    setMessages(toUi(agent.messages));
    const init = readArtifacts(initialState);
    setArtifacts(init.list);
    setActiveKeyState(init.active);
    setError(null);
    setIsRunning(false);
    runningRef.current = false;
    errorRef.current = null;

    const { unsubscribe } = agent.subscribe({
      onMessagesChanged: () => setMessages(toUi(agent.messages)),
      onStateChanged: () => {
        const s = readArtifacts(agent.state as ArtifactState);
        setArtifacts(s.list);
        setActiveKeyState((cur) => s.active ?? cur);
      },
      onRunErrorEvent: ({ event }) => {
        const msg = (event as { message?: string }).message ?? '对话失败，请重试。';
        errorRef.current = msg;
        setError(msg);
      },
    });

    return () => {
      unsubscribe();
      agent.abortRun();
      agentRef.current = null;
      builtFor.current = undefined;
    };
  }, [sessionId, detail]);

  const send = (text: string): void => {
    const agent = agentRef.current;
    if (!agent || runningRef.current) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    errorRef.current = null;
    setError(null);
    runningRef.current = true;
    setIsRunning(true);
    agent.addMessage({ id: `u-${Date.now()}`, role: 'user', content: trimmed } as Message);
    setMessages(toUi(agent.messages));
    void agent
      .runAgent({ tools: [], context: [], forwardedProps: {} })
      .catch(() => {
        if (!errorRef.current) setError('对话失败，请重试。');
      })
      .finally(() => {
        runningRef.current = false;
        setIsRunning(false);
      });
  };

  return {
    messages,
    artifacts,
    activeKey,
    isRunning,
    error,
    setActiveKey: setActiveKeyState,
    send,
  };
}
