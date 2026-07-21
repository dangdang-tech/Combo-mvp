import type { Pool } from 'pg';
import type { ArtifactRef } from '@cb/shared';
import { describe, expect, it, vi } from 'vitest';
import { createArtifactTool } from './artifact-tool.js';

describe('createArtifactTool validation', () => {
  it('rejects invalid content before opening a database connection or emitting a version', async () => {
    const connect = vi.fn();
    const onArtifact = vi.fn();
    const collected: ArtifactRef[] = [];
    const tool = createArtifactTool({
      pool: { connect } as unknown as Pool,
      sessionId: 'session-1',
      collected,
      validateArtifact: () => '页面不是完整 HTML',
      onArtifact,
    });

    await expect(
      tool.execute('tool-call-1', {
        artifactKey: 'main',
        kind: 'html',
        title: 'Miniapp',
        content: '<div>只有片段</div>',
      }),
    ).rejects.toThrow('页面不是完整 HTML');

    expect(connect).not.toHaveBeenCalled();
    expect(onArtifact).not.toHaveBeenCalled();
    expect(collected).toHaveLength(0);
  });
});
