// 会话页（GUI 形态）：产物画布是主界面，聊天是悬浮伴随窗——
//   - 首次进入（还没有消息）画布上盖开场表单（TrialIntakeForm，按能力定义的字段渲染）；
//   - 第一轮生成中且还没有任何产出时显示生成进度卡；
//   - 有产物后画布渲染产物（多产物顶部 chips 切换），FloatingChat 负责继续微调；
//   - 恢复：GET /runtime/sessions/:id（详情真源）；实时：/stream SSE（useSessionStream）。
import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { ArtifactView } from '@cb/shared';
import { useArtifactContent, useSession } from '../api/runtime.js';
import { useSessionStream } from '../api/useSessionStream.js';
import { ArtifactRenderer } from '../components/ArtifactRenderer.js';
import { FloatingChat } from '../components/FloatingChat.js';
import { QueryErrorNotice } from '../components/QueryErrorNotice.js';
import { SessionSidebar } from '../components/SessionSidebar.js';
import { TrialIntakeForm } from '../components/TrialIntakeForm.js';
import {
  readRuntimeReturnTo,
  rememberRuntimeReturnTo,
  safeRuntimeReturnTo,
} from '../navigation/runtimeReturn.js';

export function ChatPage() {
  const { sessionId } = useParams();
  const [searchParams] = useSearchParams();
  const sessionQ = useSession(sessionId);
  const detail = sessionQ.data;
  const stream = useSessionStream(sessionId, detail?.artifacts);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [lastSidebarCapability, setLastSidebarCapability] = useState<{
    id: string;
    name: string;
  } | null>(null);

  // 创作端带 ?returnTo= 深链进来：记住它，侧栏「返回发布页」用。
  const queryReturnTo = safeRuntimeReturnTo(searchParams.get('returnTo'));
  const returnTo = queryReturnTo ?? readRuntimeReturnTo(sessionId);
  useEffect(() => {
    rememberRuntimeReturnTo(sessionId, queryReturnTo);
  }, [queryReturnTo, sessionId]);

  const capability = detail?.capability;
  const sidebarCapability = capability
    ? { id: capability.id, name: capability.name }
    : lastSidebarCapability;
  const messages = detail?.messages ?? [];
  const activeArtifact = stream.activeArtifactId
    ? (stream.artifacts[stream.activeArtifactId] ?? null)
    : (stream.artifactList.at(-1) ?? null);

  // 画布状态机：intake（还没开始）→ running（第一轮生成、尚无任何产出）→ output。
  const hasStarted = messages.length > 0 || stream.running;
  const hasAssistantOutput =
    messages.some((m) => m.role === 'assistant') ||
    stream.streamingText !== null ||
    activeArtifact !== null;
  const showIntake = !hasStarted;
  const showGenerating = stream.running && !hasAssistantOutput;
  const canvasState = showIntake ? 'intake' : showGenerating ? 'running' : 'output';

  useEffect(() => {
    if (!capability) return;
    setLastSidebarCapability((current) =>
      current?.id === capability.id && current.name === capability.name
        ? current
        : { id: capability.id, name: capability.name },
    );
  }, [capability?.id, capability?.name]);

  return (
    <div className="rt-app rt-trial-app">
      <SessionSidebar
        activeSessionId={sessionId}
        capabilityId={sidebarCapability?.id}
        capabilityName={sidebarCapability?.name}
        returnTo={returnTo}
      />
      <div className="rt-trial">
        {sessionQ.isPending ? (
          <div className="rt-loading">加载会话…</div>
        ) : sessionQ.isError || !detail || !capability ? (
          <QueryErrorNotice error={sessionQ.error} onRetry={() => void sessionQ.refetch()} />
        ) : (
          <>
            <header className="rt-trial__toolbar">
              <div className="rt-trial__title-group">
                <h1>{activeArtifact?.title ?? capability.name}</h1>
                <span className="rt-source-pill">
                  {capability.name} · {capability.kind}
                </span>
              </div>
            </header>

            <main className="rt-genui">
              <div ref={canvasRef} className="rt-genui__canvas" data-state={canvasState}>
                {stream.artifactList.length > 1 && (
                  <div className="rt-canvas-chips">
                    {stream.artifactList.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        className={`rt-artifact-chip${a.id === activeArtifact?.id ? ' is-active' : ''}`}
                        onClick={() => stream.selectArtifact(a.id)}
                      >
                        <span className="rt-artifact-chip__glyph">▤</span>
                        <span className="rt-artifact-chip__title">{a.title ?? '未命名产物'}</span>
                      </button>
                    ))}
                  </div>
                )}
                {activeArtifact ? (
                  <ArtifactStage artifact={activeArtifact} />
                ) : hasStarted && !showGenerating ? (
                  <div className="rt-empty">这轮还没有生成产物，可以在对话里继续要求。</div>
                ) : null}
                {showIntake && (
                  <div className="rt-genui__overlay">
                    <TrialIntakeForm
                      capability={capability}
                      disabled={stream.running}
                      onSubmit={(prompt) => stream.send(prompt)}
                    />
                  </div>
                )}
                {showGenerating && (
                  <div className="rt-genui__overlay rt-genui__overlay--plain">
                    <GeneratingCard name={capability.name} />
                  </div>
                )}
                {hasStarted && !showGenerating && sessionId && (
                  <FloatingChat
                    containerRef={canvasRef}
                    sessionId={sessionId}
                    title={activeArtifact?.title ?? detail.session.title ?? capability.name}
                    messages={messages}
                    streamingText={stream.streamingText}
                    isRunning={stream.running}
                    error={stream.errorMessage}
                    onSend={stream.send}
                    onInterrupt={stream.interrupt}
                  />
                )}
              </div>
            </main>
          </>
        )}
      </div>
    </div>
  );
}

/** 产物舞台：内容回读（GET /runtime/artifacts/:id/content）+ 按 kind 渲染，占满画布。 */
function ArtifactStage({ artifact }: { artifact: ArtifactView }) {
  const content = useArtifactContent(artifact);
  return (
    <div className="rt-artifact-stage">
      {content.isPending ? (
        <div className="rt-empty">产物加载中…</div>
      ) : content.isError ? (
        <div className="rt-empty rt-empty--error">产物内容加载失败，稍后重试。</div>
      ) : (
        <ArtifactRenderer
          kind={artifact.kind}
          title={artifact.title ?? '未命名产物'}
          content={content.data}
        />
      )}
    </div>
  );
}

/** 第一轮生成进度卡（装饰性固定步骤，真实进展看画布上出现的产物与聊天流）。 */
function GeneratingCard({ name }: { name: string }) {
  const steps = [
    { key: 'load', label: `读取「${name}」的能力定义`, status: 'completed' },
    { key: 'draft', label: '生成第一版产物', status: 'running' },
    { key: 'compose', label: '整理产物结构', status: 'pending' },
  ];
  return (
    <section className="rt-generating-card" aria-label="正在生成">
      <h2>正在生成 · {name}…</h2>
      <p>第一版产物正在路上，完成后会直接出现在这块画布上。</p>
      <div className="rt-generating-card__steps">
        {steps.map((row) => (
          <div key={row.key} className="rt-generating-card__step" data-status={row.status}>
            <span className="rt-generating-card__dot" />
            <span>{row.label}</span>
          </div>
        ))}
      </div>
      <div className="rt-generating-card__skeletons" aria-hidden="true">
        <div className="rt-skeleton-card">
          <span />
          <i />
          <b />
        </div>
        <div className="rt-skeleton-card">
          <span />
          <i />
          <b />
        </div>
      </div>
    </section>
  );
}
