// STEP③ 选择页容器（F-12）——取候选 + 接 SelectStep + 进入下一步持久化。
//
// 数据：候选来自提取域（draft.extractJobId → fetchSelectCandidates，只读 ready）。续传/直进 STEP③ 时取数；
//   加载用 4A 加载件（永不裸转圈），失败用 ErrorState（人话 + 退路，无 code）。
// 进入下一步（§1.1(b)）：
//   - 逐个选（single）：建 version（端点 A POST /capabilities，属 STEP④ 入口，4D 接）——本期诚实推迟为
//     先 patchSelection 持久化 selection（端点 G）再进 STEP④ 路由，把「建 version」交给 STEP④ 模块按
//     draft.selection 起结构化（避免越界实现非本模块的端点 A）。
//   - 全部发布 / 勾选 N 项（subset，含旧兼容别名 all）：进发布域批量发布（POST /publish-batches，按所选子集
//     一对一建批，属发布域 50，§2.3）——本期同样先 patchSelection 持久化再进发布步路由，批量发布逻辑交发布模块。
//   两条都先 persist selection（已生成不丢、续传精确），再 navigate；持久化失败落 ErrorState、不前进。
import { useEffect, useState, type ReactElement } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  isSubsetSelection,
  MAX_PAGE_LIMIT,
  type CandidateView,
  type SelectionDraft,
} from '@cb/shared';
import { ApiError } from '../../api/index.js';
import { ErrorState, LoadingState } from '../../components/index.js';
import { useWizard } from './WizardContext.js';
import { SelectStep } from './SelectStep.js';
import { fetchSelectCandidates } from './selectApi.js';
import { patchSelection } from './draftApi.js';
import { pathForStep, nextStep } from './wizardMachine.js';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; candidates: CandidateView[] }
  | { kind: 'error'; error: ApiError };

export function SelectStepPage(): ReactElement {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { draftId, extractJobId, setExtractJobId } = useWizard();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [advancing, setAdvancing] = useState(false);
  const [advanceError, setAdvanceError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);

  // extractJobId 来源优先级：上下文（hydrateFromDraft 回填 DraftView.extractJobId / STEP② 带入）→ URL ?extractJobId=。
  // 续传/直进无任一来源 → 候选为空，列表给空态引导回上一步（不空打后端）。
  const urlExtractJobId = searchParams.get('extractJobId') ?? undefined;
  useEffect(() => {
    if (!extractJobId && urlExtractJobId) setExtractJobId(urlExtractJobId);
  }, [extractJobId, urlExtractJobId, setExtractJobId]);
  const effectiveExtractJobId = extractJobId ?? urlExtractJobId;

  // 取候选（仅当有 extractJobId；无则直接给空 ready 列表 + 空态引导，不空打后端）。
  useEffect(() => {
    if (!effectiveExtractJobId) {
      setState({ kind: 'ready', candidates: [] });
      return;
    }
    const ctrl = new AbortController();
    let active = true;
    setState({ kind: 'loading' });
    void (async () => {
      try {
        // 取齐本次萃取的全部 ready 候选（limit=MAX_PAGE_LIMIT，不走后端默认 20 分页，BUG-020）：
        //   STEP③ 单选列表 / 「全部发布」承接 STEP② 的子集口径，必须基于完整 ready 候选集——否则候选 >20 时
        //   只取前 20，SelectStep 的子集过滤（filter id∈当前候选）会把落在 20 名外的子集 id 静默丢弃，
        //   导致「全部发布这 N 项」退化成「发布全部 ready」、单选 id 在 20 名外时也不会被预选。
        const res = await fetchSelectCandidates(
          effectiveExtractJobId,
          { limit: MAX_PAGE_LIMIT },
          { signal: ctrl.signal },
        );
        if (active) setState({ kind: 'ready', candidates: res.candidates });
      } catch (e) {
        if (!active) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        const err =
          e instanceof ApiError
            ? e
            : new ApiError({
                error: {
                  userMessage: '候选加载失败，请稍后重试。',
                  retriable: true,
                  action: 'retry',
                  traceId: '',
                },
              });
        setState({ kind: 'error', error: err });
      }
    })();
    return () => {
      active = false;
      ctrl.abort();
    };
  }, [effectiveExtractJobId, attempt]);

  // 进入下一步：先持久化 selection（端点 G），再进对应步路由（建 version / 批量发布交后续模块）。
  const handleNext = async (selection: SelectionDraft): Promise<void> => {
    if (!draftId) {
      // 无 draftId 无法持久化（新建流程应在前序步已建 draft）；落退路提示，不静默吞。
      setAdvanceError(
        new ApiError({
          error: {
            userMessage: '草稿还没准备好，回上一步再试一次。',
            retriable: false,
            action: 'change_input',
            traceId: '',
          },
        }),
      );
      return;
    }
    setAdvancing(true);
    setAdvanceError(null);
    try {
      await patchSelection(draftId, selection);
      // single → 进结构化（STEP④）；subset（含兼容别名 all）→ 进发布（STEP⑤，批量发布由发布模块据
      //   selection.candidateIds 一对一建批，§2.3）。用 isSubsetSelection 统一判别，不再只认 'all'——否则
      //   STEP② 勾选 N 项写的 subset 会被误当 single 漏进结构化（Codex r6 P1 同源）。
      const target = isSubsetSelection(selection) ? 'publish' : (nextStep('select') ?? 'structure');
      navigate(`${pathForStep(target)}?draftId=${encodeURIComponent(draftId)}`);
    } catch (e) {
      const err =
        e instanceof ApiError
          ? e
          : new ApiError({
              error: {
                userMessage: '进入下一步没成功，请稍后重试。',
                retriable: true,
                action: 'retry',
                traceId: '',
              },
            });
      setAdvanceError(err);
    } finally {
      setAdvancing(false);
    }
  };

  // 底栏主按钮（含「处理中…」忙态）由 SelectStep 单点注册：advancing 经 busy 传下去，推进结束（成功/失败）
  // SelectStep 注册 effect 重跑、按当前选择恢复可点按钮——避免「busy 在此单写、advancing 结束后无人复位」
  // 导致 PATCH 失败后按钮永久卡死（Codex r5 P1）。
  if (state.kind === 'loading') {
    return <LoadingState skeletonRows={4} label="候选加载中" />;
  }
  if (state.kind === 'error') {
    return <ErrorState error={state.error} onRetry={() => setAttempt((a) => a + 1)} />;
  }

  return (
    <>
      {advanceError && (
        <ErrorState
          error={advanceError}
          onRetry={() => setAdvanceError(null)}
          onChangeInput={() => setAdvanceError(null)}
        />
      )}
      <SelectStep
        candidates={state.candidates}
        onNext={(sel) => void handleNext(sel)}
        busy={advancing}
      />
    </>
  );
}
