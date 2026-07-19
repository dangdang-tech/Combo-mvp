import { type StoryGroup } from '../story-types';
import { Composer, Message, Thread } from './chat';

export const group: StoryGroup = {
  title: 'Chat',
  component: 'chat',
  stories: [
    {
      name: '默认对话',
      note: '最常见的一问一答场景：用户消息靠右、助手消息靠左，气泡上方是作者与时间。',
      render: () => (
        <Thread>
          <Message role="user" author="你" timestamp="2026-07-07T09:30:00">
            帮我看看这个主推款的 CTR 数据。
          </Message>
          <Message role="assistant" author="Combo" timestamp="2026-07-07T09:30:20">
            好的，近七天该款式点击率高于品类均值，建议保持现有投放策略。
          </Message>
        </Thread>
      ),
    },
    {
      name: '生成中与系统提示',
      note: '助手回复尚未返回时用 pending 呼吸点占位，会话状态变化用 system 窄条提示。',
      render: () => (
        <Thread>
          <Message role="system">会话已于 09:28 恢复</Message>
          <Message role="user" author="你" timestamp="2026-07-07T09:31:00">
            换个角度再分析一次。
          </Message>
          <Message role="assistant" author="Combo" pending>
            {''}
          </Message>
        </Thread>
      ),
    },
    {
      name: '超长文本与无空格串',
      note: '边界态：整段长文与不可断行的长串都要在气泡内折行，不能把内容列撑破。',
      render: () => (
        <Thread maxWidth="lg">
          <Message role="user" author="你" timestamp="2026-07-07T09:32:00">
            {'这个需求的背景稍微有点复杂，'.repeat(12)}
          </Message>
          <Message role="assistant" author="Combo" timestamp="2026-07-07T09:32:40">
            {'https://example.com/' + 'a'.repeat(120)}
          </Message>
        </Thread>
      ),
    },
    {
      name: '输入框三种状态',
      note: '默认、禁用、发送中三种输入框状态并排对照，disabled 用于会话只读，sending 用于等待服务端确认。',
      render: () => (
        <div style={{ display: 'grid', gap: 'var(--cb-space-3)' }}>
          <Composer placeholder="输入消息，Enter 发送" />
          <Composer disabled defaultValue="会话已归档，暂不可输入" />
          <Composer sending defaultValue="正在发送这条消息" />
        </div>
      ),
    },
    {
      name: '完整会话组合',
      note: '真实页面里的完整拼装：Thread 承载历史消息，末尾接 Composer 继续输入。',
      render: () => (
        <Thread>
          <Message role="system">经验体「女装主推款 CTR 判断」已加载</Message>
          <Message role="user" author="你" timestamp="2026-07-07T10:02:00">
            这三个候选款先推哪个？
          </Message>
          <Message role="assistant" author="Combo" timestamp="2026-07-07T10:02:30">
            建议先推第二款：主图对比度更高，且历史同版型的点击率表现更稳。
          </Message>
          <Composer placeholder="继续追问…" />
        </Thread>
      ),
    },
  ],
};
