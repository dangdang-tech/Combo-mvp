// 顶栏「保存草稿」hook（F-09 / F-12 / F-15）——每步可存草稿退出（开工总纲 §5.0）。
//
// 各步存草稿语义（契约 40 §1.1(b)，与 00 §8.4 drafts 落点模型一致）——区分两类，绝不臆造端点：
//   - STEP③ select：调 patchSelection 显式持久化 `drafts.selection` + `current_step='select'`（端点 G）。
//     这是本期前端唯一「主动写草稿」端点；选择切换本身纯前端不写库（§1.1(a)）。需有 draftId（草稿已存在）才可写。
//   - 其它步（import/extract/structure/publish）：本期无独立「存草稿」写端点；草稿只在各步**建产物时**由后端
//     同事务回填 `current_step` + 落点引用（§1.1(b)「进入下一步提交也持久化」，00 §8.4 落点列）。因此：
//       · 已有 draftId（后端已在某步建产物时落了 drafts 行）→「保存草稿」= 就地退出回工作台，草稿条已反映后端
//         最新 current_step/进度（这是【真已落库】的退出，诚实成功）。
//       · 尚无 draftId（本步还没建任何产物、后端还没有这条 draft 行）→ **没有任何已落库的草稿可存**：绝不谎报
//         成功、绝不带空草稿离开。返回 false + 人话退路，提示先完成本步动作（建产物即落库），再保存退出。
//   诚实推迟：非 select 步「未建产物也想强存当前编辑」的独立草稿端点，本期契约未提供（00/40 仅 PATCH selection
//     一个草稿写端点），故不臆造；待后端补该端点再接（铁律：不臆造）。
//
// 失败：抛 ApiError（含人话 + 退路）；上层（外壳「保存草稿」）落 ErrorState（永不裸错），不阻塞继续编辑。
import { useCallback, useState } from 'react';
import type { SelectionDraft } from '@cb/shared';
import { ApiError } from '../../api/index.js';
import { patchSelection } from './draftApi.js';
import { useWizard } from './WizardContext.js';

/** 尚无 draft 行可存时的人话退路（非 select 步 + 无 draftId）：本步还没落库、不谎报成功、不空退出。 */
function noDraftYetError(): ApiError {
  return new ApiError({
    error: {
      userMessage: '这一步还没生成可保存的内容，先完成当前步骤（系统会自动存为草稿），再保存退出。',
      retriable: false,
      action: 'change_input',
      traceId: '',
    },
  });
}

export interface SaveDraftState {
  /** 保存进行中（按钮禁用防重复点；永不裸转圈：按钮内联「保存中…」文案，非转圈）。 */
  saving: boolean;
  /** 最近一次保存错误（人话 + 退路，渲染交给调用方 ErrorState）。null=无错。 */
  error: ApiError | null;
}

export interface UseSaveDraftResult extends SaveDraftState {
  /**
   * 保存当前步草稿。STEP③ 需提供 selection（无则视作「无可存选择」直接成功，不空打后端）。
   * @returns 成功 true / 失败 false（错误已写入 state.error 供 ErrorState）。
   */
  save: (selection?: SelectionDraft | null) => Promise<boolean>;
  /** 清错误（重试前复位）。 */
  clearError: () => void;
}

/**
 * 「保存草稿」逻辑。本期具体写端点仅 STEP③ selection（其余步草稿随建产物回填，见文件头说明）。
 * 复用同一 idempotencyKey 重复保存安全（PATCH 最后写赢，40 §4.G；已生成不丢硬规则③）。
 */
export function useSaveDraft(): UseSaveDraftResult {
  const { currentStep, draftId, selection: ctxSelection } = useWizard();
  const [state, setState] = useState<SaveDraftState>({ saving: false, error: null });

  const clearError = useCallback(() => setState((s) => ({ ...s, error: null })), []);

  const save = useCallback(
    async (selection?: SelectionDraft | null): Promise<boolean> => {
      // 非 select 步：本期无独立存草稿写端点（§1.1(b)）。
      if (currentStep !== 'select') {
        // 已有 draftId（后端某步建产物时已落 drafts 行）→ 退出即「真已落库」的草稿，诚实成功。
        if (draftId) {
          setState({ saving: false, error: null });
          return true;
        }
        // 无 draftId → 没有任何已落库草稿可存：不谎报成功、不空退出，给真话退路（先完成本步建产物）。
        setState({ saving: false, error: noDraftYetError() });
        return false;
      }
      // STEP③ select：持久化 selection（端点 G，真落库）。
      const sel = selection !== undefined ? selection : ctxSelection;
      // 缺 draftId：select 步无草稿行可写（同非 select 无 draftId），不谎报成功、给真话退路。
      if (!draftId) {
        setState({ saving: false, error: noDraftYetError() });
        return false;
      }
      // 有 draftId 但无选择：空选不是合法草稿（SelectionDraft 无空态），不空打后端；草稿行已存在，退出诚实成功。
      if (!sel) {
        setState({ saving: false, error: null });
        return true;
      }
      setState({ saving: true, error: null });
      try {
        await patchSelection(draftId, sel);
        setState({ saving: false, error: null });
        return true;
      } catch (e) {
        const err =
          e instanceof ApiError
            ? e
            : new ApiError({
                error: {
                  userMessage: '保存草稿没成功，请稍后重试。',
                  retriable: true,
                  action: 'retry',
                  traceId: '',
                },
              });
        setState({ saving: false, error: err });
        return false;
      }
    },
    [currentStep, draftId, ctxSelection],
  );

  return { ...state, save, clearError };
}
