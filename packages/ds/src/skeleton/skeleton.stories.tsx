import { type StoryGroup } from '../story-types';
import { Skeleton } from './skeleton';

export const group: StoryGroup = {
  title: 'Skeleton',
  component: 'skeleton',
  stories: [
    {
      name: '默认',
      note: '默认 text 变体，占满容器宽度的一行文字占位。',
      render: () => <Skeleton />,
    },
    {
      name: '三种变体与自定义尺寸',
      note: '边界用例：显式传 width/height 自由字符串，覆盖 text、block、circle 三种形态。',
      render: () => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--cb-space-3)' }}>
          <Skeleton variant="text" width="60%" />
          <Skeleton variant="block" width="240px" height="120px" />
          <Skeleton variant="circle" width="48px" height="48px" />
        </div>
      ),
    },
    {
      name: '列表项加载组合',
      note: '真实业务场景：会话列表加载中，头像圆形占位加两行文字占位拼成一条列表项。',
      render: () => (
        <div style={{ display: 'flex', gap: 'var(--cb-space-3)', alignItems: 'center' }}>
          <Skeleton variant="circle" />
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--cb-space-2)',
              flex: 1,
            }}
          >
            <Skeleton variant="text" width="40%" />
            <Skeleton variant="text" width="80%" />
          </div>
        </div>
      ),
    },
  ],
};
