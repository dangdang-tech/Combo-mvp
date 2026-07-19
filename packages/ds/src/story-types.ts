// 轻量 story 合同：不引入 Storybook 依赖，story 是纯对象，demo 画廊直接消费，
// 同时充当 agent 的 few-shot 用例与视觉回归的取材点。
import { type ReactNode } from 'react';

export interface Story {
  /** story 名称，例如「默认」「超长文本」「空数据」。 */
  name: string;
  render: () => ReactNode;
  /** 一句话说明这个用例什么时候会出现。 */
  note?: string;
}

export interface StoryGroup {
  /** 组件展示名，例如 Button。 */
  title: string;
  /** 对应组件目录名，例如 button。 */
  component: string;
  stories: Story[];
}
