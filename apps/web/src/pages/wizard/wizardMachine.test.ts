// 步骤状态机单测（F-09）——五态/序号/路由/底栏文案/续传步骤推导，纯函数无 React。
import { describe, it, expect } from 'vitest';
import {
  WIZARD_STEPS,
  WIZARD_STEP_COUNT,
  stepIndex,
  pathForStep,
  stepForPath,
  stepLabel,
  nextStep,
  prevStep,
  nextStepAction,
  isFirstStep,
  isLastStep,
  buildStepNodes,
  progressFrontier,
  stepSummary,
} from './wizardMachine.js';

describe('wizardMachine 基础', () => {
  it('五步固定序 = import→extract→select→structure→publish', () => {
    expect(WIZARD_STEPS).toEqual(['import', 'extract', 'select', 'structure', 'publish']);
    expect(WIZARD_STEP_COUNT).toBe(5);
  });

  it('stepIndex 1-based；首/末步判定', () => {
    expect(stepIndex('import')).toBe(1);
    expect(stepIndex('select')).toBe(3);
    expect(stepIndex('publish')).toBe(5);
    expect(isFirstStep('import')).toBe(true);
    expect(isFirstStep('select')).toBe(false);
    expect(isLastStep('publish')).toBe(true);
    expect(isLastStep('structure')).toBe(false);
  });

  it('path 与 step 双向映射（CREATE_STEPS 单源）', () => {
    expect(pathForStep('select')).toBe('/create/select');
    expect(stepForPath('/create/select')).toBe('select');
    expect(stepForPath('/create/structure')).toBe('structure');
    // 非五步子路由 → undefined（外壳兜底首步）。
    expect(stepForPath('/creator')).toBeUndefined();
  });

  it('nextStep/prevStep 边界（首步无上一、末步无下一）', () => {
    expect(nextStep('select')).toBe('structure');
    expect(prevStep('select')).toBe('extract');
    expect(prevStep('import')).toBeUndefined();
    expect(nextStep('publish')).toBeUndefined();
  });

  it('底栏主按钮动作名随步变；末步无下一步动作', () => {
    expect(nextStepAction('import')).toBe('提取能力项'); // §5.1.3
    expect(nextStepAction('extract')).toBe('选择能力');
    expect(nextStepAction('select')).toBe('结构化'); // §5.3
    expect(nextStepAction('publish')).toBeUndefined();
  });

  it('stepSummary = 「第 X 步，共 5 步」（§5.0）', () => {
    expect(stepSummary('import')).toBe('第 1 步，共 5 步');
    expect(stepSummary('select')).toBe('第 3 步，共 5 步');
  });

  it('stepLabel 取 CREATE_STEPS.label', () => {
    expect(stepLabel('select')).toContain('选择');
  });
});

describe('buildStepNodes（步骤条五态 + 续传）', () => {
  it('current 之前皆 done（可回看）、current 进行中、之后皆 todo（不可点）', () => {
    const nodes = buildStepNodes('select'); // 第 3 步进行中
    const byStep = Object.fromEntries(nodes.map((n) => [n.step, n]));
    expect(byStep.import!.status).toBe('done');
    expect(byStep.extract!.status).toBe('done');
    expect(byStep.select!.status).toBe('current');
    expect(byStep.structure!.status).toBe('todo');
    expect(byStep.publish!.status).toBe('todo');
    // 已完成步可回看（贯穿-16）；进行中/待办不可点。
    expect(byStep.import!.navigable).toBe(true);
    expect(byStep.select!.navigable).toBe(false);
    expect(byStep.structure!.navigable).toBe(false);
  });

  it('errors 覆写为 error 态，且 error 步可点进去重试（局部失败不连坐）', () => {
    const nodes = buildStepNodes('structure', { extract: true });
    const byStep = Object.fromEntries(nodes.map((n) => [n.step, n]));
    // extract 本应 done，被覆写为 error；其它步不受影响。
    expect(byStep.extract!.status).toBe('error');
    expect(byStep.extract!.navigable).toBe(true); // 可点进去重试（带退路）。
    expect(byStep.import!.status).toBe('done');
    expect(byStep.structure!.status).toBe('current');
  });

  it('待办步显序号数字（§5.0「待办显数字」）', () => {
    const nodes = buildStepNodes('import');
    const publish = nodes.find((n) => n.step === 'publish')!;
    expect(publish.status).toBe('todo');
    expect(publish.index).toBe(5);
  });

  it('首步进行中：全部后续 todo，无 done', () => {
    const nodes = buildStepNodes('import');
    expect(nodes.filter((n) => n.status === 'done')).toHaveLength(0);
    expect(nodes.find((n) => n.step === 'import')!.status).toBe('current');
  });

  it('末步进行中：前四步皆 done（可回看）', () => {
    const nodes = buildStepNodes('publish');
    expect(nodes.filter((n) => n.status === 'done')).toHaveLength(4);
    expect(nodes.every((n) => (n.status === 'done' ? n.navigable : true))).toBe(true);
  });

  it('BUG-009：URL 落点(publish)远超真实进度(import) → 仅真做过的前序标 done，不伪造', () => {
    // progressStep=import（无任何产物锚点），URL 落点=publish：done 前沿取二者小 = import，
    //   故前序绝不被 URL 标 done（只有 < min(curIdx, progressIdx) 才 done）。
    const nodes = buildStepNodes('publish', {}, 'import');
    const byStep = Object.fromEntries(nodes.map((n) => [n.step, n]));
    expect(byStep.import!.status).toBe('todo'); // 没真做过，不伪造 done
    expect(byStep.extract!.status).toBe('todo');
    expect(byStep.select!.status).toBe('todo');
    expect(byStep.structure!.status).toBe('todo');
    expect(byStep.publish!.status).toBe('current'); // 用户正看 publish
    expect(nodes.filter((n) => n.status === 'done')).toHaveLength(0);
  });

  it('BUG-009：URL 落点(publish)、真实进度到 select → 仅 import/extract done，select/structure 仍 todo', () => {
    const nodes = buildStepNodes('publish', {}, 'select');
    const byStep = Object.fromEntries(nodes.map((n) => [n.step, n]));
    // done 前沿 = min(publish=5, select=3) = 3 → 仅 idx<3（import/extract）done。
    expect(byStep.import!.status).toBe('done');
    expect(byStep.extract!.status).toBe('done');
    expect(byStep.select!.status).toBe('todo'); // 真实进度只到此，未做完
    expect(byStep.structure!.status).toBe('todo');
    expect(byStep.publish!.status).toBe('current');
  });

  it('BUG-022：completedStep 终态覆写 → 该步即便正被 URL 落点(current)也标 done 且可回看', () => {
    // 末步发布成功：currentStep=publish（URL 落点），completedStep=publish → publish 从 current 变 done。
    const nodes = buildStepNodes('publish', {}, 'publish', 'publish');
    const byStep = Object.fromEntries(nodes.map((n) => [n.step, n]));
    expect(byStep.publish!.status).toBe('done'); // 终态覆写：不再「进行中」
    expect(byStep.publish!.navigable).toBe(true); // done 即可回看
    expect(nodes.filter((n) => n.status === 'current')).toHaveLength(0); // 无「进行中」步
    expect(nodes.filter((n) => n.status === 'done')).toHaveLength(5); // 五步全完成
  });

  it('BUG-022：不传 completedStep（向后兼容）→ 末步仍「进行中」，三参行为不变', () => {
    const nodes = buildStepNodes('publish', {}, 'publish');
    const byStep = Object.fromEntries(nodes.map((n) => [n.step, n]));
    expect(byStep.publish!.status).toBe('current'); // 未覆写：仍进行中
    expect(nodes.filter((n) => n.status === 'done')).toHaveLength(4);
  });
});

describe('progressFrontier（真实产物锚点 → 进度前沿，BUG-009）', () => {
  it('无任何锚点（仅 draftId 不在此 → 等价无锚点）→ import（绝不伪造前序）', () => {
    expect(progressFrontier({})).toBe('import');
    expect(progressFrontier({ snapshotId: undefined })).toBe('import');
  });

  it('snapshotId（导入做完）→ extract', () => {
    expect(progressFrontier({ snapshotId: 'snap1' })).toBe('extract');
  });

  it('extractJobId（萃取已起）→ select', () => {
    expect(progressFrontier({ snapshotId: 'snap1', extractJobId: 'job1' })).toBe('select');
  });

  it('hasSelection（已定选择）→ structure', () => {
    expect(
      progressFrontier({ snapshotId: 'snap1', extractJobId: 'job1', hasSelection: true }),
    ).toBe('structure');
  });

  it('versionId / capabilityId / batchId（已建版/批）→ publish', () => {
    expect(progressFrontier({ versionId: 'v1' })).toBe('publish');
    expect(progressFrontier({ capabilityId: 'cap1' })).toBe('publish');
    expect(progressFrontier({ batchId: 'b1' })).toBe('publish');
  });

  it('取最远证据：齐备全锚点 → publish', () => {
    expect(
      progressFrontier({
        snapshotId: 'snap1',
        extractJobId: 'job1',
        hasSelection: true,
        versionId: 'v1',
        capabilityId: 'cap1',
      }),
    ).toBe('publish');
  });

  it('hasSelection=false 不算选择证据（仅 extract 锚点 → 仍 select）', () => {
    expect(
      progressFrontier({ snapshotId: 'snap1', extractJobId: 'job1', hasSelection: false }),
    ).toBe('select');
  });
});
