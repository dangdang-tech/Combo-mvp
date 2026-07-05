// 对话页（双栏）：左聊天流（落库消息 + 流式打字机）右产物画布。
//   恢复：GET /runtime/sessions/:id（详情真源）；实时：/stream SSE（useSessionStream）。
import { useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useSession } from '../api/runtime.js';
import { useSessionStream } from '../api/useSessionStream.js';
import { ArtifactPanel } from '../components/ArtifactPanel.js';
import { ChatThread } from '../components/ChatThread.js';
import { InputComposer } from '../components/InputComposer.js';
import { QueryErrorNotice } from '../components/QueryErrorNotice.js';
import { SessionSidebar } from '../components/SessionSidebar.js';
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

  // 创作端带 ?returnTo= 深链进来：记住它，侧栏「返回发布页」用。
  const queryReturnTo = safeRuntimeReturnTo(searchParams.get('returnTo'));
  const returnTo = queryReturnTo ?? readRuntimeReturnTo(sessionId);
  useEffect(() => {
    rememberRuntimeReturnTo(sessionId, queryReturnTo);
  }, [queryReturnTo, sessionId]);

  const activeArtifact = stream.activeArtifactId
    ? (stream.artifacts[stream.activeArtifactId] ?? null)
    : (stream.artifactList.at(-1) ?? null);

  return (
    <div className="rt-app">
      <SessionSidebar
        activeSessionId={sessionId}
        capabilityId={detail?.capability.id}
        capabilityName={detail?.capability.name}
        returnTo={returnTo}
      />
      <div className="rt-main">
        <section className="rt-conversation">
          {detail && (
            <header className="rt-conversation__head">
              <div className="rt-conversation__cap">{detail.capability.name}</div>
              <div className="rt-conversation__tag">{detail.capability.summary}</div>
            </header>
          )}
          {sessionQ.isPending ? (
            <div className="rt-loading">加载会话…</div>
          ) : sessionQ.isError || !detail ? (
            <QueryErrorNotice error={sessionQ.error} onRetry={() => void sessionQ.refetch()} />
          ) : (
            <>
              <ChatThread messages={detail.messages} streamingText={stream.streamingText} />
              {stream.errorMessage && (
                <div className="rt-error rt-error--inline">{stream.errorMessage}</div>
              )}
              <InputComposer
                disabled={stream.running}
                onSend={stream.send}
                onInterrupt={stream.interrupt}
              />
            </>
          )}
        </section>
        {activeArtifact && (
          <ArtifactPanel
            artifact={activeArtifact}
            artifacts={stream.artifactList}
            onSelectArtifact={stream.selectArtifact}
          />
        )}
      </div>
    </div>
  );
}
