// 图表统一视觉常量（与 styles.css 的 --cb-* 设计变量对齐；ECharts option 需要具体色值，
// 不能直接吃 CSS 变量，故在此集中一份，改色时与 styles.css 同步）。
//
// 只放「画图需要的字面量色值/尺寸」，不放业务逻辑。所有图表 option builder 从这里取色，
// 保证四种图（趋势/迷你图/热力图/密度条）观感一致、可一处改全局。

/** 主题色（与 --cb-accent 同源）。 */
export const CHART_ACCENT = '#3370ff';
/** 面积渐变上色（趋势图填充顶部）。 */
export const CHART_ACCENT_FADE = 'rgba(51, 112, 255, 0.18)';
/** 面积渐变底色（趋势图填充底部，近透明）。 */
export const CHART_ACCENT_FADE_BOTTOM = 'rgba(51, 112, 255, 0.02)';
/** 次要文字 / 轴标签（与 --cb-muted 同源）。 */
export const CHART_MUTED = '#646a73';
/** 主文字（与 --cb-fg 同源）。 */
export const CHART_FG = '#1f2329';
/** 网格线 / 边框（与 --cb-border 同源）。 */
export const CHART_BORDER = '#e3e6ea';
/** 骨架/空槽底色（与 --cb-skeleton 同源）。 */
export const CHART_SKELETON = '#eceef0';
/** 峰值标注点强调色。 */
export const CHART_PEAK = '#ff8800';

/**
 * 热力图五档色阶（level 0→4，浅→深；GitHub 风格蓝绿渐进）。
 * level 0 = 无活跃（最浅），level 4 = 最活跃（最深）。
 */
export const HEATMAP_LEVELS: readonly [string, string, string, string, string] = [
  '#ebedf0', // 0 空/极浅
  '#c6dafc', // 1
  '#7fa8f5', // 2
  '#4a82f0', // 3
  '#2b5fd6', // 4 最深
];

/** 密度条按名次的渐变（前列更亮）。 */
export const DENSITY_BAR_TOP = '#3370ff';
export const DENSITY_BAR_REST = '#9db8f5';

/** 趋势方向色（up/down/flat），密度榜与指标共用。 */
export const TREND_COLORS: Record<'up' | 'down' | 'flat', string> = {
  up: '#2ba471',
  down: '#d83931',
  flat: '#646a73',
};
