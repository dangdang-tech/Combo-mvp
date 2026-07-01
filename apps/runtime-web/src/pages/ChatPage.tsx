import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { RuntimeMessage } from '@cb/shared';
import { apiPost } from '../api/client.js';
import { useSession, type CreateSessionResult } from '../api/runtime.js';
import { useAguiSession } from '../api/useAguiSession.js';
import { ArtifactPanel } from '../components/ArtifactPanel.js';
import { ChatThread } from '../components/ChatThread.js';
import { InputComposer } from '../components/InputComposer.js';
import { SessionSidebar } from '../components/SessionSidebar.js';

/** 把结构化输入折叠进首条用户文本（第一版：一并写进消息让模型遵守）。 */
function foldInputs(text: string, inputs?: Record<string, string>): string {
  if (!inputs) return text;
  const entries = Object.entries(inputs).filter(([, v]) => v && v.trim());
  if (entries.length === 0) return text;
  return `${text}\n\n【我的输入】\n${entries.map(([k, v]) => `- ${k}: ${v}`).join('\n')}`;
}

export function ChatPage() {
  const { slug, sessionId: routeSessionId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [createFailed, setCreateFailed] = useState(false);
  const startedSlugRef = useRef<string | undefined>(undefined);

  // try/:slug 模式：开一局，成功即跳到 /session/:id（ref 防 StrictMode 重复创建；不在 cleanup 取消）。
  useEffect(() => {
    if (!slug || startedSlugRef.current === slug) return;
    startedSlugRef.current = slug;
    apiPost<CreateSessionResult>('/runtime/sessions', { slugOrId: slug })
      .then((d) => {
        void qc.invalidateQueries({ queryKey: ['sessions'] });
        navigate(`/session/${d.session.id}`, { replace: true });
      })
      .catch(() => setCreateFailed(true));
  }, [slug, navigate, qc]);

  const sessionId = routeSessionId;
  const sessionQ = useSession(sessionId);
  const detail = sessionQ.data;
  const capability = detail?.capability;

  // AG-UI：HttpAgent 自管 messages + state，hook 镜像进来。
  const agui = useAguiSession(sessionId, detail);

  if (slug && !sessionId) {
    return (
      <div className="rt-loading">
        {createFailed ? (
          <div className="rt-error">无法开始试用：能力未找到或未发布。</div>
        ) : (
          '正在开始试用…'
        )}
      </div>
    );
  }
  if (sessionQ.isLoading) return <div className="rt-loading">加载会话…</div>;
  if (sessionQ.isError || !capability) {
    return <div className="rt-loading rt-error">会话加载失败或不存在。</div>;
  }

  const openArtifact = agui.activeKey
    ? (agui.artifacts.find((a) => a.artifactKey === agui.activeKey) ?? null)
    : null;
  const isFirst = agui.messages.length === 0;
  const lastRole = agui.messages.at(-1)?.role;
  // 模型还没吐第一个字时显示打字态；正文一旦出现就并入消息气泡（不再单独显示）。
  const streamingText = agui.isRunning && lastRole !== 'assistant' ? '' : null;

  const uiMessages: RuntimeMessage[] = agui.messages.map((m, i) => ({
    id: m.id,
    seq: i,
    role: m.role,
    text: m.text,
    artifacts: [],
    createdAt: '',
  }));

  return (
    <div className="rt-app" data-artifact={openArtifact ? 'open' : 'closed'}>
      <SessionSidebar activeSessionId={sessionId} />
      <div className="rt-main">
        <section className="rt-conversation">
          <header className="rt-conversation__head">
            <div className="rt-conversation__cap">{capability.name}</div>
            <div className="rt-conversation__tag">{capability.tagline}</div>
          </header>
          <ChatThread
            messages={uiMessages}
            streamingText={streamingText}
            onOpenArtifact={(ref) => agui.setActiveKey(ref.artifactKey)}
          />
          {agui.error && <div className="rt-error rt-error--inline">{agui.error}</div>}
          <InputComposer
            capability={capability}
            isFirst={isFirst}
            disabled={agui.isRunning}
            onSend={(text, inputs) => agui.send(foldInputs(text, inputs))}
          />
        </section>
        {openArtifact && (
          <ArtifactPanel
            artifact={openArtifact}
            artifacts={agui.artifacts}
            onSelectArtifact={(key) => agui.setActiveKey(key)}
            onClose={() => agui.setActiveKey(null)}
          />
        )}
      </div>
    </div>
  );
}
