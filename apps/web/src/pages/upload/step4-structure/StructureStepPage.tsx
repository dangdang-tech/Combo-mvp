// STEP④ 结构化容器（F-13，§5.4）——建版 + 起结构化 Job + SSE 字段流 + 软字段编辑/重生成 + 三退路。
//
// 数据流（40 §4）：
//   1. 解析 versionId：URL ?version= / ?capability=（回看编辑）优先；否则据 wizard.selection.candidateId 建版（端点 A）。
//   2. 读 manifest（端点 B）拿硬字段终值 + 已生成软字段（续传/回看兜底）。
//   3. 起结构化 Job（端点 C，仅未全生成时）→ 订阅 SSE 字段流（端点 D，useSSE structure 流）。
//   4. 合并 manifest 基线 + SSE structureState → 软硬字段视图（流式优先、断流回落 manifest）。
//   5. 编辑软字段（PATCH 端点 E）/ 重生成单字段（端点 F）/ 三退路（continue 前端放行 / regen 端点 F / wait 继续等）。
//
// 合规：永不裸转圈（StreamLoading/Skeleton + 进度短语）；绝不裸露错误码（ErrorState 只 userMessage+action）；
// 已生成不丢（structure_state + manifest 双兜底，重生成只动该字段）；硬字段锁定不可改；底栏「下一步：发布到市集」。
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  SSE_ROUTES,
  type ManifestView,
  type Manifest,
  type SoftFieldKey,
  type FieldStuckPayload,
  type PatchManifestBody,
} from '@cb/shared';
import { useSSE, type ApiError } from '../../../api/index.js';
import { ErrorState, LoadingState, StreamLoading } from '../../../components/index.js';
import { useWizard, pathForStep } from '../../wizard/index.js';
import { CapabilitySwitcher } from '../CapabilitySwitcher.js';
import { toApiError, isAbort } from '../localError.js';
import { AppIdentityPanel } from './AppIdentityPanel.js';
import {
  createCapability,
  fetchManifest,
  startStructure,
  patchManifest,
  regenerateField,
} from './structureApi.js';
import { buildSoftFields, buildHardFields, allSoftReady } from './manifestFields.js';

type SetupState =
  | { kind: 'setup' } // 建版 / 起 Job / 读 manifest 中（永不裸转圈：骨架）
  | { kind: 'ready'; versionId: string; manifest: Manifest }
  | { kind: 'error'; error: ApiError };

export function StructureStepPage(): ReactElement {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const {
    draftId,
    selection,
    versionId: ctxVersionId,
    capabilityId: ctxCapabilityId,
    setVersionId,
    setCapabilityId,
    markStepError,
    clearStepError,
    setPrimaryAction,
  } = useWizard();

  const [setup, setSetup] = useState<SetupState>({ kind: 'setup' });
  const [attempt, setAttempt] = useState(0);
  // 软字段重生成/编辑在途（禁用该字段按钮，防重复点；永不裸转圈靠按钮态 + 流式骨架）。
  const [busyFields, setBusyFields] = useState<ReadonlySet<SoftFieldKey>>(new Set());
  // 「继续用已生成」放行标记（field_stuck continue：纯前端，不回服务端，§3.3）。
  const [released, setReleased] = useState(false);
  // 编辑/重生成失败的就地错误条（顶部，不丢已生成软字段；永不裸错）。
  const [editError, setEditError] = useState<ApiError | null>(null);

  // versionId 来源优先级（续传不重建版，B-25/贯穿-28）：URL ?version=（回看/编辑直达）→ 草稿续传回填的
  // ctxVersionId（hydrateFromDraft 从 DraftView.versionId 恢复）→ 都无才据 selection 建版（端点 A）。
  // 本期以 ?version= 为准；capability 回看走 ?capability= 略。
  const urlVersionId = searchParams.get('version') ?? ctxVersionId ?? undefined;
  const sourceCandidateId = selection?.mode === 'single' ? selection.candidateId : undefined;
  // 被拒「编辑后重发」入口（P1-5）：URL ?fromVersionId=被拒版 → 端点 A 派生新 draft（复制软字段，原被拒版不动）。
  // 仅当没有现成 versionId（不是回看既有版）时生效；与 sourceCandidateId 恰好三选一（40 §2.4）。
  const fromVersionId = searchParams.get('fromVersionId') ?? undefined;

  // draftId 经 ref 读进 setup effect（建版带 draftId 续传衔接）：draftId 在建版后被 setDraftId 改写，
  // 若进 effect 依赖会重跑整个 setup（重复建版/起 Job）——故用 ref 读最新值，不让它驱动 effect。
  const draftIdRef = useRef(draftId);
  draftIdRef.current = draftId;

  // 建版稳定幂等键（P1-2，验收 选择结构化-08 / 重试续结构化不重复建版）：从「建版逻辑主体」派生——
  //   sourceCandidateId（从候选建首版）或 fromVersionId（被拒重发派生），各与 draftId 一并入键（同 draft
  //   挂不同候选/被拒版时各自独立）。首建 + 响应丢失重试 + 刷新重进都复用同一 key →（client 不另生成随机 key、
  //   也不把建出的 versionId 当 key）后端按幂等行为矩阵回放首次建版（同 capability/version、ON CONFLICT 命中、
  //   不建第二条）。绝不让 createCapability(undefined) 走 client 随机 key（那会让响应丢失后重试用新 key 重复建版）。
  //   注：urlVersionId 存在（回看既有版）时本就不建版，无需 key；故 key 只对「无现成 versionId、靠 source 建版」生效。
  const createKey = useMemo(() => {
    const dId = draftId ?? 'nodraft';
    if (fromVersionId) return `capability.create:${dId}:from:${fromVersionId}`;
    if (sourceCandidateId) return `capability.create:${dId}:cand:${sourceCandidateId}`;
    return undefined;
  }, [draftId, fromVersionId, sourceCandidateId]);
  // createKey 经 ref 读进 setup effect（同 draftId：建版回填 setDraftId 改 draftId → createKey 变，若进 effect
  //   依赖会重跑 setup 重复建版；用 ref 读最新值，effect 只由 setup 输入 source/version/attempt 驱动）。
  const createKeyRef = useRef(createKey);
  createKeyRef.current = createKey;

  // —— 建版 + 起 Job + 读 manifest（一次性 setup，永不裸转圈）——
  useEffect(() => {
    const ctrl = new AbortController();
    let active = true;
    setSetup({ kind: 'setup' });

    void (async () => {
      try {
        let versionId = urlVersionId;
        // 1. 无 versionId → 建版（端点 A，恰好三选一）：被拒重发优先用 fromVersionId 派生新 draft（P1-5），
        //    否则据 selection.candidateId 建首版。
        if (!versionId) {
          const dId = draftIdRef.current;
          if (fromVersionId) {
            // 被拒「编辑后重发」：从 review_rejected 版派生新 draft（复制软字段 bump minor，原被拒版不动，40 §4.A③）。
            //   传稳定 createKey（P1-2）：响应丢失后重试用同 key → 后端回放首次派生，不重复派生新 draft。
            const created = await createCapability(
              { fromVersionId, ...(dId ? { draftId: dId } : {}) },
              createKeyRef.current,
              { signal: ctrl.signal },
            );
            versionId = created.versionId;
            if (active) {
              setVersionId(created.versionId);
              // 回填真实 capabilityId（capabilities.id，供 STEP⑤ 读 publication 拒绝态，P1-5）。
              //   绝不拿 capabilityId 冒充 draftId：draftId 由 STEP① bootstrap 真实建出并经各步回填（P0-2）。
              setCapabilityId(created.capabilityId);
            }
          } else if (sourceCandidateId) {
            // 从候选建首版：传稳定 createKey（P1-2，从 draftId+sourceCandidateId 派生）——首建 + 重试 + 刷新同一 key，
            //   响应丢失后重试由后端回放首次（ON CONFLICT 命中），不重复建 capability/version（重试续结构化不重复建版）。
            const created = await createCapability(
              { sourceCandidateId, ...(dId ? { draftId: dId } : {}) },
              createKeyRef.current,
              { signal: ctrl.signal },
            );
            versionId = created.versionId;
            if (active) {
              // 回填版本 id 到向导：STEP⑤ 单发布据它发布、本步重渲染/续传不重建版（后端建版同事务回填
              // drafts.version_id + current_step='structure'，40 §4.A；前端缓存等价引用）。
              setVersionId(created.versionId);
              // 回填真实 capabilityId（capabilities.id ≠ drafts.id，供 STEP⑤ 读 publication 拒绝态闭环，P1-5）。
              //   绝不拿 capabilityId 冒充 draftId：draftId 是 STEP① bootstrap 的真实草稿 id，各步只回填它、不重写（P0-2）。
              setCapabilityId(created.capabilityId);
            }
          } else {
            // 既无 versionId、又无 fromVersionId、又无可建版的候选：回上一步补选（不空打后端）。
            if (active)
              setSetup({
                kind: 'error',
                error: toApiError(null, '还没选好要结构化的能力，回上一步选一个。', 'change_input'),
              });
            return;
          }
        }

        // 2. 读 manifest（硬字段终值 + 已生成软字段）。
        const view: ManifestView = await fetchManifest(versionId, { signal: ctrl.signal });

        // 3. 起结构化 Job（仅当还有软字段未生成；全 done 的回看态不重复起 Job，验收 选择结构化-26/贯穿-28）。
        const soft = buildSoftFields(view.manifest, view.structureState);
        if (!allSoftReady(soft)) {
          await startStructure(versionId, undefined, undefined, { signal: ctrl.signal });
        }

        if (active) setSetup({ kind: 'ready', versionId, manifest: view.manifest });
      } catch (e) {
        if (!active || isAbort(e)) return;
        const err = toApiError(e, '这一步没能开始，请重试。');
        setSetup({ kind: 'error', error: err });
        markStepError('structure');
      }
    })();

    return () => {
      active = false;
      ctrl.abort();
    };
    // 依赖仅 setup 输入（versionId/candidate/attempt）；draftId 经 ref 读、wizard setters 身份稳定（useCallback），
    // 不放进依赖以免建版后 setVersionId/setCapabilityId 改写状态触发重复建版/起 Job。
  }, [
    urlVersionId,
    sourceCandidateId,
    fromVersionId,
    attempt,
    setVersionId,
    setCapabilityId,
    markStepError,
  ]);

  const versionId = setup.kind === 'ready' ? setup.versionId : null;

  // —— SSE 字段流（端点 D，kind=structure）：仅 ready 后订阅；continue 放行后停订阅（不再裸转圈等卡住字段）——
  const sseUrl = versionId ? SSE_ROUTES.structureEvents(versionId) : null;
  const sse = useSSE(sseUrl, 'structure', { enabled: !!versionId && !released });

  // 合并 manifest 基线 + SSE structureState（流式优先；断流回落 manifest 终值，已生成不丢）。
  const manifest = setup.kind === 'ready' ? setup.manifest : undefined;
  const soft = useMemo(
    () => buildSoftFields(manifest, sse.structureState),
    [manifest, sse.structureState],
  );
  const hard = useMemo(() => buildHardFields(manifest), [manifest]);
  const ready = allSoftReady(soft) || released;

  // 同字段两次失败 → 步骤条标红（§3.4 转人工终态）；恢复（重生成成功）清红。
  useEffect(() => {
    const hasFatal = soft.some((s) => s.status === 'failed' && s.attempts >= 2);
    if (hasFatal) markStepError('structure');
    else if (setup.kind === 'ready') clearStepError('structure');
  }, [soft, setup.kind, markStepError, clearStepError]);

  // —— 软字段编辑（PATCH 端点 E）——
  const handleSaveField = (field: SoftFieldKey, value: string | string[]): void => {
    if (!versionId) return;
    const body: PatchManifestBody = { [field]: value } as PatchManifestBody;
    setBusyFields((p) => new Set(p).add(field));
    void (async () => {
      try {
        const view = await patchManifest(versionId, body);
        // 回填 manifest 终值（编辑落库后回显；structure_state 也由后端回带，SSE 不重连仍以本地 manifest 兜底）。
        setSetup((s) => (s.kind === 'ready' ? { ...s, manifest: view.manifest } : s));
        clearStepError('structure');
      } catch (e) {
        if (isAbort(e)) return;
        // 编辑失败（如 published 409）：顶部就地错误条提示，保持 ready 不打回 setup，不丢已生成软字段。
        setEditError(toApiError(e, '这个改动没保存上，请重试。', 'retry'));
      } finally {
        setBusyFields((p) => {
          const n = new Set(p);
          n.delete(field);
          return n;
        });
      }
    })();
  };

  // —— 单字段重生成（端点 F；只动该字段，不丢其它，验收 选择结构化-17）——
  const regen = (field: SoftFieldKey, reason: 'stuck' | 'manual'): void => {
    if (!versionId) return;
    setBusyFields((p) => new Set(p).add(field));
    void (async () => {
      try {
        await regenerateField(versionId, field, reason);
        clearStepError('structure');
        // 重生成后该字段经 SSE 重回 generating→done（state_snapshot/field_* 续流）；本地不直改值。
      } catch (e) {
        if (isAbort(e)) return;
        setEditError(toApiError(e, '没能重新生成这个字段，请重试。', 'retry'));
      } finally {
        setBusyFields((p) => {
          const n = new Set(p);
          n.delete(field);
          return n;
        });
      }
    })();
  };

  // —— 三退路（field_stuck，§3.3）——
  const handleStuckChoice = (option: FieldStuckPayload['options'][number]): void => {
    const stuckField = sse.stuck?.field as SoftFieldKey | undefined;
    if (option === 'continue') {
      // 用已生成的部分先继续：纯前端放行，停订阅、卡住字段留待编辑（不回服务端，§3.3）。
      setReleased(true);
    } else if (option === 'regen' && stuckField) {
      regen(stuckField, 'stuck');
    }
    // wait：不发请求，继续跟流（SSE 不停）。
  };

  // —— 底栏「下一步：发布到市集」（§5.0 恒定底栏；全软字段就绪或已放行才可前进）——
  // onNext 经 ref 读最新 versionId/draftId/capabilityId，effect 只订阅可用性（ready/versionId），避免每次渲染重注册。
  const versionRef = useRef(versionId);
  versionRef.current = versionId;
  const draftIdRefForNav = useRef(draftId);
  draftIdRefForNav.current = draftId;
  // capabilityId 续传 onNext 带入 publish 页（真实 capabilities.id，供拒绝态读 publication，P1-5）。
  const capabilityIdRefForNav = useRef(ctxCapabilityId);
  capabilityIdRefForNav.current = ctxCapabilityId;
  useEffect(() => {
    setPrimaryAction({
      label: '下一步：发布到市集 →',
      enabled: ready && !!versionId,
      onNext: () => {
        const vId = versionRef.current;
        const dId = draftIdRefForNav.current;
        const cId = capabilityIdRefForNav.current;
        const qs = new URLSearchParams();
        if (dId) qs.set('draftId', dId);
        if (vId) qs.set('version', vId);
        // 真实 capabilityId 串到 publish 页（drafts.id ≠ capabilities.id，绝不拿 draftId 冒充读 publication，P1-5）。
        if (cId) qs.set('capability', cId);
        navigate(`${pathForStep('publish')}?${qs.toString()}`);
      },
    });
    return () => setPrimaryAction(null);
  }, [ready, versionId, navigate, setPrimaryAction]);

  // —— 渲染 ——
  if (setup.kind === 'setup') {
    return <LoadingState skeletonRows={5} label="正在准备结构化" />;
  }
  if (setup.kind === 'error') {
    return (
      <ErrorState
        error={setup.error}
        onRetry={() => {
          clearStepError('structure');
          setAttempt((a) => a + 1);
        }}
        onChangeInput={() =>
          navigate(pathForStep('select') + (draftId ? `?draftId=${draftId}` : ''))
        }
      />
    );
  }

  // SSE 建流/重连/错误的全局兜底（字段级失败不在此，由 SoftFieldCard 内 ErrorState 渲染）。
  const streamFatal = sse.status === 'error' && !ready;

  return (
    <div className="cb-structure" data-version={setup.versionId}>
      {editError && (
        <ErrorState
          error={editError}
          onRetry={() => setEditError(null)}
          onChangeInput={() => setEditError(null)}
          onEscalate={() => setEditError(null)}
        />
      )}

      <div className="cb-structure__cols">
        {/* 左：能力切换列表（single 即一项）。 */}
        <aside className="cb-structure__left">
          <CapabilitySwitcher
            items={[{ key: setup.versionId, name: soft[0]?.text || '当前能力' }]}
            activeKey={setup.versionId}
            onSelect={() => undefined}
          />
        </aside>

        {/* 右：App Identity（软硬两组）。streamFatal 时顶部给统一错误态 + 重连，但已生成软字段仍展示。 */}
        <main className="cb-structure__main">
          {streamFatal && (
            <StreamLoading
              state={sse}
              label="正在生成字段"
              onRetry={() => setAttempt((a) => a + 1)}
              onStuckChoice={handleStuckChoice}
            />
          )}
          <AppIdentityPanel
            capabilityName={soft[0]?.text || '当前能力'}
            soft={soft}
            hard={hard}
            stuck={sse.stuck}
            slowHint={sse.slowHint}
            onSaveField={handleSaveField}
            onRegenerateField={(f) => regen(f, 'manual')}
            onRetryField={(f) => regen(f, 'manual')}
            onStuckChoice={handleStuckChoice}
            busyFields={busyFields}
          />
        </main>
      </div>
    </div>
  );
}
