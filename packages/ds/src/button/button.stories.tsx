import { type StoryGroup } from '../story-types';
import { Button } from './button';

export const group: StoryGroup = {
  title: 'Button',
  component: 'button',
  stories: [
    {
      name: '默认',
      note: '不传 variant 与 size 时得到 secondary 中号按钮，是页面上大多数普通操作的形态。',
      render: () => <Button>保存草稿</Button>,
    },
    {
      name: '变体与尺寸矩阵',
      note: '同一页面需要区分操作层级时，按 primary、secondary、ghost、danger 与三档尺寸组合选择。',
      render: () => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--cb-space-3)' }}>
          {(['sm', 'md', 'lg'] as const).map((size) => (
            <div key={size} style={{ display: 'flex', gap: 'var(--cb-space-3)' }}>
              <Button variant="primary" size={size}>
                发布
              </Button>
              <Button variant="secondary" size={size}>
                保存
              </Button>
              <Button variant="ghost" size={size}>
                取消
              </Button>
              <Button variant="danger" size={size}>
                删除
              </Button>
            </div>
          ))}
        </div>
      ),
    },
    {
      name: '加载与禁用',
      note: '提交请求进行中显示 loading spinner 并阻止重复点击；条件未满足时用 disabled。',
      render: () => (
        <div style={{ display: 'flex', gap: 'var(--cb-space-3)' }}>
          <Button variant="primary" loading>
            正在发布
          </Button>
          <Button variant="secondary" loading>
            正在保存
          </Button>
          <Button variant="primary" disabled>
            发布
          </Button>
        </div>
      ),
    },
    {
      name: '超长文本',
      note: '按钮文案异常冗长（例如翻译文案膨胀）时验证不换行截断、内边距是否仍然成立。',
      render: () => (
        <div style={{ maxWidth: '240px' }}>
          <Button variant="primary">
            把这段会话里沉淀下来的完整经验体打包并发布成可以复用的迷你应用
          </Button>
        </div>
      ),
    },
    {
      name: '对话框底部操作组合',
      note: '真实组合用例：确认弹窗底部右对齐排布 ghost 取消加 danger 确认删除。',
      render: () => (
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 'var(--cb-space-2)',
            padding: 'var(--cb-space-4)',
            border: '1px solid var(--cb-line-2)',
            borderRadius: 'var(--cb-radius-card)',
            background: 'var(--cb-surface)',
          }}
        >
          <Button variant="ghost">取消</Button>
          <Button variant="danger">确认删除</Button>
        </div>
      ),
    },
  ],
};
