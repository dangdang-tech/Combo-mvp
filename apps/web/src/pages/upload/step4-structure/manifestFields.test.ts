// manifestFields 单测（F-13）：软字段流式态归并 / 数组逐项 / 失败态 / 硬字段锁定展示 / 进度 / 全就绪。
import { describe, it, expect } from 'vitest';
import type { Manifest, StructureState } from '@cb/shared';
import {
  buildSoftFields,
  buildHardFields,
  softProgressText,
  allSoftReady,
  isGenerating,
  isDone,
} from './manifestFields.js';

function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    id: 'pm-resume-scorer',
    version: '0.1.0',
    status: 'draft',
    inputs: {
      fields: [
        {
          key: 'role',
          label: '目标岗位',
          type: 'string',
          required: true,
          derivedFrom: 'instructions',
        },
      ],
    },
    output: { type: 'score' },
    boundaries: { riskLevel: 'low', redLines: ['不编造经历'] },
    name: '资格打分器',
    tagline: '按大厂标准给资格做 A-C 档判断',
    role: '资深面试官',
    goal: '判断档位并指出缺口',
    instructions: '读材料，逐维度评估',
    skill_set: ['拆解维度', '定位证据'],
    starter_prompts: ['帮我评这份简历'],
    ...over,
  };
}

describe('buildSoftFields', () => {
  it('无 structureState 但 manifest 有值 → done 终值回显（断流兜底，贯穿-28）', () => {
    const soft = buildSoftFields(manifest(), undefined);
    expect(soft).toHaveLength(7);
    const name = soft.find((s) => s.field === 'name')!;
    expect(name.status).toBe('done');
    expect(name.text).toBe('资格打分器');
    // 数组字段逐项。
    const skills = soft.find((s) => s.field === 'skill_set')!;
    expect(skills.isArray).toBe(true);
    expect(skills.items).toEqual(['拆解维度', '定位证据']);
  });

  it('structureState 流式优先：generating 显 partial、done 显终值、pending 待生成', () => {
    const state: StructureState = {
      versionId: 'v1',
      doneCount: 1,
      totalCount: 7,
      fields: [
        { field: 'name', status: 'done', value: '需求炼金师' },
        { field: 'tagline', status: 'generating', value: '把一段杂乱想法…' },
        { field: 'role', status: 'pending' },
      ],
    };
    const soft = buildSoftFields(manifest(), state);
    const name = soft.find((s) => s.field === 'name')!;
    expect(name.status).toBe('done');
    expect(name.text).toBe('需求炼金师'); // 流式覆盖 manifest 终值。
    const tagline = soft.find((s) => s.field === 'tagline')!;
    expect(tagline.status).toBe('generating');
    expect(tagline.text).toBe('把一段杂乱想法…'); // partial。
    expect(isGenerating(tagline.status)).toBe(true);
    const role = soft.find((s) => s.field === 'role')!;
    expect(role.status).toBe('pending');
  });

  it('数组字段逐项流（item-appended 累积进 value 数组）', () => {
    const state: StructureState = {
      versionId: 'v1',
      doneCount: 0,
      totalCount: 7,
      fields: [{ field: 'skill_set', status: 'generating', value: ['把模糊想法拆成结构化问题'] }],
    };
    const soft = buildSoftFields(manifest(), state);
    const skills = soft.find((s) => s.field === 'skill_set')!;
    expect(skills.status).toBe('generating');
    expect(skills.items).toEqual(['把模糊想法拆成结构化问题']);
  });

  it('failed 态携人话错误 + attempts（§3.4，无 code）', () => {
    const state: StructureState = {
      versionId: 'v1',
      doneCount: 0,
      totalCount: 7,
      fields: [
        {
          field: 'instructions',
          status: 'failed',
          attempts: 2,
          error: {
            userMessage: '这个字段没生成出来，可重试、改输入或转人工。',
            retriable: true,
            action: 'escalate',
            traceId: 't',
          },
        },
      ],
    };
    const soft = buildSoftFields(manifest(), state);
    const ins = soft.find((s) => s.field === 'instructions')!;
    expect(ins.status).toBe('failed');
    expect(ins.attempts).toBe(2);
    expect(ins.error?.userMessage).toContain('没生成出来');
    expect(ins.error).not.toHaveProperty('code');
  });
});

describe('buildHardFields', () => {
  it('6 个硬字段锁定终值人话展示', () => {
    const hard = buildHardFields(manifest());
    expect(hard).toHaveLength(6);
    expect(hard.find((h) => h.field === 'id')!.display).toBe('pm-resume-scorer');
    expect(hard.find((h) => h.field === 'version')!.display).toBe('0.1.0');
    expect(hard.find((h) => h.field === 'status')!.display).toBe('未提交的草稿');
    expect(hard.find((h) => h.field === 'output')!.display).toBe('评分 / 评估结果');
    expect(hard.find((h) => h.field === 'inputs')!.display).toContain('目标岗位');
    expect(hard.find((h) => h.field === 'boundaries')!.display).toContain('红线：不编造经历');
  });

  it('manifest 缺失 → 兜底「—」，不显空白', () => {
    const hard = buildHardFields(undefined);
    expect(hard.every((h) => h.display.length > 0)).toBe(true);
  });
});

describe('进度 / 就绪', () => {
  it('softProgressText 量化「已补全字段 N / 7」', () => {
    const state: StructureState = {
      versionId: 'v1',
      doneCount: 2,
      totalCount: 7,
      fields: [
        { field: 'name', status: 'done', value: 'A' },
        { field: 'tagline', status: 'done', value: 'B' },
        { field: 'role', status: 'generating' },
      ],
    };
    const soft = buildSoftFields(
      manifest({ skill_set: [], starter_prompts: [], goal: '', instructions: '' }),
      state,
    );
    expect(softProgressText(soft)).toBe('已补全字段 2 / 7');
    expect(allSoftReady(soft)).toBe(false);
  });

  it('全 done → allSoftReady=true', () => {
    const soft = buildSoftFields(manifest(), undefined);
    expect(soft.every((s) => isDone(s.status))).toBe(true);
    expect(allSoftReady(soft)).toBe(true);
  });
});
