import { type StoryGroup } from '../story-types';
import { Avatar } from './avatar';

const SAMPLE_SRC =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"%3E%3Crect width="32" height="32" fill="%23d8ded8"/%3E%3C/svg%3E';

export const group: StoryGroup = {
  title: 'Avatar',
  component: 'avatar',
  stories: [
    {
      name: '默认',
      note: '只给 name 的最常见形态：中文名回退到第一个字，底色按 name hash 稳定挑选。',
      render: () => <Avatar name="张伟" />,
    },
    {
      name: '回退边界',
      note: '边界用例：英文名取首尾词首字母、单词名取首字母、src 指向不存在的图片时加载失败后回退首字母。',
      render: () => (
        <div style={{ display: 'flex', gap: 'var(--cb-space-3)', alignItems: 'center' }}>
          <Avatar name="Ada Lovelace" />
          <Avatar name="benzema" />
          <Avatar name="王小明" src="https://invalid.example/broken.png" />
        </div>
      ),
    },
    {
      name: '三种尺寸与图片组合',
      note: '真实业务场景：成员列表里混排图片头像与回退头像，覆盖 sm、md、lg 三档尺寸。',
      render: () => (
        <div style={{ display: 'flex', gap: 'var(--cb-space-3)', alignItems: 'center' }}>
          <Avatar name="张伟" size="sm" />
          <Avatar name="Ada Lovelace" size="md" src={SAMPLE_SRC} />
          <Avatar name="李雷" size="lg" />
        </div>
      ),
    },
  ],
};
