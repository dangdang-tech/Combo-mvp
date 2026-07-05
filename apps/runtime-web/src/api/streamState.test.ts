import { describe, expect, it } from 'vitest';
import { EventType } from '@ag-ui/core';
import type { ArtifactView } from '@cb/shared';
import {
  initialStreamUiState,
  isTerminalEvent,
  parseStreamEvent,
  streamUiReducer,
  type StreamEvent,
  type StreamUiState,
} from './streamState.js';

function replay(events: StreamEvent[], from: StreamUiState = initialStreamUiState): StreamUiState {
  return events.reduce(
    (state, event) => streamUiReducer(state, { kind: 'stream-event', event }),
    from,
  );
}

function artifact(id: string, title = id): ArtifactView {
  return { id, kind: 'markdown', title, updatedAt: '2026-07-04T00:00:00.000Z' };
}

describe('文本事件聚合（打字机）', () => {
  it('START/CONTENT×n 聚合为一段流式文本', () => {
    const state = replay([
      { type: EventType.RUN_STARTED },
      { type: EventType.TEXT_MESSAGE_START },
      { type: EventType.TEXT_MESSAGE_CONTENT, delta: '你好' },
      { type: EventType.TEXT_MESSAGE_CONTENT, delta: '，世界' },
    ]);
    expect(state.running).toBe(true);
    expect(state.streamingText).toBe('你好，世界');
  });

  it('TEXT_MESSAGE_END 保留已聚合文本（等终态才清）', () => {
    const state = replay([
      { type: EventType.TEXT_MESSAGE_START },
      { type: EventType.TEXT_MESSAGE_CONTENT, delta: 'abc' },
      { type: EventType.TEXT_MESSAGE_END },
    ]);
    expect(state.streamingText).toBe('abc');
  });

  it('RUN_FINISHED 清空流式文本并结束运行态（详情为真源）', () => {
    const state = replay([
      { type: EventType.RUN_STARTED },
      { type: EventType.TEXT_MESSAGE_START },
      { type: EventType.TEXT_MESSAGE_CONTENT, delta: 'abc' },
      { type: EventType.RUN_FINISHED },
    ]);
    expect(state).toMatchObject({ running: false, streamingText: null, errorMessage: null });
  });

  it('RUN_ERROR 置人话错误并清空流式文本', () => {
    const state = replay([
      { type: EventType.RUN_STARTED },
      { type: EventType.TEXT_MESSAGE_START },
      { type: EventType.TEXT_MESSAGE_CONTENT, delta: '半截' },
      { type: EventType.RUN_ERROR, message: '本轮生成已打断。' },
    ]);
    expect(state).toMatchObject({
      running: false,
      streamingText: null,
      errorMessage: '本轮生成已打断。',
    });
  });

  it('整段重放已终态的历史轮次后回到静止（无残留文本/错误）', () => {
    const finishedTurn: StreamEvent[] = [
      { type: EventType.RUN_STARTED },
      { type: EventType.TEXT_MESSAGE_START },
      { type: EventType.TEXT_MESSAGE_CONTENT, delta: '第一轮' },
      { type: EventType.TEXT_MESSAGE_END },
      { type: EventType.RUN_FINISHED },
    ];
    const failedTurn: StreamEvent[] = [
      { type: EventType.RUN_STARTED },
      { type: EventType.RUN_ERROR, message: '出错了' },
    ];
    const liveTurn: StreamEvent[] = [
      { type: EventType.RUN_STARTED },
      { type: EventType.TEXT_MESSAGE_START },
      { type: EventType.TEXT_MESSAGE_CONTENT, delta: '进行中' },
    ];
    // 新一轮 RUN_STARTED 清掉上一轮的错误；只有未终态的一轮留下实时文本。
    const state = replay([...finishedTurn, ...failedTurn, ...liveTurn]);
    expect(state).toMatchObject({ running: true, streamingText: '进行中', errorMessage: null });
  });
});

describe('产物 STATE_DELTA 归并', () => {
  it('add /artifacts/<id> 上新产物并按 /activeArtifactId 切活跃', () => {
    const a1 = artifact('a1', '评分卡');
    const state = replay([
      {
        type: EventType.STATE_DELTA,
        delta: [
          { op: 'add', path: '/artifacts/a1', value: a1 },
          { op: 'add', path: '/activeArtifactId', value: 'a1' },
        ],
      },
    ]);
    expect(state.artifacts).toEqual({ a1 });
    expect(state.activeArtifactId).toBe('a1');
  });

  it('同 id 重复 add 即替换（原地更新产物）', () => {
    const v1 = artifact('a1', '初稿');
    const v2 = { ...artifact('a1', '终稿'), updatedAt: '2026-07-04T01:00:00.000Z' };
    const state = replay([
      { type: EventType.STATE_DELTA, delta: [{ op: 'add', path: '/artifacts/a1', value: v1 }] },
      { type: EventType.STATE_DELTA, delta: [{ op: 'add', path: '/artifacts/a1', value: v2 }] },
    ]);
    expect(Object.keys(state.artifacts)).toEqual(['a1']);
    expect(state.artifacts['a1']!.title).toBe('终稿');
  });

  it('非法 delta（非数组 / 未知 path / 非对象成员）安全忽略', () => {
    const state = replay([
      { type: EventType.STATE_DELTA, delta: 'oops' },
      { type: EventType.STATE_DELTA, delta: [null, { op: 'remove', path: '/artifacts/a1' }] },
      { type: EventType.STATE_DELTA, delta: [{ op: 'add', path: '/other', value: 1 }] },
    ]);
    expect(state).toEqual(initialStreamUiState);
  });

  it('seed-artifacts：详情真源覆盖同 id，保留流上新到的产物，补默认活跃', () => {
    const fromStream = artifact('a2', '流上刚生成');
    let state = replay([
      {
        type: EventType.STATE_DELTA,
        delta: [{ op: 'add', path: '/artifacts/a2', value: fromStream }],
      },
    ]);
    state = streamUiReducer(state, {
      kind: 'seed-artifacts',
      artifacts: [artifact('a1', '已落库')],
    });
    expect(Object.keys(state.artifacts).sort()).toEqual(['a1', 'a2']);
    expect(state.activeArtifactId).toBe('a1'); // 之前无活跃 → 取详情最后一个

    // 已有活跃选择时 seed 不抢
    const kept = streamUiReducer(
      { ...state, activeArtifactId: 'a2' },
      { kind: 'seed-artifacts', artifacts: [artifact('a1')] },
    );
    expect(kept.activeArtifactId).toBe('a2');
  });
});

describe('帧解析与终态判定', () => {
  it('parseStreamEvent：合法 JSON 事件解析成功，坏帧返回 null', () => {
    expect(parseStreamEvent('{"type":"RUN_STARTED","extra":"忽略透传字段"}')).toMatchObject({
      type: 'RUN_STARTED',
    });
    expect(parseStreamEvent('not-json')).toBeNull();
    expect(parseStreamEvent('123')).toBeNull();
    expect(parseStreamEvent('{"noType":true}')).toBeNull();
  });

  it('isTerminalEvent 只认 RUN_FINISHED / RUN_ERROR', () => {
    expect(isTerminalEvent({ type: EventType.RUN_FINISHED })).toBe(true);
    expect(isTerminalEvent({ type: EventType.RUN_ERROR })).toBe(true);
    expect(isTerminalEvent({ type: EventType.TEXT_MESSAGE_END })).toBe(false);
  });
});
