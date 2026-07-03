// 步骤纯函数单测（F-09）——PRD 2 步坍缩后只留路由↔步映射真源（步骤条/底栏专用函数已下线）。
import { describe, it, expect } from 'vitest';
import {
  WIZARD_STEPS,
  WIZARD_STEP_COUNT,
  stepIndex,
  pathForStep,
  stepForPath,
  stepLabel,
  isFirstStep,
  isLastStep,
} from './wizardMachine.js';

describe('wizardMachine（2 步：上传 / 能力页）', () => {
  it('两步固定序 = import→capabilities', () => {
    expect(WIZARD_STEPS).toEqual(['import', 'capabilities']);
    expect(WIZARD_STEP_COUNT).toBe(2);
  });

  it('stepIndex 1-based；首/末步判定', () => {
    expect(stepIndex('import')).toBe(1);
    expect(stepIndex('capabilities')).toBe(2);
    expect(isFirstStep('import')).toBe(true);
    expect(isFirstStep('capabilities')).toBe(false);
    expect(isLastStep('capabilities')).toBe(true);
    expect(isLastStep('import')).toBe(false);
  });

  it('path 与 step 双向映射（CREATE_STEPS 单源）', () => {
    expect(pathForStep('import')).toBe('/create/import');
    expect(pathForStep('capabilities')).toBe('/create/capabilities');
    expect(stepForPath('/create/import')).toBe('import');
    expect(stepForPath('/create/capabilities')).toBe('capabilities');
    // 非上传子路由 → undefined（外壳兜底首步）。
    expect(stepForPath('/creator')).toBeUndefined();
    // 已下线的旧五步路由不再命中。
    expect(stepForPath('/create/extract')).toBeUndefined();
  });

  it('stepLabel 取 CREATE_STEPS.label', () => {
    expect(stepLabel('import')).toBe('上传');
    expect(stepLabel('capabilities')).toBe('能力');
  });
});
