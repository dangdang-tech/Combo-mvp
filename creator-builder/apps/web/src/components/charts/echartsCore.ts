// ECharts 按需注册入口（tree-shaking：只打进四种图用到的组件，不吞整包）。
//
// 四张图用到：LineChart(趋势/迷你)、BarChart(密度条)、HeatmapChart(热力图)。
// 组件：Grid/Tooltip/VisualMap/Calendar/MarkPoint/Title。渲染器用 Canvas。
// echarts-for-react 的 <ReactEChartsCore echarts={echarts}> 吃这个精简实例。
import * as echarts from 'echarts/core';
import { LineChart, BarChart, HeatmapChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  VisualMapComponent,
  CalendarComponent,
  MarkPointComponent,
  TitleComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  LineChart,
  BarChart,
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  VisualMapComponent,
  CalendarComponent,
  MarkPointComponent,
  TitleComponent,
  CanvasRenderer,
]);

export { echarts };
