import { type StoryGroup } from '../story-types';
import { Card } from '../card/card';
import { ListItem } from './list-item';

const avatarStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 'var(--cb-space-6)',
  height: 'var(--cb-space-6)',
  borderRadius: 'var(--cb-radius-pill)',
  background: 'var(--cb-muted-bg)',
  color: 'var(--cb-muted)',
  fontSize: 'var(--cb-text-xs)',
} as const;

const timeStyle = {
  fontFamily: 'var(--cb-font-mono)',
  fontSize: 'var(--cb-text-xs)',
} as const;

export const group: StoryGroup = {
  title: 'ListItem',
  component: 'list-item',
  stories: [
    {
      name: '默认',
      note: '最常见的一行：标题加一段说明，不可点击时渲染为 div。',
      render: () => (
        <ListItem title="女装主推款 CTR 判断" description="从 32 轮真实会话里沉淀的选款经验体。" />
      ),
    },
    {
      name: '边界：超长标题与描述截断',
      note: '标题只保留一行、描述最多两行，用于校验截断在窄容器里不撑破布局。',
      render: () => (
        <div style={{ maxWidth: 'calc(var(--cb-sidebar-w) - var(--cb-space-5))' }}>
          <ListItem
            title="这是一个非常非常非常非常非常非常非常非常非常非常长的会话标题必须在一行内截断"
            description="描述同样很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长，超过两行后应当以省略号截断而不是继续往下顶开列表。"
            trailing={<span style={timeStyle}>09:41</span>}
          />
        </div>
      ),
    },
    {
      name: '选中态（纯 JSON，可无回调渲染）',
      note: '当前打开的条目用 selected，呈现 accent-soft 底色与左侧指示条。',
      render: () => (
        <ListItem
          title="即梦流量黑箱调研"
          description="盲测沙盒承重柱的风险拆解。"
          selected={true}
        />
      ),
    },
    {
      name: '真实组合：卡片内的会话列表',
      note: '侧栏会话列表的典型形态：Card 容器包多行可点击 ListItem，其中一行选中。',
      render: () => (
        <Card padding="none">
          <ListItem
            leading={<span style={avatarStyle}>VC</span>}
            title="Vincent 五问深研"
            description="wedge 收窄结论与下一步动作。"
            trailing={<span style={timeStyle}>06-29</span>}
            selected={true}
            onClick={() => undefined}
          />
          <ListItem
            leading={<span style={avatarStyle}>PL</span>}
            title="PitchLens 复盘"
            description="投资人会谈录音的结构化报告。"
            trailing={<span style={timeStyle}>06-01</span>}
            onClick={() => undefined}
          />
          <ListItem
            leading={<span style={avatarStyle}>TC</span>}
            title="TradingCoach 定位"
            trailing={<span style={timeStyle}>05-31</span>}
            onClick={() => undefined}
          />
        </Card>
      ),
    },
  ],
};
