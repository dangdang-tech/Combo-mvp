import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { RuntimeSessionListItem } from '@cb/shared';
import { createProductionSession, useCapabilities, useSessions } from '../api/runtime.js';

interface LinkedSessions {
  trial?: RuntimeSessionListItem;
  consume?: RuntimeSessionListItem;
}

type EmptyMarketMode = 'guide' | 'examples';

interface ExampleCapability {
  name: string;
  typeLabel: string;
  audience: string;
  outcome: string;
  context: string;
}

const exampleCapabilities: ExampleCapability[] = [
  {
    name: '真实长会话能力提取评审',
    typeLabel: '产品 / 流程',
    audience: '正在把私有经验产品化的创作者',
    outcome: '判断候选能力是否独特、利他、可运行',
    context: '来自创作者对真实 session 聚类质量、泛任务过滤和发布边界的连续讨论',
  },
  {
    name: 'Figma 到前端的品牌刷新',
    typeLabel: '设计 / 前端',
    audience: '需要把新品牌落进已有产品界面的团队',
    outcome: '输出页面结构、状态、组件和实现要点',
    context: '来自 Combo 品牌、侧边栏、加载态和上传流程设计调整记录',
  },
  {
    name: '本地真实配置测试闭环',
    typeLabel: '工程 / QA',
    audience: '需要验证 Docker、登录、导入、发布和 runtime 的开发者',
    outcome: '给出可复跑的测试证据、阻塞项和修复建议',
    context: '来自真实 .env、真实导入内容、真实 snapshot 的连续验收任务',
  },
];

function groupSessionsBySlug(items: RuntimeSessionListItem[]): Map<string, LinkedSessions> {
  const grouped = new Map<string, LinkedSessions>();
  for (const item of items) {
    const linked = grouped.get(item.slug) ?? {};
    if (item.mode === 'consume' && !linked.consume) linked.consume = item;
    if (item.mode === 'trial' && !linked.trial) linked.trial = item;
    grouped.set(item.slug, linked);
  }
  return grouped;
}

function modeLabel(mode: RuntimeSessionListItem['mode']): string {
  return mode === 'consume' ? '正式' : '试用';
}

export function MarketPage() {
  const navigate = useNavigate();
  const caps = useCapabilities();
  const sessions = useSessions();
  const [emptyMode, setEmptyMode] = useState<EmptyMarketMode>('guide');
  const [pendingSlug, setPendingSlug] = useState<string | null>(null);
  const [errorSlug, setErrorSlug] = useState<string | null>(null);
  const sessionsBySlug = useMemo(
    () => groupSessionsBySlug(sessions.data?.items ?? []),
    [sessions.data?.items],
  );

  const enterProduction = async (slug: string, name: string, existing?: RuntimeSessionListItem) => {
    if (existing) {
      navigate(`/session/${existing.id}`);
      return;
    }
    setPendingSlug(slug);
    setErrorSlug(null);
    try {
      const created = await createProductionSession(slug, name);
      navigate(`/session/${created.session.id}`);
    } catch {
      setErrorSlug(slug);
    } finally {
      setPendingSlug(null);
    }
  };

  return (
    <div className="rt-market">
      <section className="rt-market__hero">
        <h1 className="rt-market__title">挑一个能力，直接开聊</h1>
        <p className="rt-market__lede">
          每个能力都从一次真实会话里长出来。选一个，像和它对话一样把活干完——产物会实时生成在右侧。
        </p>
      </section>

      {sessions.data && sessions.data.items.length > 0 && (
        <section className="rt-market__section">
          <h2 className="rt-market__section-title">继续之前的会话</h2>
          <div className="rt-session-chips">
            {sessions.data.items.slice(0, 8).map((s) => (
              <Link key={s.id} to={`/session/${s.id}`} className="rt-session-chip">
                <span className="rt-session-chip__title">{s.title}</span>
                <span className="rt-session-chip__cap">
                  {s.capabilityName} · {modeLabel(s.mode)}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="rt-market__section">
        <h2 className="rt-market__section-title">能力市集</h2>
        {caps.isLoading && <div className="rt-empty">加载中…</div>}
        {caps.isError && <div className="rt-empty rt-empty--error">能力列表加载失败，请刷新。</div>}
        {caps.data && caps.data.items.length === 0 && (
          <EmptyMarket mode={emptyMode} onModeChange={setEmptyMode} />
        )}
        <div className="rt-card-grid">
          {caps.data?.items.map((c) => {
            const linked = sessionsBySlug.get(c.slug);
            const isPending = pendingSlug === c.slug;
            const trialLabel = linked?.trial ? '继续试用' : '试用';
            const productionLabel = linked?.consume ? '继续使用' : '直接使用';

            return (
              <article key={c.capabilityId} className="rt-card">
                <div className="rt-card__type">{c.typeLabel}</div>
                <h3 className="rt-card__name">{c.name}</h3>
                <p className="rt-card__tagline">{c.tagline}</p>
                <div className="rt-card__meta">
                  <span className="rt-card__byline">{c.byline}</span>
                  <span>
                    {linked?.consume ? '已有正式会话' : linked?.trial ? '已有试用会话' : '尚未运行'}
                  </span>
                </div>
                <div className="rt-card__foot">
                  <button
                    type="button"
                    className="rt-btn"
                    onClick={() =>
                      navigate(linked?.trial ? `/session/${linked.trial.id}` : `/c/${c.slug}`)
                    }
                  >
                    {trialLabel}
                  </button>
                  <button
                    type="button"
                    className="rt-btn rt-btn--accent"
                    disabled={isPending}
                    onClick={() => void enterProduction(c.slug, c.name, linked?.consume)}
                  >
                    {isPending ? '创建中…' : productionLabel}
                  </button>
                </div>
                {errorSlug === c.slug && (
                  <div className="rt-card__error">无法进入正式使用，请稍后重试。</div>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

interface EmptyMarketProps {
  mode: EmptyMarketMode;
  onModeChange: (mode: EmptyMarketMode) => void;
}

function EmptyMarket({ mode, onModeChange }: EmptyMarketProps) {
  return (
    <div className="rt-market-empty">
      <div className="rt-market-empty__intro">
        <div className="rt-market-empty__kicker">当前没有公开发布的能力</div>
        <h3 className="rt-market-empty__title">市集还在等第一个真实能力上架</h3>
        <p className="rt-market-empty__copy">
          能力只会在创作者确认发布后出现在这里。未发布的候选、原始 session
          和证据不会进入外部用户视角。
        </p>
        <div className="rt-market-empty__actions" aria-label="空市集操作">
          <a className="rt-btn rt-btn--accent" href="/create/import">
            去发布第一个能力
          </a>
          <button
            type="button"
            className="rt-btn"
            aria-pressed={mode === 'examples'}
            onClick={() => onModeChange('examples')}
          >
            查看示例能力
          </button>
          <button
            type="button"
            className="rt-btn"
            aria-pressed={mode === 'guide'}
            onClick={() => onModeChange('guide')}
          >
            了解如何发布
          </button>
        </div>
      </div>

      {mode === 'examples' ? (
        <div className="rt-market-empty__examples" aria-label="示例能力">
          {exampleCapabilities.map((item) => (
            <article className="rt-example-card" key={item.name}>
              <div className="rt-example-card__head">
                <span className="rt-card__type">{item.typeLabel}</span>
                <span className="rt-example-card__badge">示例，不可运行</span>
              </div>
              <h4 className="rt-example-card__title">{item.name}</h4>
              <dl className="rt-example-card__facts">
                <div>
                  <dt>帮助谁</dt>
                  <dd>{item.audience}</dd>
                </div>
                <div>
                  <dt>交付什么</dt>
                  <dd>{item.outcome}</dd>
                </div>
                <div>
                  <dt>为什么独特</dt>
                  <dd>{item.context}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      ) : (
        <ol className="rt-market-empty__steps" aria-label="发布流程">
          <li>
            <span className="rt-market-empty__step-index">1</span>
            <div>
              <strong>导入真实会话</strong>
              <p>从创作者自己的长 session 开始，保留足够上下文让系统识别独特经验。</p>
            </div>
          </li>
          <li>
            <span className="rt-market-empty__step-index">2</span>
            <div>
              <strong>筛掉泛任务</strong>
              <p>只留下和创作者 context 强相关、能帮助他人的候选能力。</p>
            </div>
          </li>
          <li>
            <span className="rt-market-empty__step-index">3</span>
            <div>
              <strong>确认后发布</strong>
              <p>创作者发布后，外部用户才能在市集开聊；未发布内容不会展示。</p>
            </div>
          </li>
        </ol>
      )}
    </div>
  );
}
