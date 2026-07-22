// 会话页（GUI 形态）：产物画布是主界面，聊天是稳定的修改工作区——
//   - 首次进入（还没有消息）画布上盖开场表单（TrialIntakeForm，按能力定义的字段渲染）；
//   - 第一轮生成中且还没有任何产物时显示诚实的页面骨架；
//   - 有产物后画布渲染产物（多产物顶部 chips 切换），左侧对话负责反复微调；
//   - 恢复：GET /runtime/sessions/:id（详情真源）；实时：/stream SSE（useSessionStream）。
import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { ArtifactView } from '@cb/shared';
import { useArtifactContent, useSession } from '../api/runtime.js';
import { useSessionStream } from '../api/useSessionStream.js';
import { ArtifactRenderer } from '../components/ArtifactRenderer.js';
import { FloatingChat } from '../components/FloatingChat.js';
import { GeneratingPageSkeleton } from '../components/GeneratingPageSkeleton.js';
import { QueryErrorNotice } from '../components/QueryErrorNotice.js';
import { SessionSidebar } from '../components/SessionSidebar.js';
import { TrialIntakeForm } from '../components/TrialIntakeForm.js';
import { downloadArtifact } from '../components/artifactDownload.js';
import {
  readRuntimeReturnTo,
  rememberRuntimeReturnTo,
  safeRuntimeReturnTo,
} from '../navigation/runtimeReturn.js';
import { useDocumentTitle } from '../shell/useDocumentTitle.js';

export type TrialCanvasState = 'intake' | 'running' | 'output';

/** Pure state contract: streamed prose never counts as a rendered artifact. */
export function resolveTrialCanvasState(input: {
  messageCount: number;
  running: boolean;
  hasArtifact: boolean;
}): TrialCanvasState {
  if (input.running && !input.hasArtifact) return 'running';
  if (input.messageCount === 0 && !input.hasArtifact) return 'intake';
  return 'output';
}

export function ChatPage() {
  const { sessionId } = useParams();
  const [searchParams] = useSearchParams();
  const sessionQ = useSession(sessionId);
  const detail = sessionQ.data;
  const stream = useSessionStream(sessionId, detail?.artifacts);
  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false);
  const runStartedAtRef = useRef<number | null>(null);
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
  useDocumentTitle(capability ? `${capability.name} · Combo 试用` : undefined);
  const sidebarCapability = capability
    ? { id: capability.id, name: capability.name }
    : lastSidebarCapability;
  const messages = detail?.messages ?? [];
  const activeArtifact = stream.activeArtifactId
    ? (stream.artifacts[stream.activeArtifactId] ?? null)
    : (stream.artifactList.at(-1) ?? null);

  // 画布状态机：intake（还没开始）→ running（第一轮生成、尚无任何产出）→ output。
  // 流式解释不是产物：第一段文字到达后也要继续保留页面骨架，直到真正产物出现。
  const canvasState = resolveTrialCanvasState({
    messageCount: messages.length,
    running: stream.running,
    hasArtifact: activeArtifact !== null,
  });
  const hasStarted = canvasState !== 'intake';
  const showIntake = canvasState === 'intake';
  const showGenerating = canvasState === 'running';
  if (stream.running && runStartedAtRef.current === null) runStartedAtRef.current = Date.now();
  if (!stream.running && runStartedAtRef.current !== null) runStartedAtRef.current = null;
  const runStartedAt = runStartedAtRef.current ?? undefined;

  useEffect(() => {
    if (!capability) return;
    setLastSidebarCapability((current) =>
      current?.id === capability.id && current.name === capability.name
        ? current
        : { id: capability.id, name: capability.name },
    );
  }, [capability?.id, capability?.name]);

  useEffect(() => {
    setMobileSessionsOpen(false);
  }, [sessionId]);

  useEffect(() => {
    if (!mobileSessionsOpen) return undefined;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMobileSessionsOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [mobileSessionsOpen]);

  return (
    <div className="rt-app rt-trial-app">
      <SessionSidebar
        activeSessionId={sessionId}
        capabilityId={sidebarCapability?.id}
        capabilityName={sidebarCapability?.name}
        returnTo={returnTo}
        runningSessionId={stream.running ? sessionId : undefined}
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
              <div className="rt-trial__actions">
                <button
                  type="button"
                  className="rt-toolbar-pill rt-mobile-sessions-trigger"
                  aria-expanded={mobileSessionsOpen}
                  aria-controls="rt-mobile-session-panel"
                  onClick={() => setMobileSessionsOpen(true)}
                >
                  会话管理
                </button>
                {returnTo ? (
                  <button
                    type="button"
                    className="rt-toolbar-pill"
                    onClick={() => window.location.assign(returnTo)}
                  >
                    返回发布流程
                  </button>
                ) : (
                  <a className="rt-toolbar-pill" href="/capabilities">
                    返回我的 Agent
                  </a>
                )}
              </div>
            </header>

            <main className={`rt-genui${hasStarted ? ' rt-genui--conversation' : ''}`}>
              {hasStarted && sessionId && (
                <FloatingChat
                  key={sessionId}
                  sessionId={sessionId}
                  messages={messages}
                  streamingText={stream.streamingText}
                  isRunning={stream.running}
                  hasArtifact={activeArtifact !== null}
                  error={stream.errorMessage}
                  onSend={stream.send}
                  onInterrupt={stream.interrupt}
                />
              )}
              <div className="rt-genui__canvas" data-state={canvasState}>
                {/* 首轮失败时 FloatingChat 尚未挂载（hasStarted=false），错误必须在画布可见，
                    否则用户只看到生成卡一闪回表单、零解释（A7）。 */}
                {stream.errorMessage && !hasStarted && (
                  <div className="rt-inline-error" role="alert">
                    {stream.errorMessage}
                  </div>
                )}
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
                    <GeneratingPageSkeleton startedAt={runStartedAt} />
                  </div>
                )}
              </div>
            </main>
          </>
        )}
      </div>
      {mobileSessionsOpen && (
        <div
          className="rt-mobile-session-layer"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setMobileSessionsOpen(false);
          }}
        >
          <section
            id="rt-mobile-session-panel"
            className="rt-mobile-session-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rt-mobile-session-title"
          >
            <div className="rt-mobile-session-panel__head">
              <h2 id="rt-mobile-session-title">会话管理</h2>
              <button
                type="button"
                autoFocus
                aria-label="关闭会话管理"
                onClick={() => setMobileSessionsOpen(false)}
              >
                ×
              </button>
            </div>
            <SessionSidebar
              activeSessionId={sessionId}
              capabilityId={sidebarCapability?.id}
              capabilityName={sidebarCapability?.name}
              returnTo={returnTo}
              runningSessionId={stream.running ? sessionId : undefined}
              instanceId="mobile"
              onNavigate={() => setMobileSessionsOpen(false)}
            />
          </section>
        </div>
      )}
    </div>
  );
}

/** 产物舞台：内容回读（GET /runtime/artifacts/:id/content）+ 按 kind 渲染，占满画布。 */
function ArtifactStage({ artifact }: { artifact: ArtifactView }) {
  const content = useArtifactContent(artifact);
  const title = artifact.title ?? '未命名产物';
  return (
    <div className="rt-artifact-stage">
      <div className="rt-artifact-stage__actions">
        <button
          type="button"
          className="rt-toolbar-pill rt-artifact-download"
          disabled={content.data === undefined || content.isPending || content.isError}
          onClick={() => {
            if (content.data !== undefined) downloadArtifact(title, artifact.kind, content.data);
          }}
        >
          {content.isPending ? '准备下载…' : '下载产物'}
        </button>
      </div>
      {content.isPending ? (
        <div className="rt-empty">产物加载中…</div>
      ) : content.isError ? (
        <div className="rt-empty rt-empty--error">产物内容加载失败，稍后重试。</div>
      ) : (
        <ArtifactRenderer kind={artifact.kind} title={title} content={content.data} />
      )}
    </div>
  );
}
