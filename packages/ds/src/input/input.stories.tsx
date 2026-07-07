import { type StoryGroup } from '../story-types';
import { Input } from './input';

export const group: StoryGroup = {
  title: 'Input',
  component: 'input',
  stories: [
    {
      name: '默认',
      note: '表单里最常见的文本录入场景，带 label 与 placeholder。',
      render: () => <Input label="店铺名称" placeholder="请输入店铺名称" />,
    },
    {
      name: '搜索型',
      note: '列表页顶部的过滤搜索框，左侧放大镜由组件内置。',
      render: () => <Input type="search" placeholder="搜索经验体" />,
    },
    {
      name: '校验失败与超长文本',
      note: '边界态：提交校验不通过且值超出可视宽度时的显示。',
      render: () => (
        <Input
          label="回调地址"
          invalid
          value="https://example.com/very/long/path/that/overflows/the/visible/width/of/the/input/control?query=extremely-long-value&token=abcdefghijklmnopqrstuvwxyz0123456789"
        />
      ),
    },
    {
      name: '禁用态',
      note: '字段暂不可编辑（例如等待上游数据就绪）时的显示。',
      render: () => <Input label="经验体编号" value="cb-exp-0042" disabled />,
    },
    {
      name: '真实组合：登录表单',
      note: '账号与密码两个输入框纵向组合成登录表单的真实用法。',
      render: () => (
        <div style={{ display: 'grid', gap: 'var(--cb-space-3)', maxWidth: '320px' }}>
          <Input label="邮箱" placeholder="you@example.com" />
          <Input type="password" label="密码" defaultValue="secret-password" />
        </div>
      ),
    },
  ],
};
