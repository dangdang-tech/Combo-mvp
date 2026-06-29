// STEP③ 选择（F-12，§5.2/§5.3）——纯前端即时、无加载态、不写库（§1.1(a)）。
//
// 页面构成（§5.3.1 / 选择结构化-01）：
//   1. 顶部醒目整体选项「全部发布（不逐个选）」——选它 = 对【当前子集】（STEP② 勾选带入的 subset）或【全部 ready
//      候选】进批量发布（§5.2/§5.3 / 选择结构化-06）。带子集进来时该选项发布的是子集 N 项（文案显「这 N 项」）；
//      无子集（直进/续传只剩 single 态）时发布全部 ready。写 mode='subset'（新规范），绝不写 'all'（仅旧草稿兼容别名）。
//   2. 「或逐个选定一个」单选互斥列表，每行四项（选择结构化-02）：能力名称 / 一句话类型 / 支撑段数 / 置信度。
// 交互：
//   - 选择切换纯前端即时写 wizard.setSelection，绝不打后端、绝不裸转圈（选择结构化-05/30）。
//   - 单选互斥：选 B 自动取消 A（选择结构化-04）。
//   - 选中单个 → 底栏主按钮变「下一步：结构化『X』」（§5.3 / 选择结构化-03）；
//     全部发布（subset）→ 「下一步：全部发布这 N 项 →」（N 与「全部」区分清楚，§5.2/§5.3）。
//   - 「保存草稿」/ 进入下一步才 persist（patchSelection，端点 G）——本组件只管选择态 + 注册底栏主按钮行为。
import { useEffect, useRef, type ReactElement } from 'react';
import {
  isSubsetSelection,
  selectionCandidateIds,
  type CandidateView,
  type CapabilityType,
  type Confidence,
  type SelectionDraft,
} from '@cb/shared';
import { useWizard } from './WizardContext.js';

/** 一句话类型人话（§5.3「打分器 / PRD 工具 / 核查 / 陪练」级别的类型标签，取契约 CapabilityType 映射）。 */
const TYPE_LABEL: Record<CapabilityType, string> = {
  'core-workflow': '核心工作流',
  recurring: '经常出现',
  occasional: '偶尔出现',
};

/** 置信枚举人话（契约 confidence: high|med|low）。 */
const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: '高',
  med: '中',
  low: '低',
};

/**
 * 置信度展示（选择结构化-02「置信 86%」）：
 *   - 有 scopeCoherence(0~1) → 折算百分比「置信 86%」（系统对「适合打包」的把握，§5.3）。
 *   - 否则退化为枚举「置信 高/中/低」（契约只给枚举时不臆造百分比）。
 *   - 两者皆缺 → 「置信 —」（不显 undefined/空白，选择结构化-02）。
 */
function confidenceText(c: CandidateView): string {
  if (typeof c.scopeCoherence === 'number') {
    return `置信 ${Math.round(c.scopeCoherence * 100)}%`;
  }
  if (c.confidence) return `置信 ${CONFIDENCE_LABEL[c.confidence]}`;
  return '置信 —';
}

/** 类型标签（缺则「—」，不显空白/undefined）。 */
function typeText(c: CandidateView): string {
  return c.type ? TYPE_LABEL[c.type] : '—';
}

/** 段数文案「17 段」（缺则「— 段」）。 */
function segmentText(c: CandidateView): string {
  return c.segmentCount != null ? `${c.segmentCount} 段` : '— 段';
}

/** 能力名称（缺则「未命名能力」，不显 undefined）。 */
function nameText(c: CandidateView): string {
  return c.name ?? '未命名能力';
}

export interface SelectStepProps {
  /** ready 候选（首选由 STEP② 直接传入；续传/直进时上层用 fetchSelectCandidates 取后传入）。 */
  candidates: CandidateView[];
  /**
   * 进入下一步回调（语义在向导层：单选→建 version 进 STEP④；全部发布→批量发布）。
   * 本组件只负责把当前 selection 交出；持久化/建产物由上层（§1.1(b)）。不传则底栏主按钮禁用。
   */
  onNext?: (selection: SelectionDraft) => void;
  /**
   * 推进（patchSelection）是否在途（由上层持有）。本组件是底栏主按钮的唯一注册者，故 busy 也走这条注册：
   *   - busy=true → 按钮显「处理中…」并禁用（防重复点）。
   *   - busy 结束（成功或失败）→ 同一注册 effect 重跑，按当前选择恢复可点按钮，绝不卡死（永不裸转圈、有退路）。
   */
  busy?: boolean;
}

export function SelectStep({ candidates, onNext, busy = false }: SelectStepProps): ReactElement {
  const { selection, setSelection, setPrimaryAction } = useWizard();

  // onNext 存 ref：上层常每次渲染传新函数，若放进 effect 依赖会触发「effect→setPrimaryAction→重渲染→
  // 新 onNext→effect」死循环。用 ref 让按钮行为读最新 onNext，但不让它的身份驱动 effect（稳定订阅）。
  const onNextRef = useRef(onNext);
  onNextRef.current = onNext;
  const hasNext = !!onNext; // 仅以「是否可前进」的布尔进 effect 依赖（稳定）。

  // 「批量」态 = subset 或旧兼容别名 all（isSubsetSelection 统一判别，§4.G）；single 走逐个选。
  const isBatch = selection ? isSubsetSelection(selection) : false;
  const selectedId = selection?.mode === 'single' ? selection.candidateId : null;

  // 当前子集 ids（仅取仍在 ready 候选内的，防 STEP② 带入后某项被重试/删失效）；无子集态则空。
  const candidateIdSet = new Set(candidates.map((c) => c.id));
  const subsetIds =
    selection && isSubsetSelection(selection)
      ? selectionCandidateIds(selection).filter((id) => candidateIdSet.has(id))
      : [];
  // 「全部发布」选项点击/续用时纳入的 ids：带子集进来（STEP② 勾选 N 项）→ 发布【这 N 项】；
  //   无子集（直进/续传只剩 single）→ 默认全部 ready。两者都写 mode='subset'（§5.2/§5.3，N<total 合法）。
  const allReadyIds = candidates.map((c) => c.id);
  const batchTargetIds = subsetIds.length > 0 ? subsetIds : allReadyIds;
  // 子集是否为「真子集」(N<total)：决定文案区分「这 N 项」vs「全部」。
  const isProperSubset = subsetIds.length > 0 && subsetIds.length < allReadyIds.length;

  // 全部发布：对当前子集（N 项）或全部 ready 批量发布。写 subset（candidateIds[].min(1)，空候选不可选，
  //   SelectionDraft 无空子集）。绝不写 'all'——子集 N<total 写成 'all' 会被后端误判「须 == 全 ready」而 400（Codex r6 P1）。
  const selectAll = (): void => {
    if (batchTargetIds.length === 0) return; // 无候选不能批量发布（空子集非法，§contract Codex P1-3）。
    setSelection({ mode: 'subset', candidateIds: batchTargetIds });
  };

  // 逐个选：单选互斥（选中即覆盖，选择结构化-04）。
  const selectOne = (candidateId: string): void => {
    setSelection({ mode: 'single', candidateId });
  };

  // 选中名称（底栏主按钮「下一步：结构化『X』」，§5.3）。
  const selectedName = selectedId
    ? nameText(candidates.find((c) => c.id === selectedId) ?? ({} as CandidateView))
    : null;
  // 批量发布的项数（文案「全部发布这 N 项」/「全部发布 N 项」区分子集与全部，§5.2/§5.3）。
  const batchCount = batchTargetIds.length;

  // 注册底栏主按钮（文案随选择态变，§5.0 底栏恒定 / 选择结构化-03）。
  // busy 也纳入这条唯一注册：推进在途显「处理中…」+禁用；推进结束（成功/失败）effect 重跑，按当前选择恢复
  // 可点按钮——绝不出现「busy 单写、advancing 结束后无人复位」的卡死（Codex r5 P1）。
  useEffect(() => {
    if (busy) {
      // 推进在途：显忙态禁用（防重复点）。不 return cleanup 置空——保留注册，busy 落地后本 effect 重跑恢复。
      setPrimaryAction({ busy: true, enabled: false, label: '处理中…' });
      return;
    }
    if (!selection) {
      // 未选：主按钮禁用（既未选单个也未批量，不可前进）。
      setPrimaryAction({ enabled: false });
      return;
    }
    // 批量（subset）：文案带项数，子集 N<total 显「这 N 项」、全部显「全部 N 项」，把 N 与「全部」区分清楚（§5.2/§5.3）。
    const batchLabel = isProperSubset
      ? `下一步：全部发布这 ${batchCount} 项 →`
      : `下一步：全部发布 ${batchCount} 项 →`;
    const label = isBatch ? batchLabel : `下一步：结构化『${selectedName}』 →`;
    setPrimaryAction({
      label,
      enabled: hasNext,
      onNext: () => onNextRef.current?.(selection),
    });
    // 卸载时清空主按钮（回机器默认，避免离开 STEP③ 仍残留其文案）。
    return () => setPrimaryAction(null);
  }, [
    busy,
    selection,
    isBatch,
    isProperSubset,
    batchCount,
    selectedName,
    hasNext,
    setPrimaryAction,
  ]);

  return (
    <section className="cb-select" aria-label="选择要发布的能力">
      {/* 1. 顶部整体选项「全部发布（不逐个选）」（§5.2/§5.3.1 / 选择结构化-01）。带子集进来时发布【这 N 项】，否则全部 ready。 */}
      <button
        type="button"
        className="cb-select__all"
        data-selected={isBatch ? 'true' : 'false'}
        aria-pressed={isBatch}
        onClick={selectAll}
        disabled={batchCount === 0}
      >
        <span className="cb-select__all-title">全部发布（不逐个选）</span>
        <span className="cb-select__all-hint">
          {isProperSubset
            ? `把已勾选的 ${batchCount} 项一次性自动整理、批量发布，跳过逐个展开。`
            : `把识别出的 ${batchCount} 个能力一次性自动整理、批量发布，跳过逐个展开。`}
        </span>
      </button>

      {/* 「或逐个选定一个」分隔（§5.3.1）。 */}
      <p className="cb-select__divider" aria-hidden="true">
        或逐个选定一个
      </p>

      {/* 2. 单选互斥列表（每行四项：名称 / 类型 / 段数 / 置信度，选择结构化-02/25）。 */}
      <ul className="cb-select__list" role="radiogroup" aria-label="逐个选定一个能力">
        {candidates.map((c) => {
          const checked = selectedId === c.id;
          return (
            <li key={c.id} className="cb-select__row" data-selected={checked ? 'true' : 'false'}>
              <button
                type="button"
                className="cb-select__option"
                role="radio"
                aria-checked={checked}
                onClick={() => selectOne(c.id)}
              >
                <span className="cb-select__radio" aria-hidden="true">
                  {checked ? '●' : '○'}
                </span>
                <span className="cb-select__name">{nameText(c)}</span>
                <span className="cb-select__type">{typeText(c)}</span>
                <span className="cb-select__segments">{segmentText(c)}</span>
                <span className="cb-select__confidence">{confidenceText(c)}</span>
              </button>
            </li>
          );
        })}
        {candidates.length === 0 && (
          <li className="cb-select__empty">没有可选的能力，回上一步再提取试试。</li>
        )}
      </ul>
    </section>
  );
}
