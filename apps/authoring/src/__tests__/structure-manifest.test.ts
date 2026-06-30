// 40 manifest 软硬分层纯逻辑自检（§2.3/§4.E）：inputs.schema 占位抽取、output.type 推断、
//   applySoftField（instructions 派生）、setFieldState（只动该字段，已生成不丢）、initialStructureState（软 pending/硬 locked）。
import { describe, it, expect } from 'vitest';
import { SOFT_FIELD_KEYS, HARD_FIELD_KEYS, type StructureState } from '@cb/shared';
import {
  initialManifest,
  initialStructureState,
  deriveInputSchema,
  deriveOutputType,
  applySoftField,
  applySoftFields,
  setFieldState,
  getFieldState,
  buildStructureState,
} from '../modules/structure/manifest.js';

describe('deriveInputSchema（instructions 占位抽取，§2.3）', () => {
  it('{{key}} 与 {{key|label}} → fields（derivedFrom:instructions，去重保序）', () => {
    const s = deriveInputSchema(
      '先填 {{product_idea|你的产品}}，再 {{audience}}，又 {{product_idea}}',
    );
    expect(s.fields.map((f) => f.key)).toEqual(['product_idea', 'audience']); // 去重。
    expect(s.fields[0]!.label).toBe('你的产品');
    expect(s.fields[1]!.label).toBe('audience'); // 无 label 用 key 兜底。
    expect(s.fields.every((f) => f.derivedFrom === 'instructions')).toBe(true);
  });
  it('无占位 → 空 fields', () => {
    expect(deriveInputSchema('没有占位的纯文本').fields).toEqual([]);
  });
});

describe('deriveOutputType（启发推断，§2.2）', () => {
  it('打分/清单/结构化/默认 text', () => {
    expect(deriveOutputType('给方案打分评估', '', '')).toBe('score');
    expect(deriveOutputType('生成核查清单 checklist', '', '')).toBe('checklist');
    expect(deriveOutputType('产出一份 PRD 结构化文档', '', '')).toBe('structured');
    expect(deriveOutputType('随便聊聊', '', '')).toBe('text');
  });
});

describe('applySoftField（instructions → 系统重算 inputs/output，仍锁定，§4.E）', () => {
  it('改 instructions 重算 inputs.schema + output.type；不触碰 status', () => {
    const mf = initialManifest('c1', '0.1.0');
    const next = applySoftField(mf, 'instructions', '产出 PRD：{{idea|想法}}');
    expect(next.inputs.fields[0]!.key).toBe('idea');
    expect(next.output.type).toBe('structured');
    expect(next.status).toBe('draft'); // status 硬字段不被改写（验收-31）。
    expect(next.id).toBe('c1'); // id 不动。
  });
  it('改非 instructions 软字段不动 inputs', () => {
    const mf = applySoftField(initialManifest('c1', '0.1.0'), 'instructions', '{{a}}');
    const next = applySoftField(mf, 'name', '新名');
    expect(next.name).toBe('新名');
    expect(next.inputs.fields[0]!.key).toBe('a'); // inputs 不因改 name 而变。
  });
  it('applySoftFields：instructions 最后应用（用最新 name/goal 推断 output）', () => {
    const mf = initialManifest('c1', '0.1.0');
    const next = applySoftFields(mf, { name: 'x', instructions: '打分：{{k}}' });
    expect(next.name).toBe('x');
    expect(next.output.type).toBe('score');
    expect(next.inputs.fields[0]!.key).toBe('k');
  });
});

describe('setFieldState（只动该字段，已生成不丢，§3.4/§4.F）', () => {
  it('改一个软字段不动其它；失败态保留已生成值', () => {
    const mf = initialManifest('c1', '0.1.0');
    let st = initialStructureState('v1', mf);
    st = setFieldState(st, 'name', { status: 'done', value: '名称A' });
    st = setFieldState(st, 'tagline', { status: 'done', value: '卖点B' });
    // 把 name 标 failed，value 不传 → 保留已生成值。
    st = setFieldState(st, 'name', { status: 'failed' });
    expect(getFieldState(st, 'name')!.status).toBe('failed');
    expect(getFieldState(st, 'name')!.value).toBe('名称A'); // 已生成不丢。
    expect(getFieldState(st, 'tagline')!.status).toBe('done'); // 其它不动。
    expect(getFieldState(st, 'tagline')!.value).toBe('卖点B');
  });
});

describe('initialStructureState（软 pending/硬 locked，§4.A）', () => {
  it('空 manifest → 软全 pending、硬全 locked、totalCount=7（硬不计 total）', () => {
    const st: StructureState = initialStructureState('v1', initialManifest('c1', '0.1.0'));
    for (const f of SOFT_FIELD_KEYS) expect(getFieldState(st, f)!.status).toBe('pending');
    for (const f of HARD_FIELD_KEYS) {
      expect(st.fields.find((x) => x.field === f)!.status).toBe('locked');
    }
    expect(st.totalCount).toBe(7);
    expect(st.doneCount).toBe(0);
  });
  it('已有软字段值 → done（已生成回显）', () => {
    const mf = initialManifest('c1', '0.1.0');
    mf.name = '有名';
    mf.skill_set = ['a'];
    const st = initialStructureState('v1', mf);
    expect(getFieldState(st, 'name')!.status).toBe('done');
    expect(getFieldState(st, 'skill_set')!.status).toBe('done');
    expect(getFieldState(st, 'tagline')!.status).toBe('pending');
    expect(st.doneCount).toBe(2);
  });
});

describe('buildStructureState（doneCount 只数软字段）', () => {
  it('硬字段 locked 不计入 doneCount/totalCount', () => {
    const mf = initialManifest('c1', '0.1.0');
    const st = buildStructureState('v1', [
      { field: 'name', status: 'done', value: 'x' },
      { field: 'id', status: 'locked', value: 'c1' },
    ]);
    expect(st.doneCount).toBe(1);
    expect(st.totalCount).toBe(1); // 只数软字段（这里 fields 只放了 name 软 + id 硬）。
    void mf;
  });
});
