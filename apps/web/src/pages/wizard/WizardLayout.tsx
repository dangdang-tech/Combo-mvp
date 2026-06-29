// 向导路由布局（F-09）——在 /create 路由挂 WizardProvider + WizardShell。
//
// 把当前步 / 草稿 id 从 URL 派生作为 Provider 初值（避免首帧步骤条/底栏闪默认值），
// 之后 WizardShell 在路由变化时 setCurrentStep 持续同步。五步子路由经 WizardShell 内 <Outlet> 渲染。
import type { ReactElement } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { WizardProvider } from './WizardContext.js';
import { WizardShell } from './WizardShell.js';
import { stepForPath, WIZARD_STEPS } from './wizardMachine.js';

export function WizardLayout(): ReactElement {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const initialStep = stepForPath(location.pathname) ?? WIZARD_STEPS[0]!;
  const initialDraftId = searchParams.get('draftId') ?? undefined;
  const initialSnapshotId = searchParams.get('snapshotId') ?? undefined;
  const initialExtractJobId = searchParams.get('extractJobId') ?? undefined;
  // STEP④/⑤ 续传引用：version=（建版后回填，续传不重建版）、capability=（真实 capabilities.id，
  //   供 STEP⑤ 读 publication 拒绝态闭环，P1-5）、batchId=（全部发布续传同一批次）。
  const initialVersionId = searchParams.get('version') ?? undefined;
  const initialCapabilityId = searchParams.get('capability') ?? undefined;
  const initialBatchId = searchParams.get('batchId') ?? undefined;

  return (
    <WizardProvider
      initialStep={initialStep}
      initialDraftId={initialDraftId}
      initialSnapshotId={initialSnapshotId}
      initialExtractJobId={initialExtractJobId}
      initialVersionId={initialVersionId}
      initialCapabilityId={initialCapabilityId}
      initialBatchId={initialBatchId}
    >
      <WizardShell />
    </WizardProvider>
  );
}
