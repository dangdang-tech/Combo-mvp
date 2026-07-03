// F-10 STEP① 空态引导组件测试（命令行优先方案）：主路径命令行/本机直读 + 折叠的浏览器兜底 + 底部说明常驻。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImportEmptyState } from './ImportEmptyState.js';

const noop = (): void => undefined;

const BROWSER_TOGGLE = '不想开终端？用浏览器选文件上传';

describe('ImportEmptyState', () => {
  it('大标题逐字对齐 PRD §5.1.1 / 验收 导入-01（把对话历史，变成可发布的能力）', () => {
    render(<ImportEmptyState onFiles={noop} onStart={noop} />);
    expect(screen.getByText('把对话历史，变成可发布的能力')).toBeInTheDocument();
  });

  it('主路径是「命令行导入（本机直读）」主卡，标推荐 + 「开始导入 →」入口（命令行优先）', () => {
    render(<ImportEmptyState onFiles={noop} onStart={noop} />);
    expect(screen.getByText('命令行导入（本机直读）')).toBeInTheDocument();
    expect(screen.getByText('推荐 · 最省事')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始导入 →' })).toBeInTheDocument();
    // 浏览器导入默认折叠：选文件/选文件夹入口不在文档里。
    expect(screen.queryByRole('button', { name: '选择文件' })).not.toBeInTheDocument();
  });

  it('点「开始导入 →」触发 onStart（主路径铸码）', async () => {
    const onStart = vi.fn();
    render(<ImportEmptyState onFiles={noop} onStart={onStart} />);
    await userEvent.click(screen.getByRole('button', { name: '开始导入 →' }));
    expect(onStart).toHaveBeenCalledOnce();
  });

  it('starting=true → 开始导入按钮禁用 + 显「准备中…」（防重复点）', () => {
    render(<ImportEmptyState onFiles={noop} onStart={noop} starting />);
    expect(screen.getByRole('button', { name: '准备中…' })).toBeDisabled();
  });

  it('浏览器导入默认折叠；展开后露出选文件/选文件夹（不想开终端时的兜底）', async () => {
    render(<ImportEmptyState onFiles={noop} onStart={noop} />);
    expect(screen.queryByText('从浏览器导入')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: BROWSER_TOGGLE }));
    expect(screen.getByText('从浏览器导入')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '选择文件' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '选择文件夹' })).toBeInTheDocument();
  });

  it('uploading=true（展开浏览器兜底后）→ 选文件/选文件夹禁用（编排在途，防重复触发）', async () => {
    render(<ImportEmptyState onFiles={noop} onStart={noop} uploading />);
    await userEvent.click(screen.getByRole('button', { name: BROWSER_TOGGLE }));
    expect(screen.getByRole('button', { name: '选择文件' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '选择文件夹' })).toBeDisabled();
  });

  it('底部导入说明常驻，逐字对齐 PRD §5.1.1 / 验收 导入-04（完整上传到云端、云端解析去敏）', () => {
    render(<ImportEmptyState onFiles={noop} onStart={noop} />);
    expect(screen.getByText('导入说明')).toBeInTheDocument();
    expect(
      screen.getByText(
        '导入会把你选择的对话历史完整上传到云端，由云端解析、去敏后再用于后续步骤。',
      ),
    ).toBeInTheDocument();
  });

  it('负向（导入-05/29）：不出现「数据不出本机 / 只上传精简 / 本机解析」这类承诺（含展开浏览器兜底后）', async () => {
    const { container } = render(<ImportEmptyState onFiles={noop} onStart={noop} />);
    await userEvent.click(screen.getByRole('button', { name: BROWSER_TOGGLE }));
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/数据不出本机/);
    expect(text).not.toMatch(/原文不留底/);
    expect(text).not.toMatch(/只上传提取后/);
    expect(text).not.toMatch(/仅上传精简/);
    expect(text).not.toMatch(/解析在你浏览器本地完成/);
  });
});
