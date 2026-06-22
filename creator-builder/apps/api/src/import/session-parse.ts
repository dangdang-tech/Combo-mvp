// B-18 · 会话解析（纯函数模块，20-step1-import §4.2 `segment` 子任务 / §6.2 session_segments）。
//
// 职责：把 Claude / Codex 对话历史的原始 JSONL 解析为标准「段（segment）」。
//   层级：会话(session=一个 jsonl 文件/会话流) → 消息(message) → 段(segment)。
//   本期一段 = 一会话（一个会话流切成一段；后续若需更细切分在此扩展，接口不变）。
//   计算：content_hash（快照内去重键，§6.2）、happened_at（热力图 / 节选 order）、
//         title / message_count / date_label / project，以及整批统计（段数 / 消息数 / 时间跨度 / 项目数）。
//
// 唯一真源约束（20 §9 B-18）：Claude 与 Codex 的「原始格式 → 段」口径只此一处实现。
//
// 纯函数：不依赖 PG / Redis / 网络 / 对象存储。仅用 node:crypto 算 hash。
//   - 容错：半结构 / 缺字段 / 混合格式不崩；坏会话 / 坏行跳过并计入报告（不污染统计）。
//   - 去敏边界：本模块只解析与切段，**不做去敏**。导入 Job（B-19）先跑去敏（B-17）再调本模块，
//     传入的文本即「去敏后正文」，故 content_hash 天然是 hash(去敏后内容)（§6.2 口径）。
//     调用方亦可对已去敏的会话调用；本模块对内容不作隐私假设、只忠实切段并 hash。
import { createHash } from 'node:crypto';
import type { ImportSource } from '@cb/shared';

// ---------------------------------------------------------------------------
// 输出类型（解析产物 → 导入 Job 据此写 session_segments / 推 SSE 落库卡）
// ---------------------------------------------------------------------------

/** 解析出的标准消息（段内消息；happened_at 取自原始 timestamp）。 */
export interface ParsedMessage {
  /** 'user' | 'assistant' | 'system' | 'tool'：归一后的角色（细分映射见 normalizeRole）。 */
  role: ParsedRole;
  /** 纯文本正文（content 块拼接 / 字符串原样；非文本块按占位拼接）。 */
  text: string;
  /** 消息发生时刻 ISO（可空：原始缺/坏时间）。 */
  happenedAt: string | null;
}

export type ParsedRole = 'user' | 'assistant' | 'system' | 'tool';

/**
 * 解析出的标准段（= session_segments 一行的纯数据形态，§6.2）。
 * id / snapshot_id 由 DB 在写入时生成，本纯模块不产出（见文末「给导入 Job 的接口」）。
 */
export interface ParsedSegment {
  /** 来源（claude|codex；mixed 是批级聚合口径，段级恒为单一来源）。 */
  source: Exclude<ImportSource, 'mixed'>;
  /** 快照内去重键：sha256(去敏后正文规范化) hex（§6.2，稳定、跨进程可复算）。 */
  contentHash: string;
  /** 去敏后标题（首条 user 文本首行截断；空则回退占位）。 */
  title: string;
  /** 展示日期，如 '03-20'（取 happened_at 的本地无关 MM-DD；空则 ''）。 */
  dateLabel: string;
  /** 会话发生时刻 ISO（段级取首条有效消息时间；空则 null）。 */
  happenedAt: string | null;
  /** 项目（Claude=cwd 末段 / Codex=cwd 末段；空则 undefined）。 */
  project?: string;
  /** 段内消息条数（仅计入有正文的消息，§6.2 message_count）。 */
  messageCount: number;
  /** 去敏后段正文（消息按 `role: text` 拼接，§6.2 content）。 */
  content: string;
}

/** 单条会话原料（一个 jsonl 文件 / 会话流）。 */
export interface RawSessionInput {
  /** 会话来源（一个文件只属一来源）。 */
  source: Exclude<ImportSource, 'mixed'>;
  /** 原始内容：整块 jsonl 文本，或已分好的行数组（半结构容错：两者皆可）。 */
  raw: string | string[];
  /** 可选：会话标识（文件名 / sessionId），仅用于报告定位坏会话，不入段。 */
  sessionRef?: string;
}

/** 单会话被跳过的原因（计入报告，不崩）。 */
export type SkipReason =
  | 'no_parseable_lines' // 整会话无任何可解析行
  | 'no_messages' // 解析到行但无有效消息
  | 'empty_content' // 拼接后正文为空
  | 'unknown_format'; // 行结构完全不认识

export interface SkippedSession {
  sessionRef: string | undefined;
  source: Exclude<ImportSource, 'mixed'>;
  reason: SkipReason;
  /** 该会话内被跳过的坏行数（JSON 解析失败 / 结构不认识）。 */
  badLineCount: number;
}

/** 整批解析统计（→ raw_snapshots 统计四格 / SSE done，§6.1 / 5.1）。 */
export interface ParseStats {
  /** 段数（去重后；= 写入 session_segments 的行数，§6.2 segment_count）。 */
  segmentCount: number;
  /** 消息总条数（所有保留段的 messageCount 之和，§6.1 message_count）。 */
  messageCount: number;
  /** 涉及项目数（去重后非空 project 个数，§6.1 project_count）。 */
  projectCount: number;
  /** 时间跨度（最早/最晚 happened_at；全空则 null，§5.1 timeSpan）。 */
  timeSpan: { from: string; to: string } | null;
  /** 命中的来源集合（'claude'/'codex'；§5.1 sources，缺一引导补导）。 */
  sources: Array<Exclude<ImportSource, 'mixed'>>;
  /** 坏行总数（跨所有会话，含坏会话内的坏行）。 */
  badLineCount: number;
  /** 因去重被丢弃的段数（统计不算重，§6.2 导入-22）。 */
  duplicateSegmentCount: number;
}

/** 解析最终产物。 */
export interface ParseResult {
  /** 去重后、按 happened_at 降序的段（节选默认 order desc，§5.2）。 */
  segments: ParsedSegment[];
  /** 被跳过的坏 / 空会话（容错报告，不崩）。 */
  skipped: SkippedSession[];
  stats: ParseStats;
}

// ---------------------------------------------------------------------------
// 常量 / 工具
// ---------------------------------------------------------------------------

const TITLE_MAX = 80;
const EMPTY_TITLE = '(无标题会话)';

/** 规范化内容用于 hash：统一换行 + 去首尾空白（避免无意义差异炸去重，§6.2 稳定 hash）。 */
function canonicalizeForHash(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

/** content_hash：sha256(规范化正文) hex。跨进程 / 跨次运行稳定（去重键，§6.2）。 */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(canonicalizeForHash(content), 'utf8').digest('hex');
}

/** 角色归一：把各家细分角色收敛到四类（developer/system→system；tool 输出→tool）。 */
function normalizeRole(raw: unknown): ParsedRole {
  const r = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (r === 'assistant') return 'assistant';
  if (r === 'user') return 'user';
  if (r === 'tool' || r === 'function' || r === 'tool_result' || r === 'function_call_output')
    return 'tool';
  // developer / system / 其它 → system（不丢，但归到系统侧）
  return 'system';
}

/** 时间归一：宽松解析为 ISO；不可解析 → null（不崩）。 */
function normalizeTimestamp(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // 兼容秒级 / 毫秒级 epoch（codex 历史曾用秒）。
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof raw === 'string' && raw.length > 0) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/** ISO → 'MM-DD' 展示日期（用 UTC 取，避免跑测机时区漂移）。 */
function toDateLabel(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mm}-${dd}`;
}

/** cwd / path → 项目名（取末段目录名；空 / 根 → undefined）。 */
function projectFromCwd(cwd: unknown): string | undefined {
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined;
  const parts = cwd.split(/[\\/]+/).filter((p) => p.length > 0);
  const last = parts[parts.length - 1];
  return last && last.length > 0 ? last : undefined;
}

/** 安全 JSON.parse：失败返回 undefined（坏行不崩，调用方计 badLine）。 */
function tryParseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** raw（string | string[]）→ 非空行数组（容错：CRLF / 空行 / 多余空白）。 */
function toLines(raw: string | string[]): string[] {
  const arr = Array.isArray(raw) ? raw : raw.split(/\r?\n/);
  return arr.map((l) => (typeof l === 'string' ? l.trim() : '')).filter((l) => l.length > 0);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// 内容块 → 文本（两家都可能用 content 块数组 / 纯字符串 / 嵌套）
// ---------------------------------------------------------------------------

/** 把一条消息的 content（string | block[] | 其它）抽成纯文本。非文本块按占位标注、不丢消息存在性。 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
        continue;
      }
      if (!isRecord(block)) continue;
      // Claude: {type:'text', text}; Codex: {type:'input_text'|'output_text'|'text', text}
      const t = block['text'];
      if (typeof t === 'string') {
        parts.push(t);
        continue;
      }
      // 嵌套 content（少见的 tool_result 结构）。
      if ('content' in block) {
        const nested = extractText(block['content']);
        if (nested) parts.push(nested);
        continue;
      }
      // 非文本块（image / tool_use / thinking 等）：标占位，保留「这条消息有内容」。
      const bt = typeof block['type'] === 'string' ? (block['type'] as string) : 'block';
      parts.push(`[${bt}]`);
    }
    return parts.join('\n').trim();
  }
  if (isRecord(content) && typeof content['text'] === 'string') return content['text'];
  return '';
}

// ---------------------------------------------------------------------------
// Claude 解析（~/.claude/projects/<enc-cwd>/<sessionId>.jsonl）
//   一行一对象：{ type, message:{ role, content }, timestamp, cwd, gitBranch, sessionId, ... }
//   类型含 user / assistant / attachment / summary / system 等；只取带 message.role 的会话消息。
// ---------------------------------------------------------------------------

interface SessionAccum {
  messages: ParsedMessage[];
  project: string | undefined;
  /** JSON.parse 失败的行数（坏行，§容错）。 */
  badLineCount: number;
  /** 是否至少有一行成功 JSON.parse（不论结构）。 */
  sawAnyJson: boolean;
  /** 是否至少有一行是「本解析器认识的结构」（Claude=带 message 的记录 / Codex=带 payload 的记录）。
   *  用于区分 no_messages（认识结构但无正文）与 unknown_format（行可解析但结构完全不认识）。 */
  sawRecognizableStructure: boolean;
}

function newAccum(): SessionAccum {
  return {
    messages: [],
    project: undefined,
    badLineCount: 0,
    sawAnyJson: false,
    sawRecognizableStructure: false,
  };
}

function parseClaudeLines(lines: string[]): SessionAccum {
  const acc = newAccum();
  for (const line of lines) {
    const obj = tryParseLine(line);
    if (obj === undefined) {
      acc.badLineCount++; // JSON.parse 失败
      continue;
    }
    acc.sawAnyJson = true;
    if (!isRecord(obj)) continue; // 合法 JSON 但非对象（数组/标量）：结构不认识，不算坏行。
    // 项目：任一行的 cwd 都可作项目来源（取首个非空）。
    if (acc.project === undefined) acc.project = projectFromCwd(obj['cwd']);
    const msg = obj['message'];
    if (!isRecord(msg)) continue; // 非消息行（summary/attachment 元信息等）跳过、不算坏。
    acc.sawRecognizableStructure = true; // 认识：带 message 的记录。
    const text = extractText(msg['content']);
    if (!text) continue; // 空内容消息（纯 tool_use 等）不计条数。
    acc.messages.push({
      role: normalizeRole(msg['role'] ?? obj['type']),
      text,
      happenedAt: normalizeTimestamp(obj['timestamp']),
    });
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Codex 解析（~/.codex/sessions/YYYY/.../*.jsonl）
//   一行一对象：{ type, payload, timestamp }
//   type: session_meta | turn_context | event_msg | response_item
//   消息真源优先取 response_item.payload(type=message){role,content[]}（结构化、稳定）；
//   缺失时回退 event_msg(user_message/agent_message){message|text}。
//   去重：同一 turn 的 event_msg 与 response_item 可能重复 → 按 (role, 规范化文本) 去重。
//   项目：session_meta.payload.cwd / turn_context.payload.cwd。
// ---------------------------------------------------------------------------

function parseCodexLines(lines: string[]): SessionAccum {
  const acc = newAccum();
  const seen = new Set<string>(); // (role|hash(text)) 去重 event_msg/response_item 双写
  for (const line of lines) {
    const obj = tryParseLine(line);
    if (obj === undefined) {
      acc.badLineCount++; // JSON.parse 失败
      continue;
    }
    acc.sawAnyJson = true;
    if (!isRecord(obj)) continue; // 合法 JSON 但非对象：结构不认识，不算坏行。
    const topType = obj['type'];
    const payload = obj['payload'];
    if (!isRecord(payload)) continue; // 无 payload 行跳过（不算坏，半结构容错）。
    acc.sawRecognizableStructure = true; // 认识：带 payload 的记录。
    const pType = typeof payload['type'] === 'string' ? (payload['type'] as string) : undefined;

    // 项目：session_meta / turn_context 的 cwd。
    if (acc.project === undefined && (topType === 'session_meta' || topType === 'turn_context')) {
      acc.project = projectFromCwd(payload['cwd']);
    }

    let role: unknown;
    let text = '';
    if (topType === 'response_item' && pType === 'message') {
      role = payload['role'];
      text = extractText(payload['content']);
    } else if (topType === 'event_msg' && pType === 'user_message') {
      role = 'user';
      text = extractText(payload['message'] ?? payload['text']);
    } else if (topType === 'event_msg' && pType === 'agent_message') {
      role = 'assistant';
      text = extractText(payload['message'] ?? payload['text']);
    } else {
      continue; // reasoning / function_call / token_count / task_* 等非消息：不计、不算坏。
    }
    if (!text) continue;
    const normRole = normalizeRole(role);
    const dedupKey = `${normRole}|${computeContentHash(text)}`;
    if (seen.has(dedupKey)) continue; // 同 turn 双写去重（event_msg ↔ response_item）。
    seen.add(dedupKey);
    acc.messages.push({
      role: normRole,
      text,
      happenedAt: normalizeTimestamp(obj['timestamp']),
    });
  }
  return acc;
}

// ---------------------------------------------------------------------------
// 来源嗅探（按内容判 claude|codex）—— S3 key 常不含来源标记时的可靠定夺
//   浏览器选 `.codex/sessions/2026/06/01` 这类子目录时，webkitRelativePath 根是 `01/`，
//   丢了 `.codex` 前缀；助手路径 key 形如 `raw/{owner}/{pairId}/part-N` 本就无标记。
//   此时按路径子串猜来源会误判（默认落到 claude），把 Codex 原文（顶层 payload）喂给
//   Claude 解析器（认顶层 message）→ 全行跳过 → 零段 → 误报 IMPORT_NO_CONTENT。
//   故按真实结构嗅探，与下面两个解析器的结构判定同源、绝不分歧。
// ---------------------------------------------------------------------------

/**
 * 按内容嗅探单会话来源（claude|codex）。判据与 parseClaudeLines/parseCodexLines 完全一致：
 *   - Codex 行：顶层带对象型 `payload`（{type, payload, timestamp}）。
 *   - Claude 行：顶层带对象型 `message`（{type, message:{role,content}, ...}）。
 *   两家结构互斥（Claude 无顶层 payload、Codex 无顶层 message），故嗅探与解析器不会打架。
 *   扫可解析行投票，多者胜；都不命中（空 / 坏 / 未知结构）回退 hint，hint 缺省 'claude'。
 */
export function detectSessionSource(
  raw: string | string[],
  hint?: Exclude<ImportSource, 'mixed'>,
): Exclude<ImportSource, 'mixed'> {
  const lines = toLines(raw);
  let claudeHits = 0;
  let codexHits = 0;
  for (const line of lines) {
    const obj = tryParseLine(line);
    if (!isRecord(obj)) continue;
    if (isRecord(obj['payload'])) codexHits++;
    else if (isRecord(obj['message'])) claudeHits++;
    if (claudeHits + codexHits >= 64) break; // 早停：足够区分即可，不必全扫大文件。
  }
  if (codexHits > claudeHits) return 'codex';
  if (claudeHits > codexHits) return 'claude';
  return hint ?? 'claude';
}

// ---------------------------------------------------------------------------
// 单会话 → 段（或跳过原因）
// ---------------------------------------------------------------------------

/** 段标题：首条 user 文本首行（截断）；无 user 则首条任意消息；空则占位。 */
function deriveTitle(messages: ParsedMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user' && m.text.trim().length > 0);
  const pick = firstUser ?? messages.find((m) => m.text.trim().length > 0);
  if (!pick) return EMPTY_TITLE;
  const firstLine = pick.text.split('\n')[0]?.trim() ?? '';
  if (!firstLine) return EMPTY_TITLE;
  return firstLine.length > TITLE_MAX ? `${firstLine.slice(0, TITLE_MAX - 1)}…` : firstLine;
}

/** 段正文：消息按 `role: text` 拼接（content_hash 的输入，§6.2）。 */
function buildSegmentContent(messages: ParsedMessage[]): string {
  return messages.map((m) => `${m.role}: ${m.text}`.trim()).join('\n\n');
}

/** 段时刻：首条有 happenedAt 的消息（升序后取最早；无则 null）。 */
function deriveHappenedAt(messages: ParsedMessage[]): string | null {
  const times = messages
    .map((m) => m.happenedAt)
    .filter((t): t is string => typeof t === 'string')
    .sort();
  return times[0] ?? null;
}

type SegmentOrSkip =
  | { ok: true; segment: ParsedSegment; messageBadLines: number }
  | { ok: false; reason: SkipReason; badLineCount: number };

function sessionToSegment(input: RawSessionInput): SegmentOrSkip {
  const lines = toLines(input.raw);
  const acc = input.source === 'claude' ? parseClaudeLines(lines) : parseCodexLines(lines);

  if (!acc.sawAnyJson) {
    // 无一行能 JSON.parse（整会话坏 / 空）。
    return { ok: false, reason: 'no_parseable_lines', badLineCount: acc.badLineCount };
  }
  if (acc.messages.length === 0) {
    // 有可解析 JSON 但无消息：
    //   - 认识结构却无正文（如只有 session_meta / 只有 attachment 元行）→ no_messages；
    //   - 行能解析但结构完全不认识（无 message / 无 payload 的合法 JSON）→ unknown_format。
    const reason: SkipReason = acc.sawRecognizableStructure ? 'no_messages' : 'unknown_format';
    return { ok: false, reason, badLineCount: acc.badLineCount };
  }
  const content = buildSegmentContent(acc.messages);
  if (!canonicalizeForHash(content)) {
    return { ok: false, reason: 'empty_content', badLineCount: acc.badLineCount };
  }
  const happenedAt = deriveHappenedAt(acc.messages);
  const segment: ParsedSegment = {
    source: input.source,
    contentHash: computeContentHash(content),
    title: deriveTitle(acc.messages),
    dateLabel: toDateLabel(happenedAt),
    happenedAt,
    ...(acc.project !== undefined ? { project: acc.project } : {}),
    messageCount: acc.messages.length,
    content,
  };
  return { ok: true, segment, messageBadLines: acc.badLineCount };
}

// ---------------------------------------------------------------------------
// 批解析（多会话 → 去重段 + 统计 + 跳过报告）—— 导入 Job 的主入口
// ---------------------------------------------------------------------------

/**
 * 解析一批会话（Claude / Codex / 混合）为标准段集 + 统计 + 跳过报告。
 *
 * 容错口径（B-18）：单坏会话不影响其它会话；坏行计入 stats.badLineCount 与对应 skipped 项；
 *   全坏 / 全空也正常返回（segments=[]、有跳过报告），由 Job 据空结果出 IMPORT_NO_CONTENT（§4.5）。
 *
 * 去重口径（§6.2 / 导入-22）：同 contentHash 只保留首段；重复计入 stats.duplicateSegmentCount。
 *   注意：本批内去重对应「同一快照内去重」（Job 一次导入 = 一新快照）。跨快照不去重由 DB
 *   UNIQUE(snapshot_id, content_hash) 保证，与本模块无关。
 */
export function parseSessions(inputs: RawSessionInput[]): ParseResult {
  const segments: ParsedSegment[] = [];
  const skipped: SkippedSession[] = [];
  const byHash = new Set<string>();
  const sourcesSeen = new Set<Exclude<ImportSource, 'mixed'>>();
  const projects = new Set<string>();
  let messageCount = 0;
  let badLineCount = 0;
  let duplicateSegmentCount = 0;
  let minTime: string | null = null;
  let maxTime: string | null = null;

  for (const input of inputs) {
    const res = sessionToSegment(input);
    if (!res.ok) {
      badLineCount += res.badLineCount;
      skipped.push({
        sessionRef: input.sessionRef,
        source: input.source,
        reason: res.reason,
        badLineCount: res.badLineCount,
      });
      continue;
    }
    badLineCount += res.messageBadLines;
    const seg = res.segment;
    if (byHash.has(seg.contentHash)) {
      duplicateSegmentCount++;
      continue; // 快照内去重：重复段不堆、统计不算重（导入-22）。
    }
    byHash.add(seg.contentHash);
    segments.push(seg);
    messageCount += seg.messageCount;
    sourcesSeen.add(seg.source);
    if (seg.project) projects.add(seg.project);
    if (seg.happenedAt) {
      if (minTime === null || seg.happenedAt < minTime) minTime = seg.happenedAt;
      if (maxTime === null || seg.happenedAt > maxTime) maxTime = seg.happenedAt;
    }
  }

  // 节选默认 order desc（按 happened_at；null 时间排末尾，稳定）。
  segments.sort((a, b) => {
    if (a.happenedAt === b.happenedAt) return 0;
    if (a.happenedAt === null) return 1;
    if (b.happenedAt === null) return -1;
    return a.happenedAt < b.happenedAt ? 1 : -1;
  });

  const timeSpan = minTime !== null && maxTime !== null ? { from: minTime, to: maxTime } : null;

  const stats: ParseStats = {
    segmentCount: segments.length,
    messageCount,
    projectCount: projects.size,
    timeSpan,
    sources: [...sourcesSeen],
    badLineCount,
    duplicateSegmentCount,
  };

  return { segments, skipped, stats };
}

// ---------------------------------------------------------------------------
// 给导入 Job（B-19）的接口签名（人读镜像；Job 把 ParsedSegment 喂受保护 INSERT，§6.5）
// ---------------------------------------------------------------------------

/**
 * 导入 Job 用法（不在本纯模块执行，仅记口径）：
 *   1) worker 从 S3 拉原文 → 按文件归集成 RawSessionInput[]（source=文件所属来源）；
 *   2) 对每个会话先跑去敏（B-17）替换正文 → 仍是 RawSessionInput（raw 为去敏后文本）；
 *   3) const { segments, skipped, stats } = parseSessions(inputs);
 *   4) 受保护 INSERT raw_snapshots（用 stats 填统计四格，§6.5 模板②）；
 *   5) 逐段受保护 INSERT session_segments（ON CONFLICT(snapshot_id, content_hash) DO NOTHING，§6.5 模板③）
 *      ——边写边经 ctx.appendItem 推 item-appended 落库卡（ImportedSegmentBrief，§4.3，不裸转圈）；
 *   6) skipped → 仅日志 / 内部报告（坏会话跳过，不入对外 ErrorEnvelope）；
 *      segments 为空 → Job 出 IMPORT_NO_CONTENT 终态（§4.5，不生成空完成态）。
 */
export type ImportSessionParser = typeof parseSessions;
