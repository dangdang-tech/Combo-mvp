import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ArtifactView, SessionDetail } from '@cb/shared';
import { ChatPage } from './ChatPage.js';

const mocks = vi.hoisted(() => ({
  detail: undefined as SessionDetail | undefined,
  running: false,
  activeRunId: null as string | null,
  terminalRun: null as {
    runId: string;
    state: 'completed' | 'failed';
    message: string;
  } | null,
  errorMessage: null as string | null,
  artifact: null as ArtifactView | null,
  artifactContent: '<!doctype html><html><body><button>运行</button></body></html>',
  send: vi.fn(),
}));

vi.mock('../api/runtime.js', () => ({
  useSession: () => ({ data: mocks.detail, isPending: false, isError: false, refetch: vi.fn() }),
  useArtifactContent: () => ({
    data: mocks.artifactContent,
    isPending: false,
    isError: false,
  }),
}));

vi.mock('../api/useSessionStream.js', () => ({
  useSessionStream: () => {
    const artifact = mocks.artifact ?? mocks.detail?.artifacts.at(-1) ?? null;
    return {
      activeArtifactId: artifact?.id ?? null,
      artifacts: artifact ? { [artifact.id]: artifact } : {},
      artifactList: artifact ? [artifact] : [],
      streamingText: null,
      running: mocks.running,
      activeRunId: mocks.activeRunId,
      terminalRun: mocks.terminalRun,
      errorMessage: mocks.errorMessage,
      send: mocks.send,
      interrupt: vi.fn(),
      selectArtifact: vi.fn(),
    };
  },
}));

vi.mock('../components/SessionSidebar.js', () => ({
  SessionSidebar: ({ experience, returnTo }: { experience?: string; returnTo?: string | null }) => (
    <div
      data-testid="session-sidebar"
      data-experience={experience}
      data-return-to={returnTo ?? undefined}
    />
  ),
}));

function sessionDetail(mode?: 'consume' | 'studio'): SessionDetail {
  return {
    session: {
      id: '11111111-1111-4111-8111-111111111111',
      capabilityId: '22222222-2222-4222-8222-222222222222',
      title: '周报助手页面设计',
      status: 'active',
      createdAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
      ...(mode ? { mode } : {}),
    },
    capability: {
      id: '22222222-2222-4222-8222-222222222222',
      name: '周报助手',
      summary: '整理本周工作',
      kind: 'workflow',
      inputs: [
        {
          key: 'work',
          label: '本周工作',
          type: 'text',
          required: true,
        },
        {
          key: 'tone',
          label: '表达风格',
          type: 'enum',
          required: false,
          options: ['精炼', '详细'],
        },
      ],
      starterPrompts: ['整理成管理层周报'],
    },
    messages: [],
    artifacts: [],
  } as SessionDetail;
}

function renderPage(url: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/session/:sessionId" element={<ChatPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe('ChatPage studio experience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detail = sessionDetail('studio');
    mocks.running = false;
    mocks.activeRunId = null;
    mocks.terminalRun = null;
    mocks.errorMessage = null;
    mocks.artifact = null;
  });

  it('shows an honest UI-design first screen and returns to My Agent', () => {
    renderPage('/session/11111111-1111-4111-8111-111111111111?returnTo=%2Fcreate%2Fcapabilities');

    expect(screen.getByRole('heading', { level: 1, name: '周报助手 UI' })).toBeInTheDocument();
    expect(screen.getByText('UI 设计')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: '保存状态：尚未生成' })).toHaveAttribute(
      'aria-describedby',
      'rt-studio-save-help',
    );
    expect(
      screen.getByText('每次生成成功后会自动设为 Agent 当前 UI，无需手动保存。'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '返回我的 Agent' })).toHaveAttribute(
      'href',
      '/capabilities',
    );
    expect(screen.getByRole('complementary', { name: 'UI 设计对话' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '描述第一版 UI' })).toHaveAttribute(
      'placeholder',
      '描述你想要的页面结构、交互和视觉…',
    );
    expect(screen.getByRole('button', { name: '生成第一版 UI' })).toBeDisabled();
    expect(screen.getByRole('region', { name: '当前系统默认页面' })).toHaveTextContent(
      '这个 Agent 还没有专属 UI',
    );
    expect(screen.getByRole('region', { name: '系统默认页面预览' })).toBeInTheDocument();
    expect(screen.getByText('仅预览 · 消费者默认页')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /本周工作/ })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: '表达风格' })).toBeDisabled();
    expect(screen.getByRole('option', { name: '精炼' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '补充要求' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '整理成管理层周报' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '开始生成 →' })).toBeDisabled();
    expect(screen.queryByRole('region', { name: '本次试用输入' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('session-sidebar')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '会话管理' })).not.toBeInTheDocument();
    expect(screen.queryByText('返回发布流程')).not.toBeInTheDocument();
  });

  it('keeps the first-generation state truthful and studio-specific', () => {
    mocks.running = true;
    renderPage('/session/11111111-1111-4111-8111-111111111111');

    expect(
      screen.getAllByRole('status').some((node) => node.textContent?.includes('正在生成第一版 UI')),
    ).toBe(true);
    expect(
      screen.queryByText(/理解页面与修改要求|整理页面版本|保留 Agent 能力/),
    ).not.toBeInTheDocument();
  });

  it('accepts mode=studio during mixed-version rollout', () => {
    mocks.detail = sessionDetail();
    renderPage('/session/11111111-1111-4111-8111-111111111111?mode=studio');

    expect(screen.getByRole('complementary', { name: 'UI 设计对话' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '当前系统默认页面' })).toBeInTheDocument();
  });

  it('keeps the default consumer preview after a failed turn produced no UI', () => {
    mocks.detail = {
      ...mocks.detail!,
      messages: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          seq: 1,
          turnId: '77777777-7777-4777-8777-777777777777',
          role: 'assistant',
          content: [{ type: 'text', text: '这轮没有生成页面。' }],
          status: 'completed',
          createdAt: '2026-07-23T00:30:00.000Z',
        },
      ],
    };
    mocks.terminalRun = {
      runId: '77777777-7777-4777-8777-777777777777',
      state: 'failed',
      message: '生成失败',
    };
    mocks.errorMessage = '生成失败';

    renderPage('/session/11111111-1111-4111-8111-111111111111');

    expect(screen.getByRole('region', { name: '当前系统默认页面' })).toBeInTheDocument();
    expect(screen.queryByText('还没有可预览的 UI')).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: '保存状态：本轮未保存' })).toBeInTheDocument();
  });

  it('does not send a business run into the Studio design conversation', () => {
    const seededArtifact: ArtifactView = {
      id: '33333333-3333-4333-8333-333333333333',
      kind: 'html',
      title: '周报助手页面',
      updatedAt: '2026-07-23T01:00:00.000Z',
    };
    mocks.detail = {
      ...mocks.detail!,
      artifacts: [seededArtifact],
      currentUiArtifactId: seededArtifact.id,
    };
    renderPage('/session/11111111-1111-4111-8111-111111111111');
    const frame = screen.getByTitle('周报助手页面') as HTMLIFrameElement;
    const download = screen.getByRole('button', { name: '导出 HTML' });
    expect(download).toHaveAttribute(
      'title',
      '导出当前 UI 的静态 HTML 文件，不包含 Agent 运行能力',
    );
    expect(download).toHaveAttribute(
      'aria-describedby',
      `rt-artifact-download-help-${seededArtifact.id}`,
    );
    expect(screen.getByRole('status', { name: '保存状态：已自动保存' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '当前系统默认页面' })).not.toBeInTheDocument();

    fireEvent(
      window,
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: { type: 'combo:run', version: 1, prompt: '生成本周周报' },
      }),
    );

    expect(mocks.send).not.toHaveBeenCalled();
    expect(
      screen.getByText('当前是 UI 设计预览。请返回「我的 Agent」，从真实试用运行 Agent。'),
    ).toBeInTheDocument();
  });

  it('does not present an old current UI as newly saved after a transport error', () => {
    const currentArtifact: ArtifactView = {
      id: '33333333-3333-4333-8333-333333333333',
      kind: 'html',
      title: '周报助手页面',
      updatedAt: '2026-07-23T01:00:00.000Z',
    };
    mocks.detail = {
      ...mocks.detail!,
      artifacts: [currentArtifact],
      currentUiArtifactId: currentArtifact.id,
    };
    mocks.errorMessage = '发送失败，请重试。';

    renderPage('/session/11111111-1111-4111-8111-111111111111');

    expect(screen.getByRole('status', { name: '保存状态：保存状态待确认' })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: '保存状态：已自动保存' })).not.toBeInTheDocument();
  });
});

describe('ChatPage consume Miniapp bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detail = sessionDetail('consume');
    mocks.running = false;
    mocks.activeRunId = null;
    mocks.terminalRun = null;
    mocks.errorMessage = null;
    mocks.artifact = {
      id: '33333333-3333-4333-8333-333333333333',
      kind: 'html',
      title: '周报助手页面',
      updatedAt: '2026-07-23T01:00:00.000Z',
    };
  });

  it('keeps a task-detail return target across a session-page reload', () => {
    const sessionPath = '/session/11111111-1111-4111-8111-111111111111';
    const taskReturnTo = '/tasks/018f47ea-bc32-7a3d-8f6e-2f90c7b01d43';
    const first = renderPage(`${sessionPath}?returnTo=${encodeURIComponent(taskReturnTo)}`);

    expect(screen.getByTestId('session-sidebar')).toHaveAttribute('data-return-to', taskReturnTo);
    expect(screen.getByRole('button', { name: '返回发布流程' })).toBeInTheDocument();

    first.unmount();
    renderPage(sessionPath);

    expect(screen.getByTestId('session-sidebar')).toHaveAttribute('data-return-to', taskReturnTo);
    expect(screen.getByRole('button', { name: '返回发布流程' })).toBeInTheDocument();
  });

  it('forwards a host-confirmed Miniapp request to the real session stream', async () => {
    mocks.send.mockResolvedValue({
      id: '44444444-4444-4444-8444-444444444444',
      seq: 1,
      turnId: '55555555-5555-4555-8555-555555555555',
      role: 'user',
      content: [{ type: 'text', text: '生成本周周报' }],
      status: 'completed',
      createdAt: '2026-07-23T01:01:00.000Z',
    });
    renderPage('/session/11111111-1111-4111-8111-111111111111');
    const frame = screen.getByTitle('周报助手页面') as HTMLIFrameElement;
    expect(screen.getByTestId('session-sidebar')).toHaveAttribute('data-experience', 'consume');
    expect(screen.getByRole('button', { name: '会话管理' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下载 HTML' })).toBeInTheDocument();
    expect(screen.queryByText('仅预览 · 消费者默认页')).not.toBeInTheDocument();
    expect(screen.queryByText('UI 设计')).not.toBeInTheDocument();

    fireEvent(
      window,
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: { type: 'combo:run', version: 1, prompt: '  生成本周周报  ' },
      }),
    );

    expect(mocks.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认运行' }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    expect(mocks.send).toHaveBeenCalledWith('生成本周周报');
  });
});

describe('ChatPage consume intake regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detail = sessionDetail('consume');
    mocks.running = false;
    mocks.activeRunId = null;
    mocks.terminalRun = null;
    mocks.errorMessage = null;
    mocks.artifact = null;
    mocks.send.mockResolvedValue({
      id: '44444444-4444-4444-8444-444444444444',
      seq: 1,
      turnId: '55555555-5555-4555-8555-555555555555',
      role: 'user',
      content: [{ type: 'text', text: '生成周报' }],
      status: 'completed',
      createdAt: '2026-07-23T01:01:00.000Z',
    });
  });

  it('keeps the consumer form interactive and sends its structured prompt', async () => {
    renderPage('/session/11111111-1111-4111-8111-111111111111');

    expect(screen.getByTestId('session-sidebar')).toHaveAttribute('data-experience', 'consume');
    expect(screen.getByRole('button', { name: '会话管理' })).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: '开始生成 →' });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByRole('textbox', { name: /本周工作/ }), {
      target: { value: '完成 Studio 体验修复' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: '表达风格' }), {
      target: { value: '精炼' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '补充要求' }), {
      target: { value: '突出风险与验收结果' },
    });

    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    expect(mocks.send).toHaveBeenCalledWith(
      '请基于这些输入生成第一版产物。\n\n本周工作：完成 Studio 体验修复\n表达风格：精炼\n补充要求：突出风险与验收结果',
    );
  });
});
