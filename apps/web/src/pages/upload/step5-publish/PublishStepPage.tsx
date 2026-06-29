// STEP⑤ 发布容器（F-14，§5.5）——按 selection.mode 分流单条发布 / 批量发布（子集/全部发布）。
//
// 分流（40 §1.1(b) / 50 §2.3）：
//   - single（逐个选）：SinglePublish——市集卡预览 + 封面/价格 + 发布 →「Alpha·审核中」。底栏主按钮「发布到市集」。
//   - subset（勾选 N 项 / 全部发布，含旧兼容别名 all）：BatchPublish——按所选子集 candidateIds 一对一建批 + SSE job 流
//     逐项浮现 + 失败项重试/去补齐（无连坐，§2.3「子集即建批入参」）。底栏主按钮收起（批量在页内逐项跑）。
//   - 缺 selection / versionId：回上一步补选（不空打后端）。
//
// 末步：底栏不再是「下一步」；single 注册「发布到市集」主按钮，批量由页内列表驱动（底栏给「回工作台」语义）。
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { isSubsetSelection, selectionCandidateIds, type PublishBatchItemView } from '@cb/shared';
import { ErrorState } from '../../../components/index.js';
import { useWizard } from '../../wizard/index.js';
import { pathForStep } from '../../wizard/index.js';
import { toApiError } from '../localError.js';
import { CapabilitySwitcher } from '../CapabilitySwitcher.js';
import { SinglePublish } from './SinglePublish.js';
import { BatchPublish } from './BatchPublish.js';

export function PublishStepPage(): ReactElement {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const {
    draftId,
    selection,
    versionId: ctxVersionId,
    capabilityId: ctxCapabilityId,
    batchId: ctxBatchId,
    setBatchId,
    setPrimaryAction,
    setPublishCompleted,
  } = useWizard();

  // version 来源优先级（续传不缺版本，F-14）：URL ?version=（STEP④ 进入带入）→ 草稿续传回填的 ctxVersionId
  // （hydrateFromDraft 从 DraftView.versionId 恢复）。单发布据它发布，续传单发布不再因缺 version 报错。
  const urlVersionId = searchParams.get('version') ?? ctxVersionId ?? undefined;
  // capabilityId 来源（真实 capabilities.id，P1-5）：URL ?capability=（STEP④ 带入）→ 草稿续传回填的 ctxCapabilityId。
  //   单发布据它读 publication 拒绝态闭环——绝不拿 draftId 冒充（drafts.id ≠ capabilities.id，会 404 降级 publishable）。
  const capabilityId = searchParams.get('capability') ?? ctxCapabilityId ?? undefined;
  // batchId 来源：URL ?batchId=（续传带入）→ 草稿续传回填的 ctxBatchId，「全部发布」据它恢复同一批次不重建。
  const resumeBatchId = searchParams.get('batchId') ?? ctxBatchId ?? undefined;
  const mode = selection?.mode;
  // 批量态 = subset 或旧兼容别名 all（isSubsetSelection 统一判别，§4.G）；single 走单条发布。
  const isBatch = selection ? isSubsetSelection(selection) : false;
  // 批量建批的候选集 = 所选子集 candidateIds（subset/all 都经 selectionCandidateIds 规范取，§2.3 子集即建批入参）。
  const batchCandidateIds = selection && isBatch ? selectionCandidateIds(selection) : [];

  const goDashboard = useCallback(() => navigate('/creator'), [navigate]);

  // 回结构化补字段（失败项「去补齐」/ 单条缺前置）。
  const goStructure = useCallback(
    (item?: PublishBatchItemView) => {
      const qs = new URLSearchParams();
      if (draftId) qs.set('draftId', draftId);
      if (item?.versionId) qs.set('version', item.versionId);
      navigate(`${pathForStep('structure')}?${qs.toString()}`);
    },
    [draftId, navigate],
  );

  // 被拒「编辑后重发」（P1-5）：按被拒版派生新 draft 回结构化向导（40 端点 A fromVersionId=被拒版，§2.6.2）。
  //   不复用既有 ?version=（那会就地编辑被拒终态版、发布时 409）；走 fromVersionId 派生新 draft 才是闭环入口。
  const goEditResubmit = useCallback(
    (rejectedVersionId: string) => {
      const qs = new URLSearchParams();
      if (draftId) qs.set('draftId', draftId);
      qs.set('fromVersionId', rejectedVersionId);
      navigate(`${pathForStep('structure')}?${qs.toString()}`);
    },
    [draftId, navigate],
  );

  // —— 单条发布的底栏主按钮注册（「发布到市集」；batch 模式由页内驱动）——
  const [pubAction, setPubAction] = useState<{
    onPublish: () => void;
    busy: boolean;
    enabled: boolean;
  }>({ onPublish: () => undefined, busy: false, enabled: false });
  const registerPublish = useCallback(
    (a: { onPublish: () => void; busy: boolean; enabled: boolean }) => setPubAction(a),
    [],
  );
  // 单条发布是否已进入终态（发布成功，BUG-022）：底栏主按钮切「回工作台」、步骤条 STEP⑤ 标已完成。
  const [published, setPublished] = useState(false);

  useEffect(() => {
    if (mode === 'single' && urlVersionId && !published) {
      setPrimaryAction({
        label: pubAction.busy ? '发布中…' : '发布到市集',
        enabled: pubAction.enabled,
        busy: pubAction.busy,
        onNext: () => pubAction.onPublish(),
      });
    } else {
      // 批量 / 无 single / 单条已发布成功（终态）：底栏给「回工作台」（不再保留禁用的「发布到市集」，BUG-022）。
      setPrimaryAction({ label: '回工作台', enabled: true, onNext: goDashboard });
    }
    return () => setPrimaryAction(null);
  }, [mode, urlVersionId, published, pubAction, setPrimaryAction, goDashboard]);

  // 单条发布成功 → 标步骤条 STEP⑤ 终态「已完成」（与底栏「回工作台」+ 页面主体「Alpha 人工评审中」一致，BUG-022）。
  //   仅 single 终态标；卸载/换批量模式时清回 false，不影响未发布态与批量态步骤条。
  useEffect(() => {
    if (published && mode === 'single') {
      setPublishCompleted(true);
      return () => setPublishCompleted(false);
    }
    return undefined;
  }, [published, mode, setPublishCompleted]);

  // 左侧能力切换项（single 一项；批量列出整批候选，子集即子集 N 项）。
  const switcherItems = useMemo(() => {
    if (isBatch) {
      return batchCandidateIds.map((id, i) => ({ key: id, name: `能力 ${i + 1}` }));
    }
    if (mode === 'single' && urlVersionId) {
      return [{ key: urlVersionId, name: '当前能力' }];
    }
    return [];
  }, [isBatch, batchCandidateIds, mode, urlVersionId]);

  // 左侧当前选中项（§5.5「在这一批能力之间切换」，发布-09）：默认首项；onSelect 真实切换
  //   → 批量页中间市集卡预览随之换到该能力（切换看卡），与发布结果列表并存（切换看卡 + 发布后看结果）。
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // switcherItems 变化（首挂载 / 批次候选恢复）时，无选中或选中项已不在列表 → 落回首项（不悬空）。
  useEffect(() => {
    setActiveKey((prev) =>
      prev && switcherItems.some((it) => it.key === prev) ? prev : (switcherItems[0]?.key ?? null),
    );
  }, [switcherItems]);

  // —— 缺 selection：回上一步补选 ——
  if (!mode) {
    return (
      <ErrorState
        error={toApiError(null, '还没选好要发布的能力，回上一步选一下。', 'change_input')}
        onChangeInput={() =>
          navigate(pathForStep('select') + (draftId ? `?draftId=${draftId}` : ''))
        }
      />
    );
  }

  return (
    <div className="cb-publish" data-mode={mode}>
      {/* 步内标题（Figma STEP⑤ 1778:24：步骤条下「发布到市集」+ 副文案，content 自带标题，不复用外壳页名）。 */}
      <header className="cb-publish__head">
        <h2 className="cb-publish__title">发布到市集</h2>
        <p className="cb-publish__subtitle">右边这张卡就是市集里看到的样子。左侧可切换能力。</p>
      </header>

      <div className="cb-publish__cols">
        {/* 左：能力切换列表（§5.5 与上一步一致；切换换中间市集卡预览，发布-09）。 */}
        <aside className="cb-publish__left">
          <CapabilitySwitcher items={switcherItems} activeKey={activeKey} onSelect={setActiveKey} />
        </aside>

        <div className="cb-publish__content">
          {mode === 'single' ? (
            urlVersionId ? (
              <SinglePublish
                versionId={urlVersionId}
                capabilityId={capabilityId}
                registerPublish={registerPublish}
                onDone={goDashboard}
                onEditResubmit={goEditResubmit}
                onPublished={() => setPublished(true)}
              />
            ) : (
              <ErrorState
                error={toApiError(
                  null,
                  '少了要发布的版本，回上一步重新进入结构化。',
                  'change_input',
                )}
                onChangeInput={() =>
                  navigate(pathForStep('structure') + (draftId ? `?draftId=${draftId}` : ''))
                }
              />
            )
          ) : (
            <BatchPublish
              candidateIds={batchCandidateIds}
              activeCandidateId={activeKey}
              onFixUp={(item) => goStructure(item)}
              resumeBatchId={resumeBatchId}
              onBatchReady={setBatchId}
              draftId={draftId}
            />
          )}
        </div>
      </div>
    </div>
  );
}
