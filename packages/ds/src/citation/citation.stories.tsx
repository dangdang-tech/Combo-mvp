import { type StoryGroup } from '../story-types';
import { Citation } from './citation';

export const group: StoryGroup = {
  title: 'Citation',
  component: 'citation',
  stories: [
    {
      name: '默认',
      note: '回答末尾标注单个来源：带序号徽标与可点击的来源链接。',
      render: () => (
        <Citation index={1} label="女装主推款复盘.md" href="https://example.com/docs/review" />
      ),
    },
    {
      name: '仅文字（无链接无序号）',
      note: '来源没有可跳转地址时只展示等宽小字标注，是最退化的形态。',
      render: () => <Citation label="2026-06-12 会话记录" />,
    },
    {
      name: '超长文本',
      note: '来源名与引文都超长时验证折行：徽标不变形、引文块左边框贯穿全部行。',
      render: () => (
        <Citation
          index={12}
          label="一个特别长的来源标题——关于女装主推款点击率判断经验体的完整复盘记录（含全部对话上下文与附件清单）.md"
          href="https://example.com/docs/very-long"
          quote="这里是一段被引用的原文片段，长度刻意拉长以验证引文块的折行表现：当年主推款的 CTR 判断依赖三个信号，分别是历史同款表现、素材首帧信息密度、以及投放前 48 小时的自然流量爬坡曲线，缺一不可。"
        />
      ),
    },
    {
      name: '组合：正文内多引用',
      note: '真实用法：模型回答的段落里行内出现多个引用，其中一个展开了原文引文块。',
      render: () => (
        <p
          style={{
            maxWidth: '48ch',
            font: 'var(--cb-text-md) var(--cb-font-sans)',
            color: 'var(--cb-fg)',
          }}
        >
          根据历史复盘，主推款的点击率判断主要看素材首帧
          <Citation index={1} label="复盘会话 6-12" href="https://example.com/a" />
          与自然流量爬坡
          <Citation
            index={2}
            label="投放笔记"
            href="https://example.com/b"
            quote="投放前 48 小时的自然流量爬坡曲线是最强的先验信号。"
          />
          ，两者需要同时成立。
        </p>
      ),
    },
  ],
};
