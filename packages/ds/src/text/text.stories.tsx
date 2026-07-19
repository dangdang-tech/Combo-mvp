import { type StoryGroup } from '../story-types';
import { Heading, Text } from './text';

export const group: StoryGroup = {
  title: 'Text',
  component: 'text',
  stories: [
    {
      name: '默认正文',
      note: '不传任何可选 prop 时的基线形态，绝大多数段落文字直接这样用。',
      render: () => <Text>经验体沉淀的是一次真实会话里被验证过的判断路径。</Text>,
    },
    {
      name: '四种变体对照',
      note: '同一段内容在 body、muted、caption、label 四个变体下的层级差异，选变体时对照使用。',
      render: () => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--cb-space-2)' }}>
          <Text variant="body">body：正文默认，用于主要阅读内容。</Text>
          <Text variant="muted">muted：弱化说明，用于次要辅助信息。</Text>
          <Text variant="caption">caption：小一档的弱化文字，用于注脚与提示。</Text>
          <Text variant="label" as="span">
            LABEL / RUN-042
          </Text>
        </div>
      ),
    },
    {
      name: '标题阶梯',
      note: '四级衬线标题的字号阶梯，页面里同屏出现多级标题时对照层级。',
      render: () => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--cb-space-3)' }}>
          <Heading level={1}>一级标题</Heading>
          <Heading level={2}>二级标题</Heading>
          <Heading level={3}>三级标题</Heading>
          <Heading level={4}>四级标题</Heading>
        </div>
      ),
    },
    {
      name: '超长文本换行',
      note: '窄容器里放超长中英混排文本，验证换行与行高不被撑破。',
      render: () => (
        <div style={{ maxWidth: '240px' }}>
          <Heading level={3}>
            当一个经验体的标题长到需要折行时它仍然应当保持衬线阶梯与稳定的行高
          </Heading>
          <Text>
            这是一段刻意写得非常长的正文，混入 EnglishWordsWithoutSpacesLikeThisOne
            与连续的中文标点符号……用来验证在 240px
            的窄容器里，正文既能正常换行，也不会出现横向滚动或行距塌陷的问题。
          </Text>
        </div>
      ),
    },
    {
      name: '组合用例：卡片摘要',
      note: '标题、正文、注脚与等宽标签在一张摘要卡片里的真实搭配方式。',
      render: () => (
        <div style={{ maxWidth: '360px', display: 'grid', gap: 'var(--cb-space-2)' }}>
          <Text variant="label" as="span">
            EXPERIENCE / CTR-REVIEW
          </Text>
          <Heading level={3}>女装主推款 CTR 判断</Heading>
          <Text>基于三次投放复盘沉淀的判断路径：先看主图信息密度，再对照人群包点击分布。</Text>
          <Text variant="caption">最近一次校准发生在两天前，命中率百分之七十二。</Text>
        </div>
      ),
    },
  ],
};
