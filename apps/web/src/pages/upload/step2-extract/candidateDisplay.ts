// 候选展示口径（F-11）——类型标签 / 置信徽章 / 名称 / 频次 / 一句话描述 的人话映射。
// 提取页加载卡（CandidateItem）与结果行（CandidateView）共用，避免两处各写一套口径。
import type { CapabilityType, Confidence } from '@cb/shared';

/** 类型标签人话（契约 CapabilityType，提取-10）。 */
export const TYPE_LABEL: Record<CapabilityType, string> = {
  'core-workflow': '核心工作流',
  recurring: '经常出现',
  occasional: '偶尔出现',
};

/** 置信徽章人话（契约 confidence: high|med|low，提取-09/12）。 */
export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: '高',
  med: '中',
  low: '低',
};

/** 类型文案（缺则「—」，不显空白/undefined）。 */
export function typeText(type: CapabilityType | null | undefined): string {
  return type ? TYPE_LABEL[type] : '—';
}

/** 置信徽章文案「置信 高/中/低」（缺则「置信 —」）。 */
export function confidenceText(confidence: Confidence | null | undefined): string {
  return confidence ? `置信 ${CONFIDENCE_LABEL[confidence]}` : '置信 —';
}

/** 能力名称（缺则「未命名能力」，不显 undefined）。 */
export function nameText(name: string | null | undefined): string {
  return name ?? '未命名能力';
}

/** 段数文案「9 段」（缺则「— 段」）。 */
export function segmentText(segmentCount: number | null | undefined): string {
  return segmentCount != null ? `${segmentCount} 段` : '— 段';
}

/** 频次条占比（0~1 → 百分宽度；scopeCoherence/frequencyRatio 作可视化条，提取-25）。缺则 0。 */
export function frequencyPercent(ratio: number | null | undefined): number {
  if (typeof ratio !== 'number') return 0;
  return Math.min(100, Math.max(0, Math.round(ratio * 100)));
}
