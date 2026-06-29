// 新建流程草稿 bootstrap hook（F-09 / F-15，Codex phase4c P0-2）——STEP① 进入即建真实草稿，成为续传基线。
//
// 为什么在 STEP①（开工总纲 §5.0「每步可存草稿 + 断点续传」 / 脊柱 §8）：
//   新建五步向导若没有真实 drafts 行，fresh flow 无法成为可续传基线——STEP③ 存草稿无处可落、各步落点
//   引用（snapshot/extract/version/capability/batch）无 draft 可回填。故进入向导第一步即先 POST /drafts
//   拿真实 draftId，写进 WizardContext，之后每步把产物经各自后端推进 API 回填同一 draft（已生成不丢、续传精确）。
//
// 何时建（恰好一次，不空建）：
//   - 仅当「全新进入」才建：既无 draftId（未续传 / STEP④ 早先用 capabilityId 冒充已删除）、
//     又无 snapshotId / jobId 深链（那是续传 / 回看，已有真实 draft 或产物，不该再 bootstrap）。
//   - 已有任一来源 → idle，不建（绝不重复建行、不空打后端）。
//   - 用稳定 idempotencyKey（每次「需要 bootstrap」的挂载固定一枚）：StrictMode 双渲染 / 重试只回放首次草稿
//     （硬规则③，同 draftId、不建第二条）。
//
// 失败：落人话 ApiError（上层就地 ErrorState + 重试，永不裸错）；不阻塞——重试即重发同 key 回放/补建。
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/index.js';
import { createDraft } from './draftApi.js';
import { useWizard } from './WizardContext.js';

export type BootstrapStatus = 'idle' | 'creating' | 'ready' | 'error';

export interface UseBootstrapDraftResult {
  /** idle=无需建（已有 draftId / 续传）；creating=建草稿在途；ready=已建/已有；error=建失败。 */
  status: BootstrapStatus;
  /** 当前有效 draftId（已有的 ctx draftId 或新建出的；creating/error 时可能为 undefined）。 */
  draftId: string | undefined;
  /** 建失败错误（人话 + 退路，渲染交调用方 ErrorState）。 */
  error: ApiError | null;
  /** 重试 bootstrap（清错误重发；复用同 idempotencyKey 回放/补建，不重复建行）。 */
  retry: () => void;
}

/** 生成稳定幂等键（每个「需要建」的挂载固定一枚，回放首次草稿）。 */
function newBootstrapKey(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `draft-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

/**
 * 新建流程进入第一步时 bootstrap 真实草稿。
 * @param opts.needsBootstrap 调用方据当前路由/深链判定「这是全新进入、应建草稿」（无 draftId / snapshotId / jobId）。
 *   传 false 即不建（续传 / 回看 / 已有 draft）。
 */
export function useBootstrapDraft(opts: { needsBootstrap: boolean }): UseBootstrapDraftResult {
  const { needsBootstrap } = opts;
  const { draftId: ctxDraftId, setDraftId } = useWizard();
  const [status, setStatus] = useState<BootstrapStatus>('idle');
  const [error, setError] = useState<ApiError | null>(null);
  // 本次会话固定的幂等键（重试复用，回放首次草稿；仅在真正发请求时生成）。
  const keyRef = useRef<string | null>(null);
  // 已建/已有过的 draftId（避免 ctx 回填后 effect 抖动重建）。
  const settledRef = useRef(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // 已有 draftId（续传回填 / 已建）→ 直接 ready，不再建。
    if (ctxDraftId) {
      settledRef.current = true;
      setStatus('ready');
      return;
    }
    // 不需要 bootstrap（续传 / 回看 / 深链）→ idle，不空建。
    if (!needsBootstrap) {
      setStatus('idle');
      return;
    }
    // 已建过（settled）但 ctx 尚未刷出（极短窗口）：不重复建。
    if (settledRef.current) return;

    const ctrl = new AbortController();
    let active = true;
    if (!keyRef.current) keyRef.current = newBootstrapKey();
    setStatus('creating');
    setError(null);

    void (async () => {
      try {
        const draft = await createDraft(
          { idempotencyKey: keyRef.current ?? undefined },
          { signal: ctrl.signal },
        );
        if (!active) return;
        settledRef.current = true;
        setDraftId(draft.id); // 贯穿到 WizardContext，后续各步回填同一 draft。
        setStatus('ready');
      } catch (e) {
        if (!active) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        const err =
          e instanceof ApiError
            ? e
            : new ApiError({
                error: {
                  userMessage: '新建草稿没成功，请重试。',
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
  }, [ctxDraftId, needsBootstrap, attempt, setDraftId]);

  const retry = useCallback(() => {
    // 复用同 keyRef（回放首次 / 补建，不重复建行）；只重置错误态触发 effect 重跑。
    setError(null);
    setAttempt((a) => a + 1);
  }, []);

  return { status, draftId: ctxDraftId, error, retry };
}
