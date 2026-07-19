// 图表统一视觉常量（与 styles.css 的 --cb-* 设计变量对齐；ECharts option 需要具体色值，
// 不能直接吃 CSS 变量，故在此集中一份，改色时与 styles.css 同步）。
//
// 只放「画图需要的字面量色值/尺寸」，不放业务逻辑。所有图表 option builder 从这里取色，
// 保证四种图（趋势/迷你图/热力图/密度条）观感一致、可一处改全局。
// 配色基线：产品动作/状态色不进入普通数据系列。趋势、排行、热力强度使用墨色中性色阶；
// 只有 up/down 这类有明确方向语义的数据使用绿/红。

/** 普通数据系列主色（墨色，不复用品牌/按钮珊瑚）。 */
export const CHART_SERIES_PRIMARY = '#3d3d3a';
/** 普通数据系列面积渐变顶部。 */
export const CHART_SERIES_FILL = 'rgba(61, 61, 58, 0.16)';
/** 普通数据系列面积渐变底部。 */
export const CHART_SERIES_FILL_BOTTOM = 'rgba(61, 61, 58, 0.015)';
/** 次要文字 / 轴标签（与 --cb-muted 同源，暖灰）。 */
export const CHART_MUTED = '#6c6a64';
/** 主文字（与 --cb-fg 同源）。 */
export const CHART_FG = '#141413';
/** 网格线 / 边框（与 --cb-border 同源，暖奶油边界）。 */
export const CHART_BORDER = '#e6dfd8';
/** 骨架/空槽底色（与 --cb-skeleton 同源）。 */
export const CHART_SKELETON = '#efe9de';
/** 峰值是数据重点而非状态，使用最高对比墨色。 */
export const CHART_PEAK = '#141413';

/**
 * 热力图五档色阶（level 0→4，浅→深；中性强度，与 --cb-heat-* 同源）。
 * level 0 = 无活跃（奶油卡片底），level 4 = 最活跃（墨色）。
 */
export const HEATMAP_LEVELS: readonly [string, string, string, string, string] = [
  '#efe9de', // 0 空/极浅（奶油卡片底）
  '#d8d0c3', // 1 浅暖灰
  '#b4aa9c', // 2 中暖灰
  '#726b62', // 3 深暖灰
  '#141413', // 4 最深（墨色）
];

/** 密度条按名次的对比（前列墨色，其余中性暖灰）。 */
export const DENSITY_BAR_TOP = '#141413';
export const DENSITY_BAR_REST = '#b4aa9c';

/** 趋势方向色（up/down/flat），密度榜与指标共用。 */
export const TREND_COLORS: Record<'up' | 'down' | 'flat', string> = {
  up: '#5db872',
  down: '#c64545',
  flat: '#6c6a64',
};
