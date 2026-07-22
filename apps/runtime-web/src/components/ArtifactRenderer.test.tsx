import { fireEvent, render, screen } from '@testing-library/react';
import type { ArtifactVersion } from '@cb/shared';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactRenderer } from './ArtifactRenderer.js';

function htmlArtifact(): ArtifactVersion {
  return {
    artifactKey: 'main',
    version: 2,
    kind: 'html',
    title: '每日待办 Miniapp',
    language: null,
    content:
      '<!doctype html><html><body><h1>Agent-VM 任务助手</h1><button data-combo-key="run-primary">运行</button></body></html>',
    createdAt: '2026-07-21T10:00:00.000Z',
  };
}

describe('ArtifactRenderer Runtime bridge', () => {
  it('accepts a versioned run request only from the rendered iframe', () => {
    const onRunRequest = vi.fn();
    render(<ArtifactRenderer artifact={htmlArtifact()} onRunRequest={onRunRequest} />);
    const frame = screen.getByTitle('每日待办 Miniapp') as HTMLIFrameElement;

    fireEvent(
      window,
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: { type: 'combo:run', version: 1, prompt: '  整理今天的任务  ' },
      }),
    );

    expect(onRunRequest).toHaveBeenCalledWith({ prompt: '整理今天的任务' });
  });

  it('ignores forged, malformed, empty, and oversized requests', () => {
    const onRunRequest = vi.fn();
    render(<ArtifactRenderer artifact={htmlArtifact()} onRunRequest={onRunRequest} />);
    const frame = screen.getByTitle('每日待办 Miniapp') as HTMLIFrameElement;
    const dispatch = (source: MessageEventSource | null, data: unknown) => {
      fireEvent(window, new MessageEvent('message', { source, data }));
    };

    dispatch(window, { type: 'combo:run', version: 1, prompt: '伪造来源' });
    dispatch(frame.contentWindow, { type: 'combo:run', version: 2, prompt: '旧协议' });
    dispatch(frame.contentWindow, { type: 'combo:run', version: 1, prompt: '   ' });
    dispatch(frame.contentWindow, {
      type: 'combo:run',
      version: 1,
      prompt: 'x'.repeat(12_001),
    });
    dispatch(frame.contentWindow, 'not-an-object');

    expect(onRunRequest).not.toHaveBeenCalled();
  });

  it('injects the Studio inspection bridge only for editable previews', () => {
    const { rerender } = render(<ArtifactRenderer artifact={htmlArtifact()} />);
    let frame = screen.getByTitle('每日待办 Miniapp') as HTMLIFrameElement;

    expect(frame.srcdoc).not.toContain('combo:element-select');

    rerender(
      <ArtifactRenderer artifact={htmlArtifact()} inspectionEnabled onElementSelect={vi.fn()} />,
    );
    frame = screen.getByTitle('每日待办 Miniapp') as HTMLIFrameElement;

    expect(frame.srcdoc).toContain('combo:element-select');
    expect(frame.srcdoc).toContain('data-combo-key="run-primary"');
  });

  it('selects a semantic page element even when the generated HTML omitted its stable key', async () => {
    render(
      <ArtifactRenderer
        artifact={htmlArtifact()}
        inspectionEnabled
        onElementSelect={vi.fn()}
        onElementManifest={vi.fn()}
      />,
    );
    const frame = screen.getByTitle('每日待办 Miniapp') as HTMLIFrameElement;
    const dom = new JSDOM(frame.srcdoc, {
      pretendToBeVisual: true,
      runScripts: 'dangerously',
      url: 'https://preview.combo.test/',
    });
    await new Promise<void>((resolve) => dom.window.addEventListener('load', () => resolve()));
    const postMessage = vi.spyOn(dom.window, 'postMessage');

    dom.window.dispatchEvent(
      new dom.window.MessageEvent('message', {
        source: dom.window as unknown as MessageEventSource,
        data: {
          type: 'combo:inspection-state',
          version: 1,
          enabled: true,
          selectedElementKey: null,
        },
      }),
    );
    const heading = dom.window.document.querySelector('h1');
    expect(heading).not.toBeNull();
    heading?.click();

    expect(postMessage).toHaveBeenCalledWith(
      {
        type: 'combo:element-select',
        version: 1,
        element: expect.objectContaining({
          label: 'Agent-VM 任务助手',
          role: 'heading',
          stableKey: false,
          tagName: 'h1',
        }),
      },
      '*',
    );
    expect(heading).toHaveAttribute('data-combo-inspection-key');
    await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
  });

  it('accepts validated element selections and manifests only from the rendered iframe', () => {
    const onElementSelect = vi.fn();
    const onElementManifest = vi.fn();
    render(
      <ArtifactRenderer
        artifact={htmlArtifact()}
        inspectionEnabled
        onElementSelect={onElementSelect}
        onElementManifest={onElementManifest}
      />,
    );
    const frame = screen.getByTitle('每日待办 Miniapp') as HTMLIFrameElement;
    const element = {
      key: 'result-main',
      label: '今日安排结果',
      role: 'region',
      text: '3 项任务已经排好',
      tagName: 'section',
    };

    fireEvent(
      window,
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: { type: 'combo:element-select', version: 1, element },
      }),
    );
    fireEvent(
      window,
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: { type: 'combo:element-manifest', version: 1, elements: [element] },
      }),
    );

    expect(onElementSelect).toHaveBeenCalledWith(element);
    expect(onElementManifest).toHaveBeenCalledWith([element]);

    fireEvent(
      window,
      new MessageEvent('message', {
        source: window,
        data: { type: 'combo:element-select', version: 1, element },
      }),
    );
    fireEvent(
      window,
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: {
          type: 'combo:element-select',
          version: 1,
          element: { ...element, key: '', text: 'x'.repeat(241) },
        },
      }),
    );

    expect(onElementSelect).toHaveBeenCalledTimes(1);
  });

  it('sends inspection state to the iframe when the bridge is ready', () => {
    const onElementSelect = vi.fn();
    const { rerender } = render(
      <ArtifactRenderer
        artifact={htmlArtifact()}
        inspectionEnabled
        selectedElementKey="run-primary"
        onElementSelect={onElementSelect}
      />,
    );
    const frame = screen.getByTitle('每日待办 Miniapp') as HTMLIFrameElement;
    const postMessage = vi.spyOn(frame.contentWindow as Window, 'postMessage');

    fireEvent(
      window,
      new MessageEvent('message', {
        source: frame.contentWindow,
        data: { type: 'combo:inspection-ready', version: 1 },
      }),
    );

    expect(postMessage).toHaveBeenCalledWith(
      {
        type: 'combo:inspection-state',
        version: 1,
        enabled: true,
        selectedElementKey: 'run-primary',
      },
      '*',
    );

    postMessage.mockClear();
    rerender(
      <ArtifactRenderer
        artifact={htmlArtifact()}
        inspectionEnabled={false}
        selectedElementKey={null}
        onElementSelect={onElementSelect}
      />,
    );

    expect(postMessage).toHaveBeenCalledWith(
      {
        type: 'combo:inspection-state',
        version: 1,
        enabled: false,
        selectedElementKey: null,
      },
      '*',
    );
  });
});
