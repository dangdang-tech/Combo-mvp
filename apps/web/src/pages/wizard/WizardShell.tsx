// 向导壳 WizardShell（F-09，开工总纲 §5.0）——五步共用壳，渲染在 4A Shell 主区（外壳恒定 D14）。
//
// 结构（自上而下，全在 4A Shell 的 <Outlet> 内容区内；不改 4A 外壳侧栏/顶栏）：
//   1. 向导头条：左标题「上传能力」+ 右「保存草稿」按钮（§5.0 顶栏「保存草稿」落在向导自有头条，
//      不动 4A Shell 顶栏结构 = 守 D14）。保存失败就地落 ErrorState（永不裸错），不阻塞继续编辑。
//   2. 步骤条 StepBar：五段常驻、四态（§5.0）。点已完成/异常步回看（贯穿-16）。
//   3. 步骤内容区：<Outlet> 渲染当前步（STEP①②③④⑤ 各自实现）。
//   4. 底栏 WizardFooter：左步骤摘要 + 右动态主按钮（§5.0 底栏恒定）。
//
// 当前步由路由派生（stepForPath）；五步换内容不改本壳结构（外壳首页-07：任一步壳不变）。
// 续传（F-15）：URL ?draftId= 深链 → findDraftById 恢复 draftId + selection（工作台草稿条点击则直接带 DraftView）。
import { useCallback, useEffect, type ReactElement } from 'react';
import { Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ErrorState } from '../../components/index.js';
import { useTopbarActionSetter } from '../../shell/topbarSlot.js';
import {
  stepForPath,
  buildStepNodes,
  pathForStep,
  progressFrontier,
  WIZARD_STEPS,
} from './wizardMachine.js';
import { StepBar } from './StepBar.js';
import { WizardFooter } from './WizardFooter.js';
import { useWizard } from './WizardContext.js';
import { useSaveDraft } from './useSaveDraft.js';
import { useResumeDraft } from './useResumeDraft.js';

export function WizardShell(): ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const wizard = useWizard();
  const save = useSaveDraft();
  // 稳定的存草稿函数（useSaveDraft 内 useCallback）：单独取出供 handleSaveDraft 依赖，避免每渲染换引用导致注册抖动。
  const runSave = save.save;
  const saving = save.saving;
  const setTopbarAction = useTopbarActionSetter();

  // 当前步：路由派生（非五步子路由兜底首步，与 App 路由 index→import 重定向一致）。
  const routeStep = stepForPath(location.pathname) ?? WIZARD_STEPS[0]!;
  const {
    setCurrentStep,
    stepErrors,
    primaryAction,
    currentStep,
    summaryPrefix,
    snapshotId,
    extractJobId,
    selection,
    versionId,
    capabilityId,
    batchId,
    publishCompleted,
  } = wizard;

  // 路由变化 → 同步当前步到上下文（步骤条/底栏/各步据它算）。
  useEffect(() => {
    setCurrentStep(routeStep);
  }, [routeStep, setCurrentStep]);

  // F-15 深链续传：?draftId= → 拉草稿恢复 draftId + selection（工作台点击路径直接带 DraftView，不入此）。
  const draftIdParam = searchParams.get('draftId') ?? undefined;
  const resume = useResumeDraft(draftIdParam);

  // 步骤条实际进度前沿（BUG-009）：步骤条状态须基于 draft 真实产物，不能让 URL 当前步把前序伪造成已完成。
  //   进度前沿只认「真做过」的产物锚点（progressFrontier）：
  //     - 锚点来源 = 上下文 snapshot/extract/selection/version/capability/batch（WizardLayout 从 URL 初值播种
  //       ∪ 各步前进时 set ∪ 续传 hydrateFromDraft 从 DraftView 回填）。三条来源同口径、统一收敛到上下文。
  //     - 仅有 draftId（深链 `?draftId=` 但草稿没产出过 snapshot/候选/选择/版本）绝不算进度证据——
  //       前序据前沿仍判 todo（真实未开始），绝不伪造 done（脊柱 §8 续传语义 / 测试员 BUG-009 复测要求）。
  //   续传深链恢复中（hydrate 未回填前）前沿暂退首步、前序显 todo + 顶「正在恢复你的草稿…」，
  //   hydrate 落库后前沿据真实产物前移、前序转 done——诚实反映「未知→已知」，不抢先标完成。
  const progressStep = progressFrontier({
    snapshotId,
    extractJobId,
    hasSelection: Boolean(selection),
    versionId,
    capabilityId,
    batchId,
  });
  // 末步发布终态（BUG-022）：STEP⑤ 单发布成功后 publishCompleted=true → 把 'publish' 作终态覆写传入，
  //   使步骤条 STEP⑤ 从「进行中」标「已完成」，与页面主体终态 + 底栏「回工作台」一致；未完成则不覆写（仍进行中）。
  const nodes = buildStepNodes(
    routeStep,
    stepErrors,
    progressStep,
    publishCompleted ? 'publish' : undefined,
  );

  // 点已完成 / 异常步 → 回看 / 重试（贯穿-16）：跳该步路由（保留 ?draftId 续传上下文）。
  const handleNavigate = (step: (typeof nodes)[number]['step']): void => {
    const qs = draftIdParam ? `?draftId=${encodeURIComponent(draftIdParam)}` : '';
    navigate(`${pathForStep(step)}${qs}`);
  };

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
      {/* 「保存草稿」已上抬到 4A Shell 顶栏（与面包屑/头像同处一条栏，对齐 Figma STEP 顶栏）；
          此处不再有独立头条带，避免顶栏下方多出一条空行（还原度问题修复）。 */}

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

      {/* 2. 步骤条（五段四态常驻，§5.0）。 */}
      <StepBar nodes={nodes} onNavigate={handleNavigate} />

      {/* 续传加载/失败提示（深链 ?draftId= 恢复时；永不裸转圈/裸错）。 */}
      {resume.status === 'loading' && (
        <p className="cb-wizard__resume-hint" role="status">
          正在恢复你的草稿…
        </p>
      )}
      {resume.status === 'error' && resume.error && (
        <ErrorState error={resume.error} onRetry={resume.retry} />
      )}

      {/* 3. 步骤内容区（当前步实现经 Outlet 渲染；换步不改本壳结构）。 */}
      <div className="cb-wizard__body">
        <Outlet />
      </div>

      {/* 4. 底栏（左摘要 + 右动态主按钮，§5.0 恒定底栏；各步可注入摘要前缀，如 STEP① 完成态 5.1.3）。 */}
      <WizardFooter
        currentStep={currentStep}
        primaryAction={primaryAction}
        summaryPrefix={summaryPrefix}
      />
    </div>
  );
}
