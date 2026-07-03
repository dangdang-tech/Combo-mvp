// 图表统一视觉常量（与 styles.css 的 --cb-* 设计变量对齐；ECharts option 需要具体色值，
// 不能直接吃 CSS 变量，故在此集中一份，改色时与 styles.css 同步）。
//
// 只放「画图需要的字面量色值/尺寸」，不放业务逻辑。所有图表 option builder 从这里取色，
// 保证四种图（趋势/迷你图/热力图/密度条）观感一致、可一处改全局。
// 配色基线：Figma XwOk3OdwHGSt6gviqS2Doy（暖米 + 砖红），与 --cb-accent / --cb-heat-* 同源。

/** 主题色（与 --cb-accent 同源，砖红）。 */
export const CHART_ACCENT = '#a73718';
/** 面积渐变上色（趋势图填充顶部）。 */
export const CHART_ACCENT_FADE = 'rgba(167, 55, 24, 0.18)';
/** 面积渐变底色（趋势图填充底部，近透明）。 */
export const CHART_ACCENT_FADE_BOTTOM = 'rgba(167, 55, 24, 0.02)';
/** 次要文字 / 轴标签（与 --cb-muted 同源，暖灰）。 */
export const CHART_MUTED = '#6f6860';
/** 主文字（与 --cb-fg 同源）。 */
export const CHART_FG = '#14141a';
/** 网格线 / 边框（与 --cb-border 同源，暖米）。 */
export const CHART_BORDER = '#e1d8ca';
/** 骨架/空槽底色（与 --cb-skeleton 同源，暖灰半透）。 */
export const CHART_SKELETON = 'rgba(115, 110, 102, 0.2)';
/** 峰值标注强调色（砖红，对齐 Figma 峰值药丸）。 */
export const CHART_PEAK = '#a73718';

/**
 * 热力图五档色阶（level 0→4，浅→深；砖红渐进，与 --cb-heat-* 同源）。
 * level 0 = 无活跃（最浅暖米），level 4 = 最活跃（砖红）。
 */
export const HEATMAP_LEVELS: readonly [string, string, string, string, string] = [
  '#f4f0e7', // 0 空/极浅（暖米）
  '#eac4ba', // 1 浅砖粉
  '#d1826b', // 2 中砖
  '#b75130', // 3 深砖
  '#a73718', // 4 最深（砖红）
];

/** 密度条按名次的渐变（前列更亮，砖红→中砖）。 */
export const DENSITY_BAR_TOP = '#a73718';
export const DENSITY_BAR_REST = '#d1826b';

/** 趋势方向色（up/down/flat），密度榜与指标共用。 */
export const TREND_COLORS: Record<'up' | 'down' | 'flat', string> = {
  up: '#0e6d52',
  down: '#b3261e',
  flat: '#6f6860',
};
