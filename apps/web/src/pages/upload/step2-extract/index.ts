// 提取模块出口（F-11）——PRD 2 步坍缩后，「提取过程态」并入能力页（step2-capabilities）。
//   本模块只保留能力页复用的展示件（加载态逐个浮现卡）+ 数据层 + 候选展示口径；旧的独立提取容器/结果态已下线。
export { ExtractLoading, type ExtractLoadingProps } from './ExtractLoading.js';
export {
  CandidateAppearingCard,
  type CandidateAppearingCardProps,
} from './CandidateAppearingCard.js';
export {
  createExtractJob,
  fetchCandidates,
  retryCandidate,
  jobEventsUrl,
  extractCreatePath,
  candidatesPath,
  candidateRetryPath,
  type CandidatesResult,
} from './extractApi.js';
export {
  TYPE_LABEL,
  CONFIDENCE_LABEL,
  typeText,
  confidenceText,
  nameText,
  categoryText,
  segmentText,
  frequencyPercent,
} from './candidateDisplay.js';
