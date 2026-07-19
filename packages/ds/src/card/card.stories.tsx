import { type StoryGroup } from '../story-types';
import { Card } from './card';

export const group: StoryGroup = {
  title: 'Card',
  component: 'card',
  stories: [
    {
      name: '默认（surface）',
      note: '列表页与详情页里最常用的内容容器，直接包住一段文字或表单即可。',
      render: () => (
        <Card>
          <p>这是一张 surface 卡片，带 line-2 描边与极轻阴影，默认 md 内边距。</p>
        </Card>
      ),
    },
    {
      name: 'raised 变体',
      note: '需要从灰绿色页面底色上抬起一层时用 raised，例如浮在 bg 上的摘要块。',
      render: () => (
        <Card variant="raised" padding="lg">
          <p>raised 卡片是纯白底、无描边，靠阴影与底色区分层级。</p>
        </Card>
      ),
    },
    {
      name: '边界：无内边距 + 超长文本',
      note: '卡片内容自带布局（如表格、图片）时用 padding=none；超长不换行文本不应撑破圆角容器。',
      render: () => (
        <Card padding="none">
          <div style={{ overflow: 'hidden' }}>
            <p style={{ overflowWrap: 'anywhere' }}>
              ThisIsAVeryLongUnbrokenTokenThatKeepsGoingAndGoingAndGoingToVerifyTheCardDoesNotOverflowItsRoundedCorners一段没有空格的超长中英文混排字符串一段没有空格的超长中英文混排字符串
            </p>
          </div>
        </Card>
      ),
    },
    {
      name: '真实组合：hero 首屏卡',
      note: '首屏主视觉用 hero 变体，标题走衬线字体，元信息走等宽字体。',
      render: () => (
        <Card variant="hero" padding="lg">
          <span
            style={{
              fontFamily: 'var(--cb-font-mono)',
              fontSize: 'var(--cb-text-xs)',
              color: 'var(--cb-muted)',
            }}
          >
            EXPERIENCE / 001
          </span>
          <h2 style={{ fontFamily: 'var(--cb-font-serif)', fontSize: 'var(--cb-text-2xl)' }}>
            女装主推款 CTR 判断
          </h2>
          <p style={{ color: 'var(--cb-muted)' }}>
            把一次真实会话沉淀成可复用的经验体，供团队反复调用。
          </p>
        </Card>
      ),
    },
  ],
};
