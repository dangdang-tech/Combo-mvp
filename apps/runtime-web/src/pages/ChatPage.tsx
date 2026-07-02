import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type {
  InputField,
  PublicCapabilityView,
  RuntimeArtifact,
  RuntimeMessage,
  TrialProcessState,
} from '@cb/shared';
import { createTrialSession, useSession } from '../api/runtime.js';
import { useAguiSession } from '../api/useAguiSession.js';
import { ArtifactRenderer } from '../components/ArtifactRenderer.js';
import { ChatThread } from '../components/ChatThread.js';
import { SessionSidebar } from '../components/SessionSidebar.js';

type PreviewMode = 'creator' | 'consumer';

function latestVersion(artifact: RuntimeArtifact | null) {
  return artifact?.versions.find((v) => v.version === artifact.latestVersion) ?? artifact?.versions.at(-1);
}

function fieldValue(values: Record<string, string>, field: InputField): string {
  return values[field.key]?.trim() ?? '';
}

function buildTrialPrompt(fields: InputField[], values: Record<string, string>, extra: string): string {
  const lines = fields
    .map((f) => {
      const value = fieldValue(values, f);
      return value ? `${f.label}：${value}` : null;
    })
    .filter(Boolean);
  if (extra.trim()) lines.push(`补充要求：${extra.trim()}`);
  return `请基于本次试用输入生成第一版 Persona Generator 画像卡。\n\n${lines.join('\n')}`;
}

function TrialIntakeForm({
  capability,
  disabled,
  onSubmit,
}: {
  capability: PublicCapabilityView;
  disabled: boolean;
  onSubmit: (prompt: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [extra, setExtra] = useState('');
  const requiredMissing = capability.inputs.fields.some((f) => f.required && !fieldValue(values, f));

  return (
    <section className="rt-intake" aria-label="本次试用输入">
      <div className="rt-intake__head">
        <span className="rt-intake__eyebrow">打开态</span>
        <h2>收集本次生成的输入</h2>
      </div>
      <div className="rt-intake__fields">
        {capability.inputs.fields.map((field) => (
          <label key={field.key} className={`rt-field${field.type === 'text' ? ' rt-field--wide' : ''}`}>
            <span className="rt-field__label">
              {field.label}
              {field.required && <span className="rt-field__req">*</span>}
            </span>
            {field.type === 'text' ? (
              <textarea
                className="rt-field__control"
                rows={3}
                value={values[field.key] ?? ''}
                disabled={disabled}
                onChange={(event) => setValues((s) => ({ ...s, [field.key]: event.target.value }))}
              />
            ) : (
              <input
                className="rt-field__control"
                type={field.type === 'number' ? 'number' : 'text'}
                value={values[field.key] ?? ''}
                disabled={disabled}
                onChange={(event) => setValues((s) => ({ ...s, [field.key]: event.target.value }))}
              />
            )}
          </label>
        ))}
        <label className="rt-field rt-field--wide">
          <span className="rt-field__label">补充要求</span>
          <textarea
            className="rt-field__control"
            rows={3}
            value={extra}
            disabled={disabled}
            onChange={(event) => setExtra(event.target.value)}
          />
        </label>
      </div>
      {capability.starterPrompts.length > 0 && (
        <div className="rt-starters">
          {capability.starterPrompts.map((prompt) => (
            <button
              key={prompt}
              type="button"
              className="rt-starter"
              disabled={disabled}
              onClick={() => setExtra(prompt)}
            >
              {prompt}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className="rt-btn rt-btn--accent rt-intake__start"
        disabled={disabled || requiredMissing}
        onClick={() => onSubmit(buildTrialPrompt(capability.inputs.fields, values, extra))}
      >
        {disabled ? '生成中…' : '开始生成'}
      </button>
    </section>
  );
}

function TrialProcessPanel({
  process,
  isRunning,
}: {
  process: TrialProcessState | null;
  isRunning: boolean;
}) {
  const steps =
    process?.steps ??
    [
      { key: 'read_experience', label: '读取经验体', status: isRunning ? 'running' : 'pending' },
      { key: 'cluster_persona', label: '聚类受众特征', status: 'pending' },
      { key: 'verify_quotes', label: '校验引用真实性', status: 'pending' },
      { key: 'layout_cards', label: '排版产物卡', status: 'pending' },
    ];
  return (
    <div className="rt-process" aria-label="生成过程">
      {steps.map((step) => (
        <div key={step.key} className="rt-process__step" data-status={step.status}>
          <span className="rt-process__dot" />
          <span className="rt-process__label">{step.label}</span>
        </div>
      ))}
    </div>
  );
}

function CreatorInspector({
  capability,
  onClose,
}: {
  capability: PublicCapabilityView;
  onClose: () => void;
}) {
  return (
    <aside className="rt-inspector" aria-label="创作者调试面板">
      <div className="rt-inspector__bar">
        <span>创作者面板</span>
        <button type="button" className="rt-icon-btn" onClick={onClose}>
          收起
        </button>
      </div>
      <div className="rt-inspector__tabs" role="tablist" aria-label="创作者信息">
        <button type="button" className="rt-inspector__tab is-active">
          经验体
        </button>
        <button type="button" className="rt-inspector__tab">
          规格说明
        </button>
        <button type="button" className="rt-inspector__tab">
          记忆
        </button>
      </div>
      <div className="rt-inspector__body">
        <p>当前模板字段：{capability.inputs.fields.length} 个</p>
        <p>引用要求：参考案例可选；不确定引用必须标注为模拟。</p>
        <p>输出规格：三张人物画像卡，包含引用、三项打分和一条可锁定异议。</p>
      </div>
    </aside>
  );
}

function FloatingChat({
  messages,
  isRunning,
  error,
  onSend,
  onInterrupt,
  onOpenArtifact,
}: {
  messages: RuntimeMessage[];
  isRunning: boolean;
  error: string | null;
  onSend: (text: string) => void;
  onInterrupt: () => void;
  onOpenArtifact: (ref: RuntimeMessage['artifacts'][number]) => void;
}) {
  const [text, setText] = useState('');
  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || isRunning) return;
    onSend(trimmed);
    setText('');
  };
  return (
    <section className="rt-floating-chat" aria-label="微调对话">
      <header className="rt-floating-chat__head">
        <span>微调对话</span>
        {isRunning && (
          <button type="button" className="rt-icon-btn" onClick={onInterrupt}>
            打断
          </button>
        )}
      </header>
      <ChatThread messages={messages} streamingText={null} onOpenArtifact={onOpenArtifact} />
      {error && <div className="rt-error rt-error--inline">{error}</div>}
      <div className="rt-floating-chat__input">
        <textarea
          value={text}
          disabled={isRunning}
          rows={2}
          placeholder="继续微调画像卡…"
          onChange={(event) => setText(event.target.value)}
        />
        <button type="button" className="rt-btn rt-btn--accent" disabled={isRunning || !text.trim()} onClick={submit}>
          发送
        </button>
      </div>
    </section>
  );
}

export function ChatPage() {
  const { slug, sessionId: routeSessionId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [createFailed, setCreateFailed] = useState(false);
  const [mode, setMode] = useState<PreviewMode>('creator');
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const startedSlugRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!slug || startedSlugRef.current === slug) return;
    startedSlugRef.current = slug;
    createTrialSession(slug)
      .then((data) => {
        void qc.invalidateQueries({ queryKey: ['sessions'] });
        navigate(`/session/${data.session.id}`, { replace: true });
      })
      .catch(() => setCreateFailed(true));
  }, [slug, navigate, qc]);

  const sessionId = routeSessionId;
  const sessionQ = useSession(sessionId);
  const detail = sessionQ.data;
  const capability = detail?.capability;
  const agui = useAguiSession(sessionId, detail);

  const activeArtifact = agui.activeKey
    ? (agui.artifacts.find((a) => a.artifactKey === agui.activeKey) ?? null)
    : (agui.artifacts.at(-1) ?? null);
  const activeVersion = latestVersion(activeArtifact);
  const hasStarted = agui.messages.length > 0;

  const uiMessages: RuntimeMessage[] = useMemo(
    () =>
      agui.messages.map((m, i) => ({
        id: m.id,
        seq: i,
        role: m.role,
        text: m.text,
        runId: null,
        artifacts: m.artifacts,
        createdAt: '',
      })),
    [agui.messages],
  );

  if (slug && !sessionId) {
    return (
      <div className="rt-loading">
        {createFailed ? (
          <div className="rt-error">无法开始试用：能力未找到、未发布，或当前账号无权试用。</div>
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

  return (
    <div className="rt-app rt-trial-app" data-view={mode}>
      <SessionSidebar activeSessionId={sessionId} />
      <div className="rt-trial">
        <div className="rt-trial__notice">
          <span>试用模式</span>
          <strong>这就是消费者将看到的界面</strong>
          <span>输入不计入对外数据</span>
        </div>

        <header className="rt-trial__head">
          <div>
            <div className="rt-trial__cap">{capability.name}</div>
            <div className="rt-trial__meta">v{capability.version} · @{capability.slug}</div>
          </div>
          <div className="rt-trial__actions">
            <div className="rt-segment" role="group" aria-label="预览身份">
              <button type="button" className={mode === 'creator' ? 'is-active' : ''} onClick={() => setMode('creator')}>
                创作者
              </button>
              <button type="button" className={mode === 'consumer' ? 'is-active' : ''} onClick={() => setMode('consumer')}>
                消费者
              </button>
            </div>
            {mode === 'creator' && (
              <button type="button" className="rt-btn" onClick={() => setInspectorOpen((v) => !v)}>
                {inspectorOpen ? '收起面板' : '经验体'}
              </button>
            )}
          </div>
        </header>

        <div className="rt-trial__body">
          <main className="rt-genui">
            <div className="rt-genui__bar">
              <span>{activeArtifact?.title ?? '试用画布'}</span>
              {activeArtifact && activeArtifact.versions.length > 1 && <span>v{activeArtifact.latestVersion}</span>}
            </div>
            <div className="rt-genui__canvas">
              {activeVersion ? (
                <ArtifactRenderer artifact={activeVersion} />
              ) : (
                <div className="rt-empty">暂无产物</div>
              )}
              {!hasStarted && (
                <div className="rt-genui__overlay">
                  <TrialIntakeForm capability={capability} disabled={agui.isRunning} onSubmit={(prompt) => agui.send(prompt)} />
                </div>
              )}
            </div>
            <TrialProcessPanel process={agui.trialProcess} isRunning={agui.isRunning} />
          </main>

          {mode === 'creator' && inspectorOpen && (
            <CreatorInspector capability={capability} onClose={() => setInspectorOpen(false)} />
          )}
        </div>

        {hasStarted && (
          <FloatingChat
            messages={uiMessages}
            isRunning={agui.isRunning}
            error={agui.error}
            onSend={(text) => agui.send(text)}
            onInterrupt={agui.interrupt}
            onOpenArtifact={(ref) => agui.setActiveKey(ref.artifactKey)}
          />
        )}
      </div>
    </div>
  );
}
