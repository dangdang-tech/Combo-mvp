import { type StoryGroup } from '../story-types';
import { Markdown } from '../markdown/markdown';
import { MiniAppShell } from './mini-app-shell';

const experienceBody = [
  '## 判断结论',
  '',
  '本周主推款建议选 **A 款**。',
  '',
  '| 指标 | A 款 | B 款 |',
  '| --- | --- | --- |',
  '| CTR | 3.2% | 1.8% |',
].join('\n');

export const group: StoryGroup = {
  title: 'MiniAppShell',
  component: 'mini-app-shell',
  stories: [
    {
      name: '默认',
      note: '经验体的标准形态：标题、等宽副标题、ok 状态点和纯文本内容。',
      render: () => (
        <MiniAppShell title="主推款 CTR 判断" subtitle="exp-0042 · v3" status="ok">
          本周主推款建议选 A 款，近 7 天 CTR 稳定在 3% 以上。
        </MiniAppShell>
      ),
    },
    {
      name: '超长标题与 error 态',
      note: '标题溢出与运行失败同时出现的边界：标题折行不撑破容器，error 用 danger 色点。',
      render: () => (
        <MiniAppShell
          title={`女装秋冬主推款点击率判断经验体（${'非常长的限定词'.repeat(6)}）`}
          subtitle={`session-${'0'.repeat(24)}1`}
          status="error"
          footer="上次运行失败：上游数据源超时"
        >
          运行失败，暂无输出。
        </MiniAppShell>
      ),
    },
    {
      name: 'running 态空内容',
      note: '经验体正在跑、还没有产出时的中间态：warn 色呼吸点加占位文案。',
      render: () => (
        <MiniAppShell title="主推款 CTR 判断" subtitle="exp-0042 · v3" status="running">
          正在分析近 7 天投放数据……
        </MiniAppShell>
      ),
    },
    {
      name: '组合 Markdown 正文与 actions',
      note: '真实使用场景：内容区放 Markdown 渲染结果，右上角带操作，底部标注数据来源。',
      render: () => (
        <MiniAppShell
          title="主推款 CTR 判断"
          subtitle="exp-0042 · v3"
          status="ok"
          actions={<button type="button">重新运行</button>}
          footer="来自 12 条会话沉淀 · 数据更新于 2026-07-07"
        >
          <Markdown content={experienceBody} />
        </MiniAppShell>
      ),
    },
  ],
};
