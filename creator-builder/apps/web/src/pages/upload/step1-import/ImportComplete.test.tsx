// F-10 STEP① 完成态组件测试：成功横幅（含重新导入入口）+ 统计四格 + 原始会话列表（只读）。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SnapshotView, SnapshotSegmentView } from '@cb/shared';
import { ImportComplete } from './ImportComplete.js';

const noop = (): void => undefined;

function snapshot(over: Partial<SnapshotView> = {}): SnapshotView {
  return {
    id: 'snap1',
    ownerUserId: 'u1',
    source: 'mixed',
    sources: ['claude', 'codex'],
    stats: {
      segmentCount: 215,
      messageCount: 8420,
      timeSpan: { from: '2026.03', to: '2026.06' },
      projectCount: 14,
    },
    redaction: { applied: true, totalRedactions: 12, byCategory: [], rulesetVersion: 'v1' },
    createdAt: '2026-06-17T00:00:00Z',
    ...over,
  };
}

function seg(over: Partial<SnapshotSegmentView> = {}): SnapshotSegmentView {
  return {
    segmentId: 's1',
    dateLabel: '03-20',
    title: '保单条款梳理',
    messageCount: 42,
    readOnly: true,
    ...over,
  };
}

describe('ImportComplete', () => {
  it('成功横幅逐字对齐 §5.1.3 / 导入-13：主行「已导入全部对话历史（来源）」+ 副行下一步指引', () => {
    render(<ImportComplete snapshot={snapshot()} segments={[]} onReimport={noop} />);
    // 主行：来源口径动态拼（Claude + Codex）。
    expect(screen.getByText('已导入全部对话历史（Claude + Codex）')).toBeInTheDocument();
    // 副行：下一步指引（§5.1.3 逐字）。
    expect(screen.getByText('生成了一份原始数据，下一步从中提取能力项')).toBeInTheDocument();
  });

  it('完成横幅带「重新导入」入口，点击触发 onReimport（导入-13/21）', async () => {
    const onReimport = vi.fn();
    render(<ImportComplete snapshot={snapshot()} segments={[]} onReimport={onReimport} />);
    await userEvent.click(screen.getByRole('button', { name: '重新导入' }));
    expect(onReimport).toHaveBeenCalledOnce();
  });

  it('统计四格：会话段 / 消息条数 / 时间跨度 / 涉及项目（真实值，非占位）', () => {
    render(<ImportComplete snapshot={snapshot()} segments={[]} onReimport={noop} />);
    expect(screen.getByText('会话段')).toBeInTheDocument();
    expect(screen.getByText('215')).toBeInTheDocument();
    expect(screen.getByText('8,420')).toBeInTheDocument(); // 千分位
    expect(screen.getByText('2026.03 – 2026.06')).toBeInTheDocument();
    expect(screen.getByText('14')).toBeInTheDocument();
  });

  it('时间跨度缺失 → 显「—」（不显 undefined）', () => {
    render(
      <ImportComplete
        snapshot={snapshot({
          stats: { segmentCount: 1, messageCount: 1, timeSpan: null, projectCount: 0 },
        })}
        segments={[]}
        onReimport={noop}
      />,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('原始会话列表（只读）：去敏后标题 + 日期 + 条数', () => {
    render(
      <ImportComplete
        snapshot={snapshot()}
        segments={[seg(), seg({ segmentId: 's2', title: 'PRD 评审', project: 'agora' })]}
        onReimport={noop}
      />,
    );
    expect(screen.getByText('原始会话（只读）')).toBeInTheDocument();
    expect(screen.getByText('保单条款梳理')).toBeInTheDocument();
    expect(screen.getByText('PRD 评审')).toBeInTheDocument();
    expect(screen.getByText('agora')).toBeInTheDocument();
  });

  it('无会话节选 → 空态副文（不空白）', () => {
    render(<ImportComplete snapshot={snapshot()} segments={[]} onReimport={noop} />);
    expect(screen.getByText('这次没有可展示的会话节选。')).toBeInTheDocument();
  });
});
