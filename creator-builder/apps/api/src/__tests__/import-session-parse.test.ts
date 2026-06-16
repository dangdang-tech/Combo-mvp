// B-18 · 会话解析单测（纯函数，无 PG/网络）。
//   覆盖：Claude/Codex 两种真实格式样例、空/坏数据容错、统计正确（段数/消息数/时间跨度/项目数）、
//         content_hash 稳定、快照内去重、混合格式、排序、标题/日期/项目派生。
import { describe, it, expect } from 'vitest';
import {
  parseSessions,
  computeContentHash,
  type RawSessionInput,
} from '../import/session-parse.js';

// ---------------------------------------------------------------------------
// 真实格式样例工厂（贴合 ~/.claude/projects 与 ~/.codex/sessions 实测形态）
// ---------------------------------------------------------------------------

/** Claude jsonl：一行一对象，{type, message:{role, content}, timestamp, cwd, ...}。 */
function claudeJsonl(opts?: {
  cwd?: string;
  userText?: string;
  assistantText?: string;
  ts1?: string;
  ts2?: string;
}): string {
  const cwd = opts?.cwd ?? '/Users/dev/repos/my-project';
  const ts1 = opts?.ts1 ?? '2026-03-20T10:00:00.000Z';
  const ts2 = opts?.ts2 ?? '2026-03-20T10:01:30.000Z';
  const userText = opts?.userText ?? '帮我重构这个解析器';
  const assistantText = opts?.assistantText ?? '好的，我们先看现有结构。';
  return [
    JSON.stringify({
      type: 'user',
      cwd,
      gitBranch: 'main',
      sessionId: 'sess-abc',
      uuid: 'u1',
      parentUuid: null,
      timestamp: ts1,
      version: '1.0.0',
      message: { role: 'user', content: userText },
    }),
    JSON.stringify({
      type: 'assistant',
      cwd,
      sessionId: 'sess-abc',
      uuid: 'a1',
      parentUuid: 'u1',
      timestamp: ts2,
      message: {
        id: 'msg_1',
        role: 'assistant',
        model: 'claude-opus',
        content: [{ type: 'text', text: assistantText }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    }),
  ].join('\n');
}

/** Codex jsonl：{type, payload, timestamp}；session_meta + event_msg + response_item 混排。 */
function codexJsonl(opts?: {
  cwd?: string;
  userText?: string;
  assistantText?: string;
  ts?: string;
}): string {
  const cwd = opts?.cwd ?? '/Users/dev/repos/codex-proj';
  const ts = opts?.ts ?? '2026-05-02T08:30:00.000Z';
  const userText = opts?.userText ?? '修一下这个 bug';
  const assistantText = opts?.assistantText ?? '我来定位问题根因。';
  return [
    JSON.stringify({
      type: 'session_meta',
      timestamp: ts,
      payload: { id: 'thread-1', cwd, cli_version: '0.1', model_provider: 'openai' },
    }),
    JSON.stringify({
      type: 'turn_context',
      timestamp: ts,
      payload: { cwd, model: 'gpt', turn_id: 't1', current_date: '2026-05-02' },
    }),
    // event_msg.user_message 与 response_item.message 同 turn 双写 → 去重
    JSON.stringify({
      type: 'event_msg',
      timestamp: ts,
      payload: { type: 'user_message', message: userText, images: [], text_elements: [] },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: ts,
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: userText }],
      },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: ts,
      payload: { type: 'reasoning', summary: [], encrypted_content: 'xxx' },
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: ts,
      payload: { type: 'agent_message', message: assistantText, phase: 'final' },
    }),
    JSON.stringify({
      type: 'event_msg',
      timestamp: ts,
      payload: { type: 'token_count', info: {}, rate_limits: {} },
    }),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Claude 真实格式
// ---------------------------------------------------------------------------
describe('Claude 格式解析', () => {
  it('解析 user + assistant，content 既支持 string 又支持 text 块', () => {
    const r = parseSessions([{ source: 'claude', raw: claudeJsonl(), sessionRef: 'c1' }]);
    expect(r.segments).toHaveLength(1);
    const seg = r.segments[0]!;
    expect(seg.source).toBe('claude');
    expect(seg.messageCount).toBe(2);
    expect(seg.content).toContain('user: 帮我重构这个解析器');
    expect(seg.content).toContain('assistant: 好的，我们先看现有结构。');
    expect(seg.project).toBe('my-project'); // cwd 末段
    expect(seg.title).toBe('帮我重构这个解析器'); // 首条 user 首行
    expect(seg.happenedAt).toBe('2026-03-20T10:00:00.000Z'); // 最早消息时刻
    expect(seg.dateLabel).toBe('03-20');
  });

  it('title 取首条 user 首行并截断到 80 字符', () => {
    const long = 'A'.repeat(200);
    const r = parseSessions([{ source: 'claude', raw: claudeJsonl({ userText: long }) }]);
    const t = r.segments[0]!.title;
    expect(t.length).toBeLessThanOrEqual(80);
    expect(t.endsWith('…')).toBe(true);
  });

  it('非文本块（tool_use/image）保留消息存在性并占位，不丢条数', () => {
    const line = JSON.stringify({
      type: 'assistant',
      cwd: '/x/proj',
      timestamp: '2026-03-21T00:00:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '调用工具' },
          { type: 'tool_use', id: 'tu1', name: 'bash', input: {} },
        ],
      },
    });
    const r = parseSessions([{ source: 'claude', raw: line }]);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.content).toContain('[tool_use]');
    expect(r.segments[0]!.messageCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Codex 真实格式
// ---------------------------------------------------------------------------
describe('Codex 格式解析', () => {
  it('解析 event_msg/response_item，并对同 turn 双写去重', () => {
    const r = parseSessions([{ source: 'codex', raw: codexJsonl(), sessionRef: 'x1' }]);
    expect(r.segments).toHaveLength(1);
    const seg = r.segments[0]!;
    expect(seg.source).toBe('codex');
    // user_message 与 response_item.message 是同一条 → 去重后 user 只算一次 + assistant 一条 = 2
    expect(seg.messageCount).toBe(2);
    expect(seg.content).toContain('user: 修一下这个 bug');
    expect(seg.content).toContain('assistant: 我来定位问题根因。');
    expect(seg.project).toBe('codex-proj'); // session_meta.cwd 末段
  });

  it('reasoning/function_call/token_count 等非消息行不计条数、不算坏行', () => {
    const r = parseSessions([{ source: 'codex', raw: codexJsonl() }]);
    expect(r.stats.badLineCount).toBe(0);
    expect(r.segments[0]!.messageCount).toBe(2);
  });

  it('Codex content 块 output_text/input_text 都抽取', () => {
    const lines = [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-05-01T00:00:00Z',
        payload: { cwd: '/a/b/proj' },
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-05-01T00:00:01Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '答复内容' }],
        },
      }),
    ].join('\n');
    const r = parseSessions([{ source: 'codex', raw: lines }]);
    expect(r.segments[0]!.content).toContain('assistant: 答复内容');
  });
});

// ---------------------------------------------------------------------------
// 容错：空 / 坏数据 / 半结构 / 混合
// ---------------------------------------------------------------------------
describe('容错', () => {
  it('空会话（空字符串）→ 跳过、计 no_parseable_lines，不崩', () => {
    const r = parseSessions([{ source: 'claude', raw: '', sessionRef: 'empty' }]);
    expect(r.segments).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.reason).toBe('no_parseable_lines');
  });

  it('坏 JSON 行被跳过并计 badLineCount，好行照常解析', () => {
    const raw = ['{ this is not json', claudeJsonl().split('\n')[0]!, 'also bad }}}'].join('\n');
    const r = parseSessions([{ source: 'claude', raw, sessionRef: 'mixed-bad' }]);
    expect(r.segments).toHaveLength(1); // 一条好 user 行成段
    expect(r.stats.badLineCount).toBe(2);
  });

  it('整会话全是坏 JSON 行（无任何可解析）→ no_parseable_lines，badLineCount 计全部', () => {
    const r = parseSessions([{ source: 'codex', raw: 'garbage\n{bad', sessionRef: 'g' }]);
    expect(r.segments).toHaveLength(0);
    expect(r.skipped[0]!.reason).toBe('no_parseable_lines');
    expect(r.skipped[0]!.badLineCount).toBe(2);
    expect(r.stats.badLineCount).toBe(2);
  });

  it('行能 parse 但结构完全不认识（合法 JSON、无消息形态）→ unknown_format', () => {
    // 合法 JSON 但既不是 message 也不是已知 payload 形态：tryParseLine 成功(sawAnyJson)
    // 但结构不被任何分支接住，且无可识别消息行 → unknown_format。
    const weird = [
      JSON.stringify({ foo: 'bar', nested: { a: 1 } }),
      JSON.stringify(['not', 'an', 'object']),
    ].join('\n');
    const r = parseSessions([{ source: 'claude', raw: weird, sessionRef: 'w' }]);
    expect(r.segments).toHaveLength(0);
    expect(r.skipped[0]!.reason).toBe('unknown_format');
  });

  it('有可解析行但无任何消息（只有 meta）→ no_messages', () => {
    const onlyMeta = JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-05-01T00:00:00Z',
      payload: { cwd: '/a/proj' },
    });
    const r = parseSessions([{ source: 'codex', raw: onlyMeta }]);
    expect(r.segments).toHaveLength(0);
    expect(r.skipped[0]!.reason).toBe('no_messages');
  });

  it('缺 timestamp / 缺 cwd 不崩：happenedAt=null、dateLabel=空、project=undefined', () => {
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: '无元信息' } });
    const r = parseSessions([{ source: 'claude', raw: line }]);
    const seg = r.segments[0]!;
    expect(seg.happenedAt).toBeNull();
    expect(seg.dateLabel).toBe('');
    expect(seg.project).toBeUndefined();
  });

  it('raw 支持 string[] 行数组（半结构容错）', () => {
    const arr = claudeJsonl().split('\n');
    const r = parseSessions([{ source: 'claude', raw: arr }]);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.messageCount).toBe(2);
  });

  it('一坏会话不影响同批其它会话', () => {
    const r = parseSessions([
      { source: 'claude', raw: 'totally broken', sessionRef: 'bad' },
      { source: 'claude', raw: claudeJsonl(), sessionRef: 'good' },
    ]);
    expect(r.segments).toHaveLength(1);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.sessionRef).toBe('bad');
  });

  it('空批 → 空结果、统计全零、timeSpan=null（Job 据此出 IMPORT_NO_CONTENT）', () => {
    const r = parseSessions([]);
    expect(r.segments).toHaveLength(0);
    expect(r.stats.segmentCount).toBe(0);
    expect(r.stats.messageCount).toBe(0);
    expect(r.stats.projectCount).toBe(0);
    expect(r.stats.timeSpan).toBeNull();
    expect(r.stats.sources).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 统计正确性（段数 / 消息数 / 时间跨度 / 项目数 / sources）
// ---------------------------------------------------------------------------
describe('统计', () => {
  it('多会话多来源统计四格 + sources 正确', () => {
    const inputs: RawSessionInput[] = [
      {
        source: 'claude',
        raw: claudeJsonl({
          cwd: '/r/proj-a',
          ts1: '2026-03-01T00:00:00Z',
          ts2: '2026-03-01T00:05:00Z',
          userText: 'A问',
        }),
      },
      {
        source: 'claude',
        raw: claudeJsonl({
          cwd: '/r/proj-b',
          ts1: '2026-04-15T00:00:00Z',
          ts2: '2026-04-15T00:05:00Z',
          userText: 'B问',
        }),
      },
      {
        source: 'codex',
        raw: codexJsonl({ cwd: '/r/proj-a', ts: '2026-06-10T00:00:00Z', userText: 'C问' }),
      },
    ];
    const r = parseSessions(inputs);
    expect(r.stats.segmentCount).toBe(3);
    expect(r.stats.messageCount).toBe(2 + 2 + 2); // 每会话 2 条
    expect(r.stats.projectCount).toBe(2); // proj-a / proj-b（proj-a 出现两次去重）
    expect(r.stats.timeSpan).toEqual({
      from: '2026-03-01T00:00:00.000Z',
      to: '2026-06-10T00:00:00.000Z',
    });
    expect(r.stats.sources.sort()).toEqual(['claude', 'codex']);
  });

  it('时间跨度忽略 null happenedAt 的会话', () => {
    const withTime = claudeJsonl({ ts1: '2026-03-10T00:00:00Z', ts2: '2026-03-10T00:01:00Z' });
    const noTime = JSON.stringify({ type: 'user', message: { role: 'user', content: '无时间' } });
    const r = parseSessions([
      { source: 'claude', raw: withTime },
      { source: 'claude', raw: noTime },
    ]);
    expect(r.stats.segmentCount).toBe(2);
    expect(r.stats.timeSpan).toEqual({
      from: '2026-03-10T00:00:00.000Z',
      to: '2026-03-10T00:00:00.000Z',
    });
  });

  it('段按 happened_at 降序排列，null 时间排末尾', () => {
    const early = claudeJsonl({
      ts1: '2026-01-01T00:00:00Z',
      ts2: '2026-01-01T00:01:00Z',
      userText: '最早',
    });
    const late = claudeJsonl({
      ts1: '2026-09-01T00:00:00Z',
      ts2: '2026-09-01T00:01:00Z',
      userText: '最晚',
    });
    const noTime = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '没有时间的会话' },
    });
    const r = parseSessions([
      { source: 'claude', raw: early },
      { source: 'claude', raw: noTime },
      { source: 'claude', raw: late },
    ]);
    expect(r.segments[0]!.title).toBe('最晚');
    expect(r.segments[1]!.title).toBe('最早');
    expect(r.segments[2]!.happenedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// content_hash 稳定 + 快照内去重
// ---------------------------------------------------------------------------
describe('content_hash 与去重', () => {
  it('computeContentHash 稳定：同输入同 hash、跨次运行一致', () => {
    const h1 = computeContentHash('user: 你好\n\nassistant: 在的');
    const h2 = computeContentHash('user: 你好\n\nassistant: 在的');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  it('hash 对 CRLF / 首尾空白规范化（无意义差异不炸去重）', () => {
    expect(computeContentHash('a\r\nb')).toBe(computeContentHash('a\nb'));
    expect(computeContentHash('  hello  ')).toBe(computeContentHash('hello'));
  });

  it('内容不同 → hash 不同', () => {
    expect(computeContentHash('foo')).not.toBe(computeContentHash('bar'));
  });

  it('同一段的 contentHash 与对其 content 直接算的 hash 一致（Job 写库去重键可复算）', () => {
    const r = parseSessions([{ source: 'claude', raw: claudeJsonl() }]);
    const seg = r.segments[0]!;
    expect(seg.contentHash).toBe(computeContentHash(seg.content));
  });

  it('快照内去重：两会话内容相同 → 只留一段、duplicateSegmentCount=1、统计不算重', () => {
    const same = claudeJsonl({ userText: '完全一样', assistantText: '一样的回复' });
    const r = parseSessions([
      { source: 'claude', raw: same, sessionRef: 's1' },
      { source: 'claude', raw: same, sessionRef: 's2' },
    ]);
    expect(r.segments).toHaveLength(1);
    expect(r.stats.segmentCount).toBe(1);
    expect(r.stats.duplicateSegmentCount).toBe(1);
    expect(r.stats.messageCount).toBe(2); // 不重复计
  });

  it('内容相异（哪怕只差一字）→ 不去重，保留两段', () => {
    const a = claudeJsonl({ userText: '问题 A' });
    const b = claudeJsonl({ userText: '问题 B' });
    const r = parseSessions([
      { source: 'claude', raw: a },
      { source: 'claude', raw: b },
    ]);
    expect(r.segments).toHaveLength(2);
    expect(r.stats.duplicateSegmentCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 混合格式整批（Codex + Claude 同批，导入-27 两来源口径前置）
// ---------------------------------------------------------------------------
describe('混合格式整批', () => {
  it('Claude + Codex 同批解析，段保持各自来源标记', () => {
    const r = parseSessions([
      { source: 'claude', raw: claudeJsonl(), sessionRef: 'cl' },
      { source: 'codex', raw: codexJsonl(), sessionRef: 'cx' },
    ]);
    expect(r.segments).toHaveLength(2);
    const sources = r.segments.map((s) => s.source).sort();
    expect(sources).toEqual(['claude', 'codex']);
    expect(r.stats.sources.sort()).toEqual(['claude', 'codex']);
  });
});
