// ② 指标带（主页-03/04/26）——能力点数 / 知识领域数（真实）+ 总调用量（usage 占位）+ 最热主题（名真实·热度占位）。
//
// 只读不下钻：readonly:true 是后端硬信号，前端据此不渲染任何点击下钻/明细入口；绝不显收益/消耗等经营维度。
// usage 占位：totalInvocations 与 hottestTopic.heatValue 为 null + meta.placeholders → 用 4A UsagePlaceholder，绝不显 0。
// 最热主题名真实：name=null 时显示「暂无主题」（主页-03 要求主题名而非空白/数字）。
import type { ReactElement } from 'react';
import type { ProfileMetricsBand, Meta } from '@cb/shared';
import { UsagePlaceholder, compactNumber } from '../../../components/index.js';

export interface MetricsBandSectionProps {
  metrics: ProfileMetricsBand;
  meta: Meta | undefined;
}

function RealMetric({ label, value }: { label: string; value: number }): ReactElement {
  return (
    <div className="cb-profile-metric" data-metric={label}>
      <span className="cb-profile-metric__value">{compactNumber(value)}</span>
      <span className="cb-profile-metric__label">{label}</span>
    </div>
  );
}

export function MetricsBandSection({ metrics, meta }: MetricsBandSectionProps): ReactElement {
  const topicName = metrics.hottestTopic.name ?? '暂无主题';
  return (
    <section
      className="cb-profile-section cb-profile-metrics"
      aria-label="指标带"
      // 只读硬信号：标在容器上，便于样式禁用任何下钻交互（主页-04）。
      data-readonly={metrics.readonly}
    >
      <RealMetric label="能力点数" value={metrics.capabilityCount} />
      <RealMetric label="知识领域数" value={metrics.domainCount} />

      <div className="cb-profile-metric" data-metric="总调用量">
        {/* usage 占位：绝不显 0、绝不裸转圈 */}
        <UsagePlaceholder field="totalInvocations" meta={meta} />
        <span className="cb-profile-metric__label">总调用量</span>
      </div>

      <div className="cb-profile-metric" data-metric="最热主题">
        <span className="cb-profile-metric__value cb-profile-metric__topic">{topicName}</span>
        {/* 热度数字 usage 占位（主题名真实在上）。字段键对齐后端/契约：hottestTopic.heatValue（§2.2，非自造 hottestTopicHeat）。 */}
        <span className="cb-profile-metric__label">
          最热主题 · <UsagePlaceholder field="hottestTopic.heatValue" meta={meta} />
        </span>
      </div>
    </section>
  );
}
