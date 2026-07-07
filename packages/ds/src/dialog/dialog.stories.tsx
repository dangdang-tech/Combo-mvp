import { useState } from 'react';
import { type StoryGroup } from '../story-types';
import { Dialog, type DialogProps } from './dialog';

/** 画廊用的受控壳：点按钮打开对话框，把 open 状态托管在本地。 */
function DialogDemo({
  trigger,
  ...dialogProps
}: { trigger: string } & Omit<DialogProps, 'open' | 'onOpenChange'>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        {trigger}
      </button>
      <Dialog open={open} onOpenChange={setOpen} {...dialogProps} />
    </>
  );
}

/** 真实组合：删除确认，底部两个操作按钮都会关闭对话框。 */
function ConfirmDeleteDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        删除经验体
      </button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="删除经验体"
        description="删除后订阅者将无法继续使用该经验体，此操作不可恢复。"
        footer={
          <>
            <button type="button" onClick={() => setOpen(false)}>
              取消
            </button>
            <button type="button" onClick={() => setOpen(false)}>
              确认删除
            </button>
          </>
        }
      >
        <p>你正在删除「女装主推款 CTR 判断」，请再次确认。</p>
      </Dialog>
    </>
  );
}

export const group: StoryGroup = {
  title: 'Dialog',
  component: 'dialog',
  stories: [
    {
      name: '默认',
      note: '需要用户确认一次操作时的标准形态：标题、描述、正文与底部操作区齐全。',
      render: () => (
        <DialogDemo
          trigger="打开对话框"
          title="发布经验体"
          description="发布后其他店铺可以订阅并使用这套判断经验。"
          footer={<button type="button">我知道了</button>}
        >
          <p>发布前请确认盲测结果已经通过基线对比。</p>
        </DialogDemo>
      ),
    },
    {
      name: '边界态：超长标题且无描述',
      note: '标题超长换行、正文超出面板高度时内部滚动，同时验证 description 缺省的形态。',
      render: () => (
        <DialogDemo
          trigger="打开超长内容对话框"
          title="这是一个非常非常非常非常非常非常非常非常非常非常非常非常长的对话框标题，用来验证换行表现"
        >
          <div>
            {Array.from({ length: 30 }, (_, i) => (
              <p key={i}>第 {i + 1} 段正文内容，用来把面板撑到超过视口高度以验证内部滚动。</p>
            ))}
          </div>
        </DialogDemo>
      ),
    },
    {
      name: '真实组合：删除确认',
      note: '破坏性操作前的二次确认，底部放取消与确认两个动作。',
      render: () => <ConfirmDeleteDemo />,
    },
  ],
};
