// 深链续传 hook（F-15）——URL ?draftId= 进入向导时恢复 draftId + selection。
//
// 两条续传入口（开工总纲 §七「上传入口」/ 外壳首页-17）：
//   ① 工作台草稿条点「去上传流程」：DraftStrip.onResume 已直接持有整条 DraftView，导航到
//      pathForStep(currentStep) + ?draftId=，落点即精确断点；本 hook 再按 draftId 拉一次确认/补水即可。
//   ② 仅有 draftId 的深链（如分享/书签）：本 hook 拉草稿恢复（无单条 GET，翻 /dashboard/drafts 定位，
//      诚实推迟单条端点，见 draftApi.findDraftById）。
//
// 恢复内容：draftId + selection（current_step 由 URL 落点决定，不在此覆写当前步）。
// 找不到草稿（已删除/越权）：落「草稿可能已删除」退路（change_input → 回工作台），不裸崩。
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/index.js';
import { findDraftById } from './draftApi.js';
import { useWizard } from './WizardContext.js';

export type ResumeStatus = 'idle' | 'loading' | 'done' | 'error';

export interface UseResumeDraftResult {
  status: ResumeStatus;
  error: ApiError | null;
  retry: () => void;
}

function notFoundError(): ApiError {
  return new ApiError({
    error: {
      userMessage: '没找到这条草稿，可能已被删除。回工作台看看其它草稿。',
      retriable: false,
      action: 'change_input',
      traceId: '',
    },
  });
}

/**
 * 据 draftId 恢复草稿到向导上下文（F-15）。draftId 为空 = 新建流程，不续传（idle）。
 * 已恢复过的 draftId 不重复拉（hydratedRef 防 effect 抖动重拉）。
 */
export function useResumeDraft(draftId: string | undefined): UseResumeDraftResult {
  const { hydrateFromDraft } = useWizard();
  const [status, setStatus] = useState<ResumeStatus>('idle');
  const [error, setError] = useState<ApiError | null>(null);
  // 已成功恢复的 draftId（避免重复拉 / 覆盖用户后续编辑的 selection）。
  const hydratedRef = useRef<string | null>(null);
  // 重试递增触发 effect 重跑。
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!draftId) {
      setStatus('idle');
      return;
    }
    if (hydratedRef.current === draftId) return; // 已恢复过，跳过。

    const ctrl = new AbortController();
    let active = true;
    setStatus('loading');
    setError(null);

    void (async () => {
      try {
        const draft = await findDraftById(draftId, { signal: ctrl.signal });
        if (!active) return;
        if (!draft) {
          setError(notFoundError());
          setStatus('error');
          return;
        }
        hydratedRef.current = draftId;
        hydrateFromDraft(draft);
        setStatus('done');
      } catch (e) {
        if (!active) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        const err =
          e instanceof ApiError
            ? e
            : new ApiError({
                error: {
                  userMessage: '恢复草稿时出了点问题，请稍后重试。',
                  retriable: true,
                  action: 'retry',
                  traceId: '',
                },
              });
        setError(err);
        setStatus('error');
      }
    })();

    return () => {
      active = false;
      ctrl.abort();
    };
  }, [draftId, attempt, hydrateFromDraft]);

  const retry = useCallback(() => {
    hydratedRef.current = null;
    setAttempt((a) => a + 1);
  }, []);

  return { status, error, retry };
}
