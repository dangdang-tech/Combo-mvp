// 向导壳 WizardShell（F-09，开工总纲 §5.0；PRD 结构坍缩为 2 步后大幅精简）——上传两步共用壳。
//
// 结构（自上而下，全在 4A Shell 的 <Outlet> 内容区内；不改 4A 外壳侧栏/顶栏）：
//   1. 顶栏「保存草稿」：上抬到 4A Shell 顶栏（topbarSlot），不在本壳内独立成条。
//   2. 常驻创作身份：上传与能力页共享同一项目名称和紧凑四阶段旅程。
//   3. 续传/保存的加载与错误安抚条（永不裸转圈/裸错）。
//   4. 步骤内容区：<Outlet> 渲染当前步（上传 / 能力页）。
//
// 已随 2 步坍缩下线：顶部常驻步骤条（StepBar）+ 恒定底栏主按钮（WizardFooter）。
//   上传完成即自动进入能力页（无需手动点「下一步」）、能力页自带「一键发布」，故无需步骤条/底栏编排。
// 当前步由路由派生（stepForPath）；换步不改本壳结构（外壳恒定 D14）。
import { useCallback, useEffect, useRef, type ReactElement } from 'react';
import { Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ErrorState } from '../../components/index.js';
import { useTopbarActionSetter } from '../../shell/topbarSlot.js';
import { CreationJourney } from './CreationJourney.js';
import { stepForPath, WIZARD_STEPS } from './wizardMachine.js';
import { useWizard } from './WizardContext.js';
import { useSaveDraft } from './useSaveDraft.js';
import { useResumeDraft } from './useResumeDraft.js';

export function WizardShell(): ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const {
    draftId: ctxDraftId,
    snapshotId,
    extractJobId,
    versionId,
    capabilityId,
    batchId,
    agentReady,
    publishCompleted,
    setCurrentStep,
  } = useWizard();
  const save = useSaveDraft();
  // 稳定的存草稿函数（useSaveDraft 内 useCallback）：单独取出供 handleSaveDraft 依赖，避免每渲染换引用导致注册抖动。
  const runSave = save.save;
  const saving = save.saving;
  const setTopbarAction = useTopbarActionSetter();

  // 当前步：路由派生（非上传子路由兜底首步，与 App 路由 index→import 重定向一致）。
  const routeStep = stepForPath(location.pathname) ?? WIZARD_STEPS[0]!;

  // 路由变化 → 同步当前步到上下文（各步/存草稿据它算）。
  useEffect(() => {
    setCurrentStep(routeStep);
  }, [routeStep, setCurrentStep]);

  // F-15 深链续传：?draftId= → 拉草稿恢复 draftId + selection（工作台点击路径直接带 DraftView，不入此）。
  const draftIdParam = searchParams.get('draftId') ?? undefined;
  const initialDraftIdParamRef = useRef<string | undefined>(draftIdParam);
  const selfBootstrappedDraftParam =
    !initialDraftIdParamRef.current && !!draftIdParam && draftIdParam === ctxDraftId;
  const resumeDraftId = selfBootstrappedDraftParam ? undefined : draftIdParam;
  const resume = useResumeDraft(resumeDraftId);
  const shouldRenderStep = !resumeDraftId || resume.status === 'done';

  const handleSaveDraft = useCallback(async (): Promise<void> => {
    const ok = await runSave();
    // 保存成功：退出回工作台（§5.0「每步可存草稿退出」）。失败：留在原步、就地显 ErrorState。
    if (ok) navigate('/creator');
  }, [runSave, navigate]);

  // 把「保存草稿」上抬进 4A Shell 顶栏（Figma：与面包屑/头像同处一条栏）。仅 saving 变化时重注册（label/disabled 随动），
  // 卸载（离开向导）即清空。无插槽 Provider 时 setTopbarAction 为 no-op（独立单测不崩）。
  useEffect(() => {
    setTopbarAction({
      label: saving ? '保存中…' : '保存草稿',
      onClick: () => void handleSaveDraft(),
      disabled: saving,
    });
    return () => setTopbarAction(null);
  }, [saving, handleSaveDraft, setTopbarAction]);

  return (
    <div className="cb-wizard" data-step={routeStep}>
      <CreationJourney
        pathname={location.pathname}
        draftId={ctxDraftId}
        snapshotId={snapshotId}
        extractJobId={extractJobId}
        versionId={versionId}
        capabilityId={capabilityId}
        batchId={batchId}
        hasAgentReady={agentReady}
        hasTrialResult={searchParams.has('session') || searchParams.has('tested')}
        publishCompleted={publishCompleted}
      />

      {/* 保存草稿失败：就地人话错误 + 重试退路（永不裸错；不阻塞继续编辑）。 */}
      {save.error && (
        <ErrorState
          error={save.error}
          onRetry={() => {
            save.clearError();
            void handleSaveDraft();
          }}
        />
      )}

      {/* 续传加载/失败提示（深链 ?draftId= 恢复时；永不裸转圈/裸错）。 */}
      {resume.status === 'loading' && (
        <p className="cb-wizard__resume-hint" role="status">
          正在恢复你的草稿…
        </p>
      )}
      {resume.status === 'error' && resume.error && (
        <ErrorState error={resume.error} onRetry={resume.retry} />
      )}

      {/* 步骤内容区（当前步实现经 Outlet 渲染；换步不改本壳结构）。 */}
      <div className="cb-wizard__body">{shouldRenderStep ? <Outlet /> : null}</div>
    </div>
  );
}
