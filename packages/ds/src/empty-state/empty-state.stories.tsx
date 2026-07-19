import { type StoryGroup } from '../story-types';
import { EmptyState } from './empty-state';

const inboxIcon = (
  <svg
    width="32"
    height="32"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M22 12h-6l-2 3h-4l-2-3H2" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </svg>
);

export const group: StoryGroup = {
  title: 'EmptyState',
  component: 'empty-state',
  stories: [
    {
      name: '默认',
      note: '列表首次为空时的最小形态，只有标题和一句描述。',
      render: () => (
        <EmptyState
          title="还没有经验体"
          description="从一段真实会话历史开始，沉淀出第一个可复用的经验体。"
        />
      ),
    },
    {
      name: '超长文本',
      note: '标题与描述都超长时验证换行与居中不破版。',
      render: () => (
        <EmptyState
          title="这里还没有任何一条可以展示的经验体记录哦，需要先完成一次完整的会话沉淀流程"
          description="当会话历史被解析、切分并抽取为可复用的经验片段之后，它们会以卡片的形式出现在这里；在此之前这个区域会一直保持为空，你可以先去导入一段会话历史，或者查看示例经验体来了解整个流程是如何运作的。"
        />
      ),
    },
    {
      name: '图标与操作组合',
      note: '真实业务场景：带图标与引导按钮的完整空状态，用于收件箱为空。',
      render: () => (
        <EmptyState
          icon={inboxIcon}
          title="收件箱是空的"
          description="有新的会话进来时会先出现在这里。"
          action={<button type="button">导入会话历史</button>}
        />
      ),
    },
  ],
};
