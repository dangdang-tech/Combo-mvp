// 单条发布（F-14，§5.5）——市集卡预览 + 封面/价格设定 + 发布 →「Alpha·审核中」；拒绝态可见 + 编辑重发。
//
// 三栏（§5.5）：左 能力切换（single 即一项，由父层 PublishStepPage 渲染）；中 市集卡预览；右 来源说明表。
// 流程：
//   1. 进页先读发布态（fetchPublication，§2.6.2）：若本版恰是最近被拒版（review_rejected + rejectedVersionId===本版）
//      → 直接出拒绝态（人话原因 + 「编辑后重发」派生新 draft 回结构化，P1-5）；否则进可发布表单。
//   2. previewMarketCard（端点 §2.2，只读）拿当前软字段 + 封面/价格组装的卡（封面/价格切换不丢，发布-10）。
//   3. 创作者设封面来源（本期仅字形可用，P1-6）+ 价格 → 实时本地重算卡价格 / 封面。
//   4. 「发布到市集」→ publishVersion（端点 §2.1，同步事务）→ 成功显「Alpha·审核中」（发布-15）。
// 合规：永不裸转圈（预览/读态加载 Skeleton、发布中按钮 busy）；绝不裸露错误码（ErrorState / 人话 rejectReason）；
//   发布失败保留已编辑封面/价格/软字段（前端态不清空，发布-19）；封面绝不发半成品（buildCoverInput 兜底，P1-6）。
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type {
  MarketCard,
  CoverSource,
  PublishResult,
  PublishVersionBody,
  PublicationView,
} from '@cb/shared';
import type { ApiError, RequestOptions } from '../../../api/index.js';
import { ErrorState, LoadingState } from '../../../components/index.js';
import { toApiError, isAbort } from '../localError.js';
import { MarketCardPreview } from './MarketCardPreview.js';
import { CoverPicker } from './CoverPicker.js';
import { SourceTable } from './SourceTable.js';
import { PublishStatus } from './PublishStatus.js';
import { previewMarketCard, publishVersion, fetchPublication } from './publishApi.js';
import { buildCoverInput } from './coverInput.js';
import { yuanToMicros, priceDisplay } from './price.js';

type PreviewState =
  | { kind: 'loading' }
  | { kind: 'ready'; card: MarketCard }
  | { kind: 'error'; error: ApiError };

/** 进页读发布态的结果（拒绝态分流 vs 可发布）。 */
type ReviewGate =
  | { kind: 'checking' } // 正在读发布态（§2.6.2）。
  | { kind: 'publishable' } // 未被拒（或无 capabilityId 可读）→ 进发布表单。
  | { kind: 'rejected'; reason?: string; rejectedVersionId: string }; // 本版最近被拒 → 拒绝态可见。

export interface SinglePublishProps {
  versionId: string;
  /** 真实能力体 id（capabilities.id，STEP④ 建版回填 / 续传带入；非 draftId，P1-5）。有则进页读发布态、拒绝分流。 */
  capabilityId?: string | undefined;
  /** 注册底栏主按钮（「发布到市集」）。父层 PublishStepPage 给。 */
  registerPublish: (action: { onPublish: () => void; busy: boolean; enabled: boolean }) => void;
  /** 发布成功后回工作台。 */
  onDone: () => void;
  /** 「编辑后重发」：按被拒版派生新 draft 回结构化向导（fromVersionId，P1-5 闭环入口）。 */
  onEditResubmit: (rejectedVersionId: string) => void;
  /** 单条发布进入终态（发布成功，reviewStatus=alpha_pending/published）时上抛，供父层切底栏+步骤条终态（BUG-022）。 */
  onPublished?: (reviewStatus: PublishResult['reviewStatus']) => void;
}

export function SinglePublish({
  versionId,
  capabilityId,
  registerPublish,
  onDone,
  onEditResubmit,
  onPublished,
}: SinglePublishProps): ReactElement {
  const [preview, setPreview] = useState<PreviewState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [coverSource, setCoverSource] = useState<CoverSource>('glyph');
  const [priceYuan, setPriceYuan] = useState<string>('');
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<PublishResult | null>(null);
  // 进页发布态分流（拒绝态可见，P1-5）。无 capabilityId 直接 publishable（无从读态，不空打）。
  const [gate, setGate] = useState<ReviewGate>(
    capabilityId ? { kind: 'checking' } : { kind: 'publishable' },
  );

  // —— 进页读发布态（§2.6.2）：本版恰是最近被拒版 → 拒绝态可见 + 编辑重发（P1-5）——
  useEffect(() => {
    if (!capabilityId || result) return;
    const ctrl = new AbortController();
    let active = true;
    setGate({ kind: 'checking' });
    void (async () => {
      try {
        const pub: PublicationView = await fetchPublication(capabilityId, { signal: ctrl.signal });
        if (!active) return;
        // 拒绝态单一真源（B-30/发布-31）：读 displayState.rejected（覆盖 review_rejected 下架 **和** 回退到上一版后
        //   review_status='published' 但带被拒原因镜像的回退拒绝态），绝不自行从 reviewStatus 码拼装（避免漏掉回退态，
        //   Codex r3）。displayState 缺省（旧响应兜底）时回落 reviewStatus==='review_rejected'。
        const rejectedVisible =
          pub.displayState?.rejected ?? pub.reviewStatus === 'review_rejected';
        const rejectedReason = pub.displayState?.rejectReason ?? pub.rejectReason;
        // 仅当「本版自己」被拒才进拒绝态（被拒版本线只标被拒那一版，§1.3）；其它版被拒不挡本版发布。
        if (rejectedVisible && pub.rejectedVersionId === versionId) {
          setGate({
            kind: 'rejected',
            ...(rejectedReason != null ? { reason: rejectedReason } : {}),
            rejectedVersionId: pub.rejectedVersionId,
          });
        } else {
          setGate({ kind: 'publishable' });
        }
      } catch (e) {
        if (!active || isAbort(e)) return;
        // 读发布态失败不挡发布（容错降级）：当作可发布，发布门事务自身仍会按真态校验（§2.1）。
        setGate({ kind: 'publishable' });
      }
    })();
    return () => {
      active = false;
      ctrl.abort();
    };
  }, [capabilityId, versionId, result]);

  // —— 预览市集卡（封面/价格切换重取；只读，不写库，发布-10）。仅 publishable 态预览——
  useEffect(() => {
    if (result || gate.kind !== 'publishable') return; // 已发布 / 拒绝态 / 读态中不预览。
    const ctrl = new AbortController();
    let active = true;
    setPreview({ kind: 'loading' });
    const opts: RequestOptions = { signal: ctrl.signal };
    void (async () => {
      try {
        const tiers =
          priceYuan.trim() !== ''
            ? [{ tierCode: 'standard', priceMicros: yuanToMicros(Number(priceYuan) || 0) }]
            : undefined;
        const card = await previewMarketCard(
          versionId,
          { cover: buildCoverInput(coverSource), ...(tiers ? { tiers } : {}) },
          opts,
        );
        if (active) setPreview({ kind: 'ready', card });
      } catch (e) {
        if (!active || isAbort(e)) return;
        setPreview({ kind: 'error', error: toApiError(e, '市集卡预览没加载出来，请重试。') });
      }
    })();
    return () => {
      active = false;
      ctrl.abort();
    };
  }, [versionId, coverSource, priceYuan, attempt, result, gate.kind]);

  // —— 发布（端点 §2.1 同步事务；失败保留已编辑内容，发布-19）——
  // 复用同一 idempotencyKey 重发（重试用同 key，回放首次结果，发布-20/贯穿-13）。
  const idemKeyRef = useRef<string>(
    globalThis.crypto?.randomUUID?.() ?? `pub-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  const doPublish = (): void => {
    if (publishing || result) return;
    setPublishing(true);
    setPublishError(null);
    void (async () => {
      try {
        const tiers =
          priceYuan.trim() !== ''
            ? [{ tierCode: 'standard', priceMicros: yuanToMicros(Number(priceYuan) || 0) }]
            : [{ tierCode: 'standard', priceMicros: 0 }]; // 未设价默认免费（≥1 tier 必填，§2.1）。
        const body: PublishVersionBody = {
          cover: buildCoverInput(coverSource), // 绝不发半成品封面（P1-6）。
          tiers,
          visibility: 'public',
        };
        const res = await publishVersion(versionId, body, idemKeyRef.current);
        setResult(res);
      } catch (e) {
        if (isAbort(e)) return;
        setPublishError(toApiError(e, '发布没成功，请重试。'));
      } finally {
        setPublishing(false);
      }
    })();
  };

  // 注册底栏主按钮（发布到市集）。已发布 / 拒绝态 / 读态中禁用。
  const doPublishRef = useRef(doPublish);
  doPublishRef.current = doPublish;
  const canPublish = preview.kind === 'ready' && !result && gate.kind === 'publishable';
  useEffect(() => {
    registerPublish({
      onPublish: () => doPublishRef.current(),
      busy: publishing,
      enabled: canPublish,
    });
  }, [registerPublish, publishing, canPublish]);

  // 发布成功上抛终态（BUG-022）：result 出现即通知父层切底栏「回工作台」+ 步骤条标已完成。
  //   onPublished 经 ref 读，避免父层每渲染换引用把它放进 effect 依赖触发误抛；依赖仅 [result]，发布成功仅触发一次。
  const onPublishedRef = useRef(onPublished);
  onPublishedRef.current = onPublished;
  useEffect(() => {
    if (result) onPublishedRef.current?.(result.reviewStatus);
  }, [result]);

  // —— 已发布：显「Alpha·审核中」（发布-15）——
  if (result) {
    return (
      <PublishStatus
        reviewStatus={result.reviewStatus}
        marketUrl={result.marketUrl}
        onDone={onDone}
      />
    );
  }

  // —— 进页读发布态中：永不裸转圈（Skeleton 安抚）——
  if (gate.kind === 'checking') {
    return <LoadingState skeletonRows={3} label="正在检查发布状态" />;
  }

  // —— 拒绝态可见：人话原因 + 「编辑后重发」（派生新 draft 回结构化，P1-5）——
  if (gate.kind === 'rejected') {
    return (
      <PublishStatus
        reviewStatus="review_rejected"
        rejectReason={gate.reason}
        onEditResubmit={() => onEditResubmit(gate.rejectedVersionId)}
        onDone={onDone}
      />
    );
  }

  return (
    <div className="cb-single-publish">
      {publishError && (
        <ErrorState
          error={publishError}
          onRetry={() => {
            setPublishError(null);
            doPublish();
          }}
          onChangeInput={() => setPublishError(null)}
          onEscalate={() => setPublishError(null)}
        />
      )}

      <div className="cb-single-publish__cols">
        {/* 中：市集卡预览。 */}
        <main className="cb-single-publish__center">
          {preview.kind === 'loading' ? (
            <LoadingState skeletonRows={4} label="市集卡预览加载中" />
          ) : preview.kind === 'error' ? (
            <ErrorState error={preview.error} onRetry={() => setAttempt((a) => a + 1)} />
          ) : (
            <MarketCardPreview card={preview.card} onTrial={() => undefined} />
          )}

          {/* 封面 + 价格设定（创作者发布前设定，发布-11~14；封面本期仅字形可用，P1-6）。 */}
          <div className="cb-single-publish__settings">
            <CoverPicker source={coverSource} onChange={setCoverSource} />
            <label className="cb-price-input">
              <span className="cb-price-input__label">价格（元，留空=免费）</span>
              <input
                className="cb-price-input__field"
                type="number"
                min={0}
                step="0.01"
                value={priceYuan}
                onChange={(e) => setPriceYuan(e.target.value)}
                placeholder="0.00"
              />
              <span className="cb-price-input__display">
                {priceDisplay(
                  priceYuan.trim() !== '' ? yuanToMicros(Number(priceYuan) || 0) : null,
                )}
              </span>
            </label>
          </div>
        </main>

        {/* 右：来源说明表（发布-06，静态映射）。 */}
        <SourceTable />
      </div>
    </div>
  );
}
