import { type StoryGroup } from '../story-types';
import { Toast, ToastProvider, useToast } from './toast';

function ToastTriggerDemo() {
  const { toast } = useToast();
  return (
    <div style={{ display: 'flex', gap: 'var(--cb-space-2)' }}>
      <button
        type="button"
        onClick={() =>
          toast({
            variant: 'ok',
            title: '经验体已保存',
            description: '草稿已同步到工作台。',
          })
        }
      >
        触发成功通知
      </button>
      <button
        type="button"
        onClick={() =>
          toast({
            variant: 'danger',
            title: '发布失败',
            description: '服务暂时不可用，请稍后重试。',
            durationMs: 8000,
          })
        }
      >
        触发失败通知（8 秒）
      </button>
    </div>
  );
}

export const group: StoryGroup = {
  title: 'Toast',
  component: 'toast',
  stories: [
    {
      name: '默认',
      note: '操作成功后的普通提示，info 变体用中性色条，不抢注意力。',
      render: () => <Toast title="已保存" description="经验体草稿已同步到工作台。" />,
    },
    {
      name: '四种变体',
      note: '按语义选择变体：info 普通提示、ok 成功、warn 需留意、danger 失败。',
      render: () => (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--cb-space-2)',
          }}
        >
          <Toast variant="info" title="正在后台导入会话" />
          <Toast variant="ok" title="发布成功" description="经验体已上线。" />
          <Toast variant="warn" title="接近配额上限" description="本月剩余 3 次调用。" />
          <Toast variant="danger" title="发布失败" description="服务暂时不可用，请稍后重试。" />
        </div>
      ),
    },
    {
      name: '超长文本',
      note: '标题与描述都超长时验证换行与色条不被撑破。',
      render: () => (
        <Toast
          variant="warn"
          title="导入的会话文件名非常非常长以至于一行完全放不下需要折行展示才能看全整个标题内容"
          description="描述同样很长：这段说明文字用来验证通知条在极端内容下的换行表现，包括连续的英文长串 averyveryveryverylongunbreakabletoken 也应该被安全折行而不会横向溢出。"
        />
      ),
    },
    {
      name: '组合：Provider 触发',
      note: '真实用法：页面根部包 ToastProvider，业务代码用 useToast() 入队通知，右下角自动出现并到时消失。',
      render: () => (
        <ToastProvider>
          <ToastTriggerDemo />
        </ToastProvider>
      ),
    },
  ],
};
