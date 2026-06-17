// F-10 STEP① 空态引导组件测试：两种导入方式 + 开始导入触发 + 底部说明常驻。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImportEmptyState } from './ImportEmptyState.js';

describe('ImportEmptyState', () => {
  it('大标题逐字对齐 PRD §5.1.1 / 验收 导入-01（把对话历史，变成可发布的能力）', () => {
    render(<ImportEmptyState onStart={() => undefined} />);
    expect(screen.getByText('把对话历史，变成可发布的能力')).toBeInTheDocument();
  });

  it('渲染两种导入方式：一键导入（本机直读）·推荐·最全 + CURL 命令导入预览（导入-02/03）', () => {
    render(<ImportEmptyState onStart={() => undefined} />);
    // 卡 1 标题 + 角标 + 说明（导入-02）。
    expect(screen.getByText('一键导入（本机直读）')).toBeInTheDocument();
    expect(screen.getByText('推荐 · 最全')).toBeInTheDocument();
    expect(
      screen.getByText(
        '直接扫描这台机器上全部 ~/.claude、~/.codex —— 全自动，无需选文件夹，不会漏。',
      ),
    ).toBeInTheDocument();
    // 卡 2 标题 + 说明 + 命令框（导入-03，验收口径串 curl -fsSL agora.app/import | sh）。
    expect(screen.getByText('CURL 命令导入')).toBeInTheDocument();
    expect(
      screen.getByText(
        '复制一行命令到终端运行，程序化全量扫描你本机全部历史并上传。一个文件夹都不用选。',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('curl -fsSL agora.app/import | sh')).toBeInTheDocument();
  });

  it('「开始导入 →」点击触发 onStart', async () => {
    const onStart = vi.fn();
    render(<ImportEmptyState onStart={onStart} />);
    await userEvent.click(screen.getByRole('button', { name: '开始导入 →' }));
    expect(onStart).toHaveBeenCalledOnce();
  });

  it('starting=true → 按钮禁用 + 显「准备中…」（防重复点，永不裸转圈）', () => {
    render(<ImportEmptyState onStart={() => undefined} starting />);
    const btn = screen.getByRole('button', { name: '准备中…' });
    expect(btn).toBeDisabled();
  });

  it('底部导入说明常驻，逐字对齐 PRD §5.1.1 / 验收 导入-04（完整上传到云端、云端解析去敏）', () => {
    render(<ImportEmptyState onStart={() => undefined} />);
    expect(screen.getByText('导入说明')).toBeInTheDocument();
    expect(
      screen.getByText(
        '导入会把你选择的对话历史完整上传到云端，由云端解析、去敏后再用于后续步骤。',
      ),
    ).toBeInTheDocument();
  });

  it('负向（导入-05/29）：不出现「数据不出本机 / 只上传精简 / 本机解析」这类承诺', () => {
    const { container } = render(<ImportEmptyState onStart={() => undefined} />);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/数据不出本机/);
    expect(text).not.toMatch(/原文不留底/);
    expect(text).not.toMatch(/只上传提取后/);
    expect(text).not.toMatch(/仅上传精简/);
    expect(text).not.toMatch(/解析在你浏览器本地完成/);
  });
});
