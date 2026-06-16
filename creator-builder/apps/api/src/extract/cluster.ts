// 30 · 提取域核心算法（B-22，30-step2-extract §2.1/§3.3/§5.1）。纯计算 + 经 3A LLM 网关命名，不写库。
//   职责对齐五项子任务标准序（SUBTASK_SEQUENCES.extract）：
//     analyze         分析会话段落      —— 归一某 snapshot 的段集（标题/项目/来源/时间/段数）。
//     cluster         聚类相似工作流    —— 按「项目 + 标题词袋相似度」把段聚成簇（同一快照内，证据不跨快照）。
//     form            形成候选能力      —— 每个达阈值的簇 → 一个 DraftCandidate（带 slug + 支撑段集，逐个浮现单元）。
//     score           评估频率与可打包度 —— 确定性算 segmentCount/frequencyRatio/reusability/scopeCoherence/置信高中低/类型。
//     rank            按成功率排序      —— 按 reusability(overall) 降序排（提取-08「按成功率排序」），稳定序供逐个浮现。
//   命名（name/intent）经 3A LLM 网关 complete（taskClass='extract'）：网关降级/失败由调用方决定单候选成败，
//     本模块只产出「确定性骨架 + 可空 LLM 文案」，绝不裸抛上游错误（§10 degraded 不裸 502）。
import type { LlmGatewayPort, CapabilityType, Confidence } from '@cb/shared';

/** 萃取输入：某 snapshot 下一段去敏会话段（读自 session_segments，§5.2 只读去敏段，提取-31）。 */
export interface ExtractSegment {
  segmentId: string;
  snapshotId: string;
  title: string | null;
  source: string | null;
  project: string | null;
  happenedAt: string | null;
  /** 去敏后正文（已抹隐私；本模块只用于词袋/簇签，不外泄原文）。 */
  content: string;
  messageCount: number;
}

/** 一个簇的确定性骨架（form 子任务产出，未命名、未评分）。 */
export interface DraftCandidate {
  /** 簇内去重键的一部分：(extract_job_id, slug) 去重（§5.1）。 */
  slug: string;
  /** 簇签（项目 + 主导标题词，仅内部用于命名 prompt / 兜底名）。 */
  clusterLabel: string;
  /** 支撑段（血缘：candidate_evidence 每段一行；segmentCount = 本数组长度，提取-34）。 */
  segments: ExtractSegment[];
}

/** 评分后的候选（evaluate + rank 子任务产出；落库前的完整骨架，name/intent 由命名阶段补）。 */
export interface ScoredCandidate extends DraftCandidate {
  segmentCount: number;
  /** 0~1，本簇段数 / 最大簇段数（频次条相对高低，提取-11）。 */
  frequencyRatio: number;
  /** 0~1，overall 可复用分（排序键，提取-08）。 */
  reusability: number;
  /** 0~1，范围一致度（低 → 建议拆分，提取-12）。 */
  scopeCoherence: number;
  splitSuggested: boolean;
  confidence: Confidence;
  type: CapabilityType;
  reusabilityBreakdown: {
    frequency: number;
    crossProject: number;
    recency: number;
    timeCost: number;
  };
  scope: { language?: string; domain?: string; inputType?: string; preconditions?: string[] };
}

/** 命名后的最终候选（name/intent 补齐；degradedNaming=true 表示 LLM 降级、用确定性兜底名）。 */
export interface NamedCandidate extends ScoredCandidate {
  name: string;
  intent: string;
  degradedNaming: boolean;
}

// —— analyze：把 content/title 拆成中英文词袋（簇相似度 + 词频用；纯 ASCII/CJK 切分，无第三方分词）——
const STOPWORDS = new Set([
  '的',
  '了',
  '和',
  '是',
  '我',
  '你',
  '他',
  '这',
  '那',
  '一个',
  '帮',
  '请',
  '可以',
  '需要',
  'the',
  'a',
  'an',
  'to',
  'of',
  'and',
  'is',
  'for',
  'in',
  'on',
  'me',
  'my',
  'please',
  'help',
]);

/** 粗分词：英文按非字母数字切，CJK 按双字滑窗（足够做簇相似度，不追求语言学正确）。 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const out: string[] = [];
  // 英文/数字词。
  for (const m of lower.matchAll(/[a-z0-9]{2,}/g)) {
    if (!STOPWORDS.has(m[0])) out.push(m[0]);
  }
  // CJK 双字滑窗。
  const cjk = lower.match(/[一-鿿]+/g) ?? [];
  for (const run of cjk) {
    if (run.length === 1) {
      if (!STOPWORDS.has(run)) out.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) {
      const bg = run.slice(i, i + 2);
      if (!STOPWORDS.has(bg)) out.push(bg);
    }
  }
  return out;
}

/** 段签名（簇 key 的种子）：项目优先；无项目用标题主导词；都没有归 'misc'。 */
function segmentClusterKey(seg: ExtractSegment): string {
  if (seg.project && seg.project.trim()) return `proj:${seg.project.trim()}`;
  const toks = tokenize(seg.title ?? '');
  if (toks.length > 0) return `topic:${toks[0]}`;
  const ctoks = tokenize(seg.content);
  if (ctoks.length > 0) return `topic:${ctoks[0]}`;
  return 'misc';
}

/** Jaccard 相似度（两词袋集合）。 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const uni = a.size + b.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

/** slug 化：取簇标签的 ASCII 词；CJK 退回 hash 后缀，保证 SlugSchema 合法（小写字母数字+连字符）。 */
export function slugify(label: string, fallbackSeed: string): string {
  const ascii = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (ascii.length >= 2) return ascii;
  // 纯 CJK / 太短：用确定性 hash 后缀（同输入同 slug，便于幂等/去重）。
  let h = 0;
  for (const ch of fallbackSeed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `cap-${h.toString(36)}`;
}

/**
 * analyze + cluster + form（前三子任务的纯计算）：
 *   - 按 segmentClusterKey 初步分桶（项目/主导词）；
 *   - 桶内再按词袋 Jaccard 合并近似段（阈值 0.5）——把「同一工作流的不同会话」聚到一簇；
 *   - 每簇达 minSegments 段 → 一个 DraftCandidate（带稳定 slug + 支撑段集）。
 *   稳定性（提取-30 不跳变）：簇内段按 segmentId 升序；簇间按「首段 segmentId」升序，确保多次运行同序。
 */
export function clusterSegments(
  segments: ExtractSegment[],
  opts: { minSegments?: number; mergeThreshold?: number } = {},
): DraftCandidate[] {
  const minSegments = opts.minSegments ?? 1;
  const mergeThreshold = opts.mergeThreshold ?? 0.5;

  // 段词袋（content + title）。
  const bags = new Map<string, Set<string>>();
  for (const s of segments) {
    bags.set(s.segmentId, new Set(tokenize(`${s.title ?? ''} ${s.content}`)));
  }

  // ① 初步分桶。
  const buckets = new Map<string, ExtractSegment[]>();
  for (const s of segments) {
    const key = segmentClusterKey(s);
    const arr = buckets.get(key) ?? [];
    arr.push(s);
    buckets.set(key, arr);
  }

  // ② 桶内按 Jaccard 合并成簇（贪心：每段并入第一个相似度 ≥ 阈值的已有簇，否则开新簇）。
  const drafts: DraftCandidate[] = [];
  for (const [, bucketSegs] of buckets) {
    const sorted = [...bucketSegs].sort((a, b) => (a.segmentId < b.segmentId ? -1 : 1));
    const clusters: ExtractSegment[][] = [];
    for (const seg of sorted) {
      const segBag = bags.get(seg.segmentId)!;
      let placed = false;
      for (const cl of clusters) {
        // 与簇内首段比相似度（首段是簇代表，稳定）。
        const repBag = bags.get(cl[0]!.segmentId)!;
        if (jaccard(segBag, repBag) >= mergeThreshold) {
          cl.push(seg);
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push([seg]);
    }
    for (const cl of clusters) {
      if (cl.length < minSegments) continue;
      const label = clusterLabelOf(cl);
      const seed = cl.map((s) => s.segmentId).join('|');
      drafts.push({ slug: slugify(label, seed), clusterLabel: label, segments: cl });
    }
  }

  // 簇间稳定排序（按首段 segmentId）。slug 唯一化（同 slug 撞了加序号后缀，叠加 (job,slug) 去重键）。
  drafts.sort((a, b) => (a.segments[0]!.segmentId < b.segments[0]!.segmentId ? -1 : 1));
  const seenSlug = new Map<string, number>();
  for (const d of drafts) {
    const n = seenSlug.get(d.slug) ?? 0;
    seenSlug.set(d.slug, n + 1);
    if (n > 0) d.slug = `${d.slug}-${n + 1}`;
  }
  return drafts;
}

/** 簇标签：项目名优先；否则取簇内最高频标题/正文词（兜底名 + slug 种子）。 */
function clusterLabelOf(cluster: ExtractSegment[]): string {
  const withProj = cluster.find((s) => s.project && s.project.trim());
  if (withProj?.project) return withProj.project.trim();
  const freq = new Map<string, number>();
  for (const s of cluster) {
    for (const t of tokenize(`${s.title ?? ''} ${s.content}`)) {
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
  }
  let best = '';
  let bestN = 0;
  for (const [t, n] of freq) {
    if (n > bestN) {
      bestN = n;
      best = t;
    }
  }
  return best || '未命名工作流';
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * score + rank（确定性打分 + 排序）。所有信号 0~1，按 reusability(overall) 降序（提取-08）。
 *   - frequency：本簇段数 / 全簇最大段数（频次条相对高低）。
 *   - crossProject：簇内不同 project 数 / 段数（跨项目越广越可复用）。
 *   - recency：最近一段距今天数映射（90 天内线性衰减；越新越高）。
 *   - timeCost：簇内总消息数归一（越省人力越值得打包；用 messageCount 近似投入产出）。
 *   - reusability = 这四项加权（确定性，可解释，非 LLM 黑箱）。
 *   - scopeCoherence：簇内词袋与簇代表的平均相似度（高 = 范围一致；低 → splitSuggested）。
 *   - confidence：reusability + segmentCount 联合分档（高/中/低，提取-09/12）。
 *   - type：core-workflow / recurring / occasional（按段数与频次，提取-10）。
 */
export function scoreCandidates(
  drafts: DraftCandidate[],
  nowMs: number,
  opts: { splitThreshold?: number } = {},
): ScoredCandidate[] {
  const splitThreshold = opts.splitThreshold ?? 0.45;
  const maxSeg = Math.max(1, ...drafts.map((d) => d.segments.length));

  const scored: ScoredCandidate[] = drafts.map((d) => {
    const segCount = d.segments.length;
    const frequency = clamp01(segCount / maxSeg);

    const projects = new Set(d.segments.map((s) => s.project ?? '').filter(Boolean));
    const crossProject = clamp01(projects.size / Math.max(1, segCount));

    // recency：最近 happenedAt。
    let newest = 0;
    for (const s of d.segments) {
      if (s.happenedAt) {
        const t = Date.parse(s.happenedAt);
        if (!Number.isNaN(t) && t > newest) newest = t;
      }
    }
    const ageDays = newest > 0 ? Math.max(0, (nowMs - newest) / DAY_MS) : 90;
    const recency = clamp01(1 - ageDays / 90);

    // timeCost：簇内总消息数（更多来回 = 更值得打包），按 50 条封顶归一。
    const totalMsgs = d.segments.reduce((acc, s) => acc + s.messageCount, 0);
    const timeCost = clamp01(totalMsgs / 50);

    const reusability = round3(
      0.4 * frequency + 0.25 * crossProject + 0.2 * recency + 0.15 * timeCost,
    );

    // scopeCoherence：簇内段与代表段词袋平均 Jaccard。
    const repBag = new Set(tokenize(`${d.segments[0]!.title ?? ''} ${d.segments[0]!.content}`));
    let sim = 0;
    for (const s of d.segments) {
      const bag = new Set(tokenize(`${s.title ?? ''} ${s.content}`));
      sim += jaccard(bag, repBag);
    }
    const scopeCoherence = round3(segCount > 0 ? sim / segCount : 0);
    const splitSuggested = scopeCoherence < splitThreshold && segCount >= 3;

    const confidence: Confidence =
      reusability >= 0.66 && segCount >= 5
        ? 'high'
        : reusability >= 0.4 || segCount >= 3
          ? 'med'
          : 'low';

    const type: CapabilityType =
      segCount >= 8 ? 'core-workflow' : segCount >= 3 ? 'recurring' : 'occasional';

    return {
      ...d,
      segmentCount: segCount,
      frequencyRatio: round3(frequency),
      reusability,
      scopeCoherence,
      splitSuggested,
      confidence,
      type,
      reusabilityBreakdown: {
        frequency: round3(frequency),
        crossProject: round3(crossProject),
        recency: round3(recency),
        timeCost: round3(timeCost),
      },
      scope: scopeOf(d),
    };
  });

  // rank：reusability 降序；并列按 segmentCount 降序、再按 slug 升序（稳定、可复现）。
  scored.sort(
    (a, b) =>
      b.reusability - a.reusability ||
      b.segmentCount - a.segmentCount ||
      (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  );
  return scored;
}

/** 适用范围画像（来自证据，非 LLM；语言/项目域/输入类型推断）。 */
function scopeOf(d: DraftCandidate): ScoredCandidate['scope'] {
  const langs = new Set<string>();
  for (const s of d.segments) {
    const hasCjk = /[一-鿿]/.test(s.content);
    const hasLatin = /[a-z]/i.test(s.content);
    if (hasCjk) langs.add('zh');
    if (hasLatin) langs.add('en');
  }
  const language = langs.size >= 2 ? 'mixed' : (langs.values().next().value ?? undefined);
  const projects = [...new Set(d.segments.map((s) => s.project ?? '').filter(Boolean))];
  const scope: ScoredCandidate['scope'] = {};
  if (language) scope.language = language;
  if (projects.length === 1) scope.domain = projects[0];
  return scope;
}

/**
 * 命名一个候选（name/intent）：经 3A LLM 网关 complete（taskClass='extract'）。
 *   - 网关 degraded（无 key / 上游不稳，§10）→ 用确定性兜底名（簇标签）+ 通用 intent，degradedNaming=true，**不抛**。
 *   - 解析失败/空输出 → 同样兜底，绝不裸抛（单候选成败由 handler 据 nameOne 是否 throw 决定；本函数对降级不 throw）。
 *   - 抛错仅当调用方注入的 gateway 真抛（网络层异常 escape）——handler 捕获标该候选 failed（不阻塞其余）。
 */
export async function nameOne(
  gateway: LlmGatewayPort,
  cand: ScoredCandidate,
  opts: { traceId: string; ownerUserId?: string },
): Promise<NamedCandidate> {
  const fallbackName = cand.clusterLabel === '未命名工作流' ? '未命名能力' : cand.clusterLabel;
  const fallbackIntent = `把「${fallbackName}」这类反复出现的工作流打包成可复用能力`;

  const sample = cand.segments
    .slice(0, 3)
    .map((s, i) => `${i + 1}. ${(s.title ?? '').slice(0, 40)}：${s.content.slice(0, 120)}`)
    .join('\n');
  const prompt =
    `下面是用户反复做的同一类工作流的去敏会话片段，请给它起一个简短中文能力名（≤12字）和一句话用途描述。\n` +
    `严格输出 JSON：{"name":"...","intent":"..."}，不要其它内容。\n\n${sample}`;

  const result = await gateway.complete(prompt, {
    taskClass: 'extract',
    traceId: opts.traceId,
    ...(opts.ownerUserId ? { ownerUserId: opts.ownerUserId } : {}),
  });

  if (result.degraded || !result.text) {
    return { ...cand, name: fallbackName, intent: fallbackIntent, degradedNaming: true };
  }
  const parsed = parseNameJson(result.text);
  return {
    ...cand,
    name: parsed?.name?.slice(0, 24) || fallbackName,
    intent: parsed?.intent?.slice(0, 200) || fallbackIntent,
    degradedNaming: false,
  };
}

/** 容错解析 LLM 命名 JSON（提取首个 {...}；坏 JSON → null，调用方兜底）。 */
function parseNameJson(text: string): { name?: string; intent?: string } | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { name?: unknown; intent?: unknown };
    return {
      ...(typeof o.name === 'string' ? { name: o.name } : {}),
      ...(typeof o.intent === 'string' ? { intent: o.intent } : {}),
    };
  } catch {
    return null;
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
