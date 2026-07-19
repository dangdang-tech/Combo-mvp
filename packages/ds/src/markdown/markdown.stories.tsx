import { type StoryGroup } from '../story-types';
import { Markdown } from './markdown';

const defaultContent = [
  '# 主推款判断结论',
  '',
  '本周主推款建议选 **A 款**，理由如下：',
  '',
  '- 近 7 天 CTR 稳定在 3% 以上',
  '- 库存深度足够，不会断码',
  '',
  '详细数据见 [报表](https://example.com/report)。',
].join('\n');

const hostileContent = [
  '# 含注入与超长内容的边界用例',
  '',
  '<script>window.alert("xss")</script>',
  '',
  '<img src="x" onerror="window.alert(1)" alt="占位图" />',
  '',
  `这一段是超长文本，用来验证换行与断词表现。${'很长的中文内容不断重复，'.repeat(40)}`,
  '',
  `\`${'inline_code_without_spaces_'.repeat(10)}\``,
].join('\n');

const experienceContent = [
  '## 判断依据',
  '',
  '> 先看点击率，再看库存，最后看退货率。',
  '',
  '| 指标 | A 款 | B 款 |',
  '| --- | --- | --- |',
  '| CTR | 3.2% | 1.8% |',
  '| 退货率 | 9% | 14% |',
  '',
  '### 复算脚本',
  '',
  '```',
  'const ctr = clicks / impressions;',
  'if (ctr > 0.03) pick("A");',
  '```',
].join('\n');

export const group: StoryGroup = {
  title: 'Markdown',
  component: 'markdown',
  stories: [
    {
      name: '默认',
      note: '经验体正文最常见的形态：标题、加粗、列表加一条外链。',
      render: () => <Markdown content={defaultContent} />,
    },
    {
      name: '空内容',
      note: '上游还没产出正文时传入空字符串，容器渲染为空但不报错。',
      render: () => <Markdown content="" />,
    },
    {
      name: '注入与超长文本',
      note: '不可信来源的正文：script 与 onerror 被剥掉，超长中文与长行内代码正常折行。',
      render: () => <Markdown content={hostileContent} />,
    },
    {
      name: '经验体正文组合',
      note: '引用、对比表格和代码块同时出现，是复盘类经验体的典型正文结构。',
      render: () => <Markdown content={experienceContent} />,
    },
  ],
};
