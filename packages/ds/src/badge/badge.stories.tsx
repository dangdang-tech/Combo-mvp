import { type StoryGroup } from '../story-types';
import { Badge } from './badge';

export const group: StoryGroup = {
  title: 'Badge',
  component: 'badge',
  stories: [
    {
      name: '默认',
      note: '不传 variant 时得到中性灰底徽标，用于不带语义倾向的标注，例如类型或版本号。',
      render: () => <Badge>DRAFT</Badge>,
    },
    {
      name: '全部语义色',
      note: '状态语义明确时按 ok、warn、danger、accent 选色；accent 只做品牌强调，不用来表示状态好坏。',
      render: () => (
        <div style={{ display: 'flex', gap: 'var(--cb-space-2)', flexWrap: 'wrap' }}>
          <Badge variant="neutral">neutral</Badge>
          <Badge variant="ok">已发布</Badge>
          <Badge variant="warn">待审核</Badge>
          <Badge variant="danger">已失效</Badge>
          <Badge variant="accent">经验体</Badge>
        </div>
      ),
    },
    {
      name: '超长文本',
      note: '徽标内容异常冗长（例如未截断的标签名）时验证单行省略号是否成立、不撑破容器。',
      render: () => (
        <div style={{ maxWidth: '160px' }}>
          <Badge variant="warn">这是一个来自上游数据未经截断的特别长的状态标签文本</Badge>
        </div>
      ),
    },
    {
      name: '列表行状态标注组合',
      note: '真实组合用例：会话列表行右侧用 Badge 标注运行状态，等宽小字与正文形成层级差。',
      render: () => (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--cb-space-3)',
            padding: 'var(--cb-space-3) var(--cb-space-4)',
            border: '1px solid var(--cb-line-2)',
            borderRadius: 'var(--cb-radius-card)',
            background: 'var(--cb-surface)',
            fontFamily: 'var(--cb-font-sans)',
            fontSize: 'var(--cb-text-md)',
            color: 'var(--cb-fg)',
          }}
        >
          <span>女装主推款 CTR 判断</span>
          <div style={{ display: 'flex', gap: 'var(--cb-space-1)' }}>
            <Badge variant="ok">RUNNING</Badge>
            <Badge variant="neutral">v3</Badge>
          </div>
        </div>
      ),
    },
  ],
};
