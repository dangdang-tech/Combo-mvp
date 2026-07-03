// 候选展示口径（F-11）——类型标签 / 置信徽章 / 名称 / 频次 / 一句话描述 的人话映射。
// 提取页加载卡（CandidateItem）与结果行（CandidateView）共用，避免两处各写一套口径。
import type { CandidateScope, CapabilityType, Confidence } from '@cb/shared';

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

interface CategorySource {
  name: string | null | undefined;
  intent: string | null | undefined;
  scope?: CandidateScope | null | undefined;
  type?: CapabilityType | null | undefined;
}

/** PRD 能力卡分类标签：短期展示层确定性映射，不新增候选字段。 */
export function categoryText(candidate: CategorySource): string {
  const blob = `${candidate.name ?? ''} ${candidate.intent ?? ''} ${candidate.scope?.domain ?? ''}`;
  if (/(ai|prompt|提示词|模型|智能体|agent|llm)/i.test(blob)) return 'AI';
  if (/(figma|react|前端|组件|token|css|ui|交互|设计还原)/i.test(blob)) return '前端';
  if (/(需求|prd|产品|用户|原型|roadmap|增长|商业|投资|vc)/i.test(blob)) return '产品';
  if (/(自动化|表格|飞书|效率|流程|批量|运营|同步)/i.test(blob)) return '效率';
  if (/(bug|日志|根因|修复|排障|工程|代码|测试|部署|架构)/i.test(blob)) return '工程';
  if (/(文档|方案|写作|撰写|总结|大纲|报告|文章)/i.test(blob)) return '写作';
  return typeText(candidate.type);
}

/** 频次条占比（0~1 → 百分宽度；scopeCoherence/frequencyRatio 作可视化条，提取-25）。缺则 0。 */
export function frequencyPercent(ratio: number | null | undefined): number {
  if (typeof ratio !== 'number') return 0;
  return Math.min(100, Math.max(0, Math.round(ratio * 100)));
}
