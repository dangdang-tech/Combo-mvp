import { type StoryGroup } from '../story-types';
import { Text } from '../text/text';
import { Timestamp } from './timestamp';

export const group: StoryGroup = {
  title: 'Timestamp',
  component: 'timestamp',
  stories: [
    {
      name: '默认绝对时间',
      note: '不传 mode 时显示「YYYY-MM-DD HH:mm」，用于详情页等需要精确时间的位置。',
      render: () => <Timestamp value="2026-07-07T08:30:00" />,
    },
    {
      name: '相对时间阶梯',
      note: '会话列表等场景用 relative 模式；这里注入固定 now 展示刚刚、分钟、小时、天四档文案。',
      render: () => (
        <div style={{ display: 'grid', gap: 'var(--cb-space-2)' }}>
          <Timestamp value="2026-07-07T11:59:40" mode="relative" now="2026-07-07T12:00:00" />
          <Timestamp value="2026-07-07T11:15:00" mode="relative" now="2026-07-07T12:00:00" />
          <Timestamp value="2026-07-07T04:00:00" mode="relative" now="2026-07-07T12:00:00" />
          <Timestamp value="2026-06-30T12:00:00" mode="relative" now="2026-07-07T12:00:00" />
        </div>
      ),
    },
    {
      name: '边界：非法输入与未来时间',
      note: '非法 ISO 字符串原样透出便于排查数据问题；未来时间归到「刚刚」，不出现负数文案。',
      render: () => (
        <div style={{ display: 'grid', gap: 'var(--cb-space-2)' }}>
          <Timestamp value="not-a-date" />
          <Timestamp value="2026-07-08T12:00:00" mode="relative" now="2026-07-07T12:00:00" />
        </div>
      ),
    },
    {
      name: '组合用例：会话列表行',
      note: '正文标题加相对时间戳的典型列表行排布，时间戳靠右且不换行。',
      render: () => (
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: 'var(--cb-space-4)',
            maxWidth: '360px',
          }}
        >
          <Text as="span">女装主推款 CTR 判断的第三次校准会话</Text>
          <Timestamp value="2026-07-07T09:30:00" mode="relative" now="2026-07-07T12:00:00" />
        </div>
      ),
    },
  ],
};
