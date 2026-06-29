// ② 指标带测试（主页-03/04/26）——能力点数/知识领域数真实；总调用量+热度 usage 占位（不显 0）；
// 最热主题名真实（name=null → 「暂无主题」）；只读硬信号 data-readonly。
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MetricsBandSection } from './MetricsBandSection.js';
import { makeMetrics, PLACEHOLDER_META } from '../fixtures.js';

describe('MetricsBandSection ② 指标带', () => {
  it('能力点数 / 知识领域数 真实显示', () => {
    render(<MetricsBandSection metrics={makeMetrics()} meta={PLACEHOLDER_META} />);
    expect(screen.getByText('能力点数')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.getByText('知识领域数')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('总调用量 usage 占位「暂无数据/上线后填充」，绝不显 0', () => {
    const { container } = render(
      <MetricsBandSection metrics={makeMetrics()} meta={PLACEHOLDER_META} />,
    );
    expect(container.querySelector('[data-placeholder="totalInvocations"]')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('最热主题名真实显示（增长策略），热度数字 usage 占位', () => {
    const { container } = render(
      <MetricsBandSection metrics={makeMetrics()} meta={PLACEHOLDER_META} />,
    );
    expect(screen.getByText('增长策略')).toBeInTheDocument();
    // 占位键对齐后端/契约真键 hottestTopic.heatValue（§2.2，非自造 hottestTopicHeat）。
    expect(
      container.querySelector('[data-placeholder="hottestTopic.heatValue"]'),
    ).toBeInTheDocument();
  });

  it('最热主题 name=null → 「暂无主题」（非空白/非数字，主页-03）', () => {
    render(
      <MetricsBandSection
        metrics={makeMetrics({ hottestTopic: { name: null, heatValue: null } })}
        meta={PLACEHOLDER_META}
      />,
    );
    expect(screen.getByText('暂无主题')).toBeInTheDocument();
  });

  it('只读硬信号：容器 data-readonly=true（前端据此禁下钻，主页-04）', () => {
    const { container } = render(
      <MetricsBandSection metrics={makeMetrics()} meta={PLACEHOLDER_META} />,
    );
    expect(container.querySelector('[data-readonly="true"]')).toBeInTheDocument();
  });

  it('不渲染任何收益/消耗等经营维度字段', () => {
    render(<MetricsBandSection metrics={makeMetrics()} meta={PLACEHOLDER_META} />);
    expect(screen.queryByText(/收益/)).toBeNull();
    expect(screen.queryByText(/消耗/)).toBeNull();
    expect(screen.queryByText(/￥|¥|\$/)).toBeNull();
  });
});
