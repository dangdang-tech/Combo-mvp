// ErrorEnvelope（脊柱 §3 / §11.B / D1）：绝不裸露错误码。
// 对外信封一律不含 code —— 对外仅 {userMessage, action, retriable, traceId, failureId?, details?}。
// 内部 code 只用于日志/告警/文案映射、绝不进对外 payload（UI/SSE/HTTP body 一律不含 code），
// 排障经 traceId 关联日志里的 code（D1）。
import { z } from 'zod';
import { TraceIdSchema, type TraceId } from './ids.js';

/** action 五枚举（脊柱 §3.2）。可对 UI 展示的核心三类：retry|change_input|escalate；wait|none 为后台态/信息态。 */
export const ErrorActionSchema = z.enum(['retry', 'change_input', 'escalate', 'wait', 'none']);
export type ErrorAction = z.infer<typeof ErrorActionSchema>;

/** 可对 UI 展示的核心退路三类（§11.B 收敛口径）。 */
export const DISPLAYABLE_ACTIONS = ['retry', 'change_input', 'escalate'] as const;
export type DisplayableAction = (typeof DISPLAYABLE_ACTIONS)[number];

/**
 * ErrorEnvelope 内层 error 形态（脊柱 §3.1 / §11.B / D1 对外权威形态）。
 * **对外一律不含 `code`**（D1）：内部 code 只进日志、经 traceId 关联，绝不进 HTTP body / SSE 帧 / UI。
 */
export const ErrorBodySchema = z.object({
  /** 唯一可对 UI 展示的人话（中文）；绝不含 code/状态码/堆栈/英文报错。 */
  userMessage: z.string().min(1),
  retriable: z.boolean(),
  action: ErrorActionSchema,
  /** 关联日志/Sentry（日志里有内部 code）；前端可作「反馈代码」展示但非错误码。 */
  traceId: TraceIdSchema,
  /** 仅登录等重定向场景：不透明失败标识，替代 URL 里的内部 code（§11.B）。 */
  failureId: z.string().optional(),
  /** 结构化可安全展示补充；禁放堆栈/原始报错/内部路径/code。 */
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

/** 完整对外错误信封。所有非 2xx、所有 SSE error 帧、所有前端可见失败都只出它（不含 code）。 */
export const ErrorEnvelopeSchema = z.object({ error: ErrorBodySchema });
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

/** 客户端兜底人话信封 traceId 哨兵值（哨兵不当「反馈代码」展示，因它不关联任何真实日志）。 */
export const CLIENT_FALLBACK_TRACE_ID = 'client-local';

// ---------- 错误分类枚举（内部 code，命名 {DOMAIN}_{REASON}）----------

/** 脊柱 §3.3 通用内部 code + 各域扩展 code（§5 错误分类总表）。code 仅内部，对外只出 userMessage+action。 */
export const ErrorCode = {
  // —— 脊柱 §3.3 通用 ——
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  INPUT_TOO_SMALL: 'INPUT_TOO_SMALL',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  STATE_CONFLICT: 'STATE_CONFLICT',
  ALREADY_PUBLISHED: 'ALREADY_PUBLISHED',
  STRUCTURE_FIELD_FAILED: 'STRUCTURE_FIELD_FAILED',
  RESOURCE_LOCKED: 'RESOURCE_LOCKED',
  RATE_LIMITED: 'RATE_LIMITED',
  CLIENT_CANCELLED: 'CLIENT_CANCELLED',
  INTERNAL: 'INTERNAL',
  LLM_UPSTREAM_FAILED: 'LLM_UPSTREAM_FAILED',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  JOB_TIMEOUT: 'JOB_TIMEOUT',
  PRECONDITION_FAILED: 'PRECONDITION_FAILED',

  // —— Auth 10 ——
  AUTH_STATE_MISMATCH: 'AUTH_STATE_MISMATCH',
  AUTH_CONSENT_DENIED: 'AUTH_CONSENT_DENIED',
  AUTH_CALLBACK_FAILED: 'AUTH_CALLBACK_FAILED',
  AUTH_UPSTREAM_UNAVAILABLE: 'AUTH_UPSTREAM_UNAVAILABLE',

  // —— 导入 20 ——
  IMPORT_NO_CONTENT: 'IMPORT_NO_CONTENT',
  UPLOAD_INTERRUPTED: 'UPLOAD_INTERRUPTED',

  // —— 提取 30 ——
  EXTRACT_SNAPSHOT_NOT_READY: 'EXTRACT_SNAPSHOT_NOT_READY',
  CANDIDATE_ALREADY_READY: 'CANDIDATE_ALREADY_READY',
  EXTRACT_UPSTREAM_TIMEOUT: 'EXTRACT_UPSTREAM_TIMEOUT',
  EXTRACT_JOB_TIMEOUT: 'EXTRACT_JOB_TIMEOUT',

  // —— 结构化 40 ——
  STRUCTURE_NO_EVIDENCE: 'STRUCTURE_NO_EVIDENCE',
  HARD_FIELD_LOCKED: 'HARD_FIELD_LOCKED',

  // —— 发布 50 ——
  PUBLISH_MISSING_FIELDS: 'PUBLISH_MISSING_FIELDS',
  PUBLISH_COVER_INVALID: 'PUBLISH_COVER_INVALID',

  // —— 工作台/主页 60 ——
  DASHBOARD_AGGREGATE_FAILED: 'DASHBOARD_AGGREGATE_FAILED',
  PROFILE_AGGREGATE_FAILED: 'PROFILE_AGGREGATE_FAILED',
  PROFILE_SECTION_FAILED: 'PROFILE_SECTION_FAILED',
  SOCIAL_SELF_FOLLOW: 'SOCIAL_SELF_FOLLOW',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 错误分类条目：HTTP 状态 + retriable/action 缺省 + 人话模板（脊柱 §3.3 / §5）。 */
export interface ErrorClassification {
  code: ErrorCodeValue;
  http: number;
  retriable: boolean;
  action: ErrorAction;
  /** 人话 userMessage 缺省模板（中文）。 */
  userMessageTemplate: string;
}

/** 错误分类总表（脊柱 §3.3 缺省 + 各域 §5 扩展）。各域用例只引用、不重定义 action/retriable 缺省。 */
export const ERROR_CLASSIFICATION: Record<ErrorCodeValue, ErrorClassification> = {
  [ErrorCode.VALIDATION_FAILED]: {
    code: ErrorCode.VALIDATION_FAILED,
    http: 400,
    retriable: false,
    action: 'change_input',
    userMessageTemplate: '输入有点问题，改一下再试。',
  },
  [ErrorCode.INPUT_TOO_SMALL]: {
    code: ErrorCode.INPUT_TOO_SMALL,
    http: 400,
    retriable: false,
    action: 'change_input',
    userMessageTemplate: '这次没读到可用内容，换个目录/文件再导入。',
  },
  [ErrorCode.UNAUTHENTICATED]: {
    code: ErrorCode.UNAUTHENTICATED,
    http: 401,
    retriable: false,
    action: 'escalate',
    userMessageTemplate: '登录态失效了，请重新登录。',
  },
  [ErrorCode.FORBIDDEN]: {
    code: ErrorCode.FORBIDDEN,
    http: 403,
    retriable: false,
    action: 'escalate',
    userMessageTemplate: '你没有权限做这个操作。',
  },
  [ErrorCode.NOT_FOUND]: {
    code: ErrorCode.NOT_FOUND,
    http: 404,
    retriable: false,
    action: 'change_input',
    userMessageTemplate: '没找到对应内容，可能已被删除或链接失效。',
  },
  [ErrorCode.IDEMPOTENCY_CONFLICT]: {
    code: ErrorCode.IDEMPOTENCY_CONFLICT,
    http: 409,
    retriable: false,
    action: 'none',
    userMessageTemplate: '这个操作已经处理过了。',
  },
  [ErrorCode.STATE_CONFLICT]: {
    code: ErrorCode.STATE_CONFLICT,
    http: 409,
    retriable: false,
    action: 'change_input',
    userMessageTemplate: '当前状态不支持这个操作（如已发布需建新版本）。',
  },
  [ErrorCode.ALREADY_PUBLISHED]: {
    code: ErrorCode.ALREADY_PUBLISHED,
    http: 409,
    retriable: false,
    action: 'none',
    userMessageTemplate: '这个能力已发布过了，无需重复发布。',
  },
  [ErrorCode.STRUCTURE_FIELD_FAILED]: {
    code: ErrorCode.STRUCTURE_FIELD_FAILED,
    http: 422,
    retriable: true,
    action: 'retry',
    userMessageTemplate: '这个字段没生成出来，可重试或改输入。',
  },
  [ErrorCode.RESOURCE_LOCKED]: {
    code: ErrorCode.RESOURCE_LOCKED,
    http: 423,
    retriable: true,
    action: 'wait',
    userMessageTemplate: '这条任务正在被处理，请稍候。',
  },
  [ErrorCode.RATE_LIMITED]: {
    code: ErrorCode.RATE_LIMITED,
    http: 429,
    retriable: true,
    action: 'wait',
    userMessageTemplate: '请求有点频繁，歇一下再试。',
  },
  [ErrorCode.CLIENT_CANCELLED]: {
    code: ErrorCode.CLIENT_CANCELLED,
    http: 499,
    retriable: false,
    action: 'none',
    userMessageTemplate: '操作已取消。',
  },
  [ErrorCode.INTERNAL]: {
    code: ErrorCode.INTERNAL,
    http: 500,
    retriable: true,
    action: 'retry',
    userMessageTemplate: '服务开小差了，请重试。',
  },
  [ErrorCode.LLM_UPSTREAM_FAILED]: {
    code: ErrorCode.LLM_UPSTREAM_FAILED,
    http: 502,
    retriable: true,
    action: 'retry',
    userMessageTemplate: '上游处理暂时不稳定，请稍后重试。',
  },
  [ErrorCode.DEPENDENCY_UNAVAILABLE]: {
    code: ErrorCode.DEPENDENCY_UNAVAILABLE,
    http: 503,
    retriable: true,
    action: 'wait',
    userMessageTemplate: '系统正在恢复，请稍候再试。',
  },
  [ErrorCode.JOB_TIMEOUT]: {
    code: ErrorCode.JOB_TIMEOUT,
    http: 504,
    retriable: true,
    action: 'retry',
    userMessageTemplate: '这一步超时了，可重试或稍后再看。',
  },
  [ErrorCode.PRECONDITION_FAILED]: {
    code: ErrorCode.PRECONDITION_FAILED,
    http: 412,
    retriable: true,
    action: 'retry',
    userMessageTemplate: '内容刚刚被改过了，请刷新后重试。',
  },

  // —— Auth 10 ——
  [ErrorCode.AUTH_STATE_MISMATCH]: {
    code: ErrorCode.AUTH_STATE_MISMATCH,
    http: 400,
    retriable: false,
    action: 'change_input',
    userMessageTemplate: '登录会话过期了，请重新登录。',
  },
  [ErrorCode.AUTH_CONSENT_DENIED]: {
    code: ErrorCode.AUTH_CONSENT_DENIED,
    http: 400,
    retriable: false,
    action: 'change_input',
    userMessageTemplate: '登录未完成，可以再试一次。',
  },
  [ErrorCode.AUTH_CALLBACK_FAILED]: {
    code: ErrorCode.AUTH_CALLBACK_FAILED,
    http: 400,
    retriable: false,
    action: 'change_input',
    userMessageTemplate: '登录没能完成，请重新登录。',
  },
  [ErrorCode.AUTH_UPSTREAM_UNAVAILABLE]: {
    code: ErrorCode.AUTH_UPSTREAM_UNAVAILABLE,
    http: 503,
    retriable: true,
    action: 'escalate',
    userMessageTemplate: '登录服务正在恢复，请稍候再试。',
  },

  // —— 导入 20 ——
  [ErrorCode.IMPORT_NO_CONTENT]: {
    code: ErrorCode.IMPORT_NO_CONTENT,
    http: 400,
    retriable: false,
    action: 'change_input',
    userMessageTemplate: '这次没读到可用内容，换个目录/文件再导入。',
  },
  [ErrorCode.UPLOAD_INTERRUPTED]: {
    code: ErrorCode.UPLOAD_INTERRUPTED,
    http: 409,
    retriable: true,
    action: 'retry',
    userMessageTemplate: '上传中断了，重试一下就能继续。',
  },

  // —— 提取 30 ——
  [ErrorCode.EXTRACT_SNAPSHOT_NOT_READY]: {
    code: ErrorCode.EXTRACT_SNAPSHOT_NOT_READY,
    http: 409,
    retriable: false,
    action: 'change_input',
    userMessageTemplate: '这份数据还没准备好，请稍后再开始提取。',
  },
  [ErrorCode.CANDIDATE_ALREADY_READY]: {
    code: ErrorCode.CANDIDATE_ALREADY_READY,
    http: 409,
    retriable: false,
    action: 'none',
    userMessageTemplate: '这个候选已经识别好了，无需重试。',
  },
  [ErrorCode.EXTRACT_UPSTREAM_TIMEOUT]: {
    code: ErrorCode.EXTRACT_UPSTREAM_TIMEOUT,
    http: 502,
    retriable: true,
    action: 'retry',
    userMessageTemplate: '上游处理暂时不稳定，请稍后重试。',
  },
  [ErrorCode.EXTRACT_JOB_TIMEOUT]: {
    code: ErrorCode.EXTRACT_JOB_TIMEOUT,
    http: 504,
    retriable: true,
    action: 'retry',
    userMessageTemplate: '这一步超时了，可重试或稍后再看。',
  },

  // —— 结构化 40 ——
  [ErrorCode.STRUCTURE_NO_EVIDENCE]: {
    code: ErrorCode.STRUCTURE_NO_EVIDENCE,
    http: 422,
    retriable: false,
    action: 'change_input',
    userMessageTemplate: '这条能力缺少可用的会话证据，换个候选再试。',
  },
  [ErrorCode.HARD_FIELD_LOCKED]: {
    code: ErrorCode.HARD_FIELD_LOCKED,
    http: 422,
    retriable: false,
    action: 'change_input',
    userMessageTemplate: '这个字段由平台锁定，不能手动修改。',
  },

  // —— 发布 50 ——
  [ErrorCode.PUBLISH_MISSING_FIELDS]: {
    code: ErrorCode.PUBLISH_MISSING_FIELDS,
    http: 422,
    retriable: false,
    action: 'change_input',
    userMessageTemplate: '市集卡还差几项必填内容，去补齐后再发布。',
  },
  [ErrorCode.PUBLISH_COVER_INVALID]: {
    code: ErrorCode.PUBLISH_COVER_INVALID,
    http: 422,
    retriable: false,
    action: 'change_input',
    userMessageTemplate: '封面没能用上，换一张或用默认封面再试。',
  },

  // —— 工作台/主页 60 ——
  [ErrorCode.DASHBOARD_AGGREGATE_FAILED]: {
    code: ErrorCode.DASHBOARD_AGGREGATE_FAILED,
    http: 500,
    retriable: true,
    action: 'retry',
    userMessageTemplate: '工作台数据没能加载出来，请重试。',
  },
  [ErrorCode.PROFILE_AGGREGATE_FAILED]: {
    code: ErrorCode.PROFILE_AGGREGATE_FAILED,
    http: 500,
    retriable: true,
    action: 'retry',
    userMessageTemplate: '主页数据没能加载出来，请重试。',
  },
  [ErrorCode.PROFILE_SECTION_FAILED]: {
    code: ErrorCode.PROFILE_SECTION_FAILED,
    http: 500,
    retriable: true,
    action: 'retry',
    userMessageTemplate: '这个板块没能加载出来，请重试。',
  },
  [ErrorCode.SOCIAL_SELF_FOLLOW]: {
    code: ErrorCode.SOCIAL_SELF_FOLLOW,
    http: 422,
    retriable: false,
    action: 'change_input',
    userMessageTemplate: '不能关注或点赞自己。',
  },
};

export interface BuildErrorOptions {
  /** 覆盖分类表缺省人话（须仍是中文人话，禁含 code/状态码/堆栈/英文报错）。 */
  userMessage?: string;
  /** 覆盖缺省 action（一般遵分类表，特殊场景显式给）。 */
  action?: ErrorAction;
  /** 覆盖缺省 retriable。 */
  retriable?: boolean;
  /** 登录等重定向场景的不透明失败标识（§11.B）。 */
  failureId?: string;
  /** 结构化可安全展示补充（禁堆栈）。 */
  details?: Record<string, unknown>;
}

/** 禁止进 userMessage 的裸露模式（CI/评审守门，脊柱 §3.1）。 */
const FORBIDDEN_USER_MESSAGE_PATTERNS: RegExp[] = [
  /\bError:/i,
  /\bat\s+.+\(.+:\d+:\d+\)/, // stack frame
  /\b[1-5]\d{2}\b\s*(error|status)?/i, // 裸 HTTP 状态码（粗略）
  /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)\b.*\b(FROM|WHERE|TABLE)\b/i, // SQL 串
  /\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND)\b/, // 驱动报错串
];

/**
 * 校验 userMessage 是否符合「人话」硬约束（脊柱 §3.1 / §11.B）。
 * 返回违规命中模式数组（空数组 = 合规）。供 CI/单测/守门调用。
 */
export function lintUserMessage(userMessage: string): RegExp[] {
  return FORBIDDEN_USER_MESSAGE_PATTERNS.filter((re) => re.test(userMessage));
}

// ---------- 错误信封白名单重建（Codex r2 P1 / D1：杜绝 code/status/stack/原始 message 泄漏）----------

/** 安全 details 键白名单：仅这些键可保留进对外 details（其余一律丢弃，杜绝堆栈/原始报错/内部路径/code 泄漏）。 */
const SAFE_DETAILS_KEYS = ['field', 'attempts'] as const;

/**
 * 白名单过滤 details（Codex r2 P1）：只放行 {@link SAFE_DETAILS_KEYS}，且字符串值不得命中 §3.1 禁止模式。
 * 任意未知键（含 code/stack/原始报错/内部路径）一律丢弃；过滤后为空则返回 undefined（不挂空 details）。
 */
function sanitizeDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  for (const key of SAFE_DETAILS_KEYS) {
    if (!(key in details)) continue;
    const v = details[key];
    // 字符串值再过一遍禁止模式（堆栈/SQL/状态码混进可安全键也拦）。
    if (typeof v === 'string' && FORBIDDEN_USER_MESSAGE_PATTERNS.some((re) => re.test(v))) continue;
    out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 白名单**重建** ErrorBody（Codex r2 P1，D1）：从任意可疑输入只摘取契约允许的安全字段
 * （`userMessage`/`action`/`retriable`/`traceId`/`failureId?`/`details?`），其余一律不进结果对象——
 * 杜绝 shape-check 后强转把 `code`/`status`/`stack`/原始 `message` 等留在对象里被序列化/泄漏。
 *
 * 来源不可信时（缺 userMessage / action 非法）回退兜底人话。`details` 经 {@link sanitizeDetails} 过滤禁止字段。
 * HTTP body / SSE error 帧 / done.error / state.error 解包后统一过本函数，是「绝不裸露错误码」的最后一道闸。
 */
export function sanitizeErrorBody(input: unknown): ErrorBody {
  const fallback: ErrorBody = {
    userMessage: '出了点小问题，请重试。',
    retriable: true,
    action: 'retry',
    traceId: CLIENT_FALLBACK_TRACE_ID,
  };
  if (typeof input !== 'object' || input === null) return fallback;
  const raw = input as Record<string, unknown>;
  const userMessage = raw['userMessage'];
  if (typeof userMessage !== 'string' || userMessage.length === 0) return fallback;
  const action = raw['action'];
  const safeAction: ErrorAction = ErrorActionSchema.safeParse(action).success
    ? (action as ErrorAction)
    : 'retry';
  // 逐字段白名单重建（绝不展开 ...raw）：未列字段（code/status/stack/message…）天然不进结果对象。
  const body: ErrorBody = {
    userMessage,
    retriable: typeof raw['retriable'] === 'boolean' ? (raw['retriable'] as boolean) : true,
    action: safeAction,
    traceId:
      typeof raw['traceId'] === 'string' ? (raw['traceId'] as string) : CLIENT_FALLBACK_TRACE_ID,
  };
  if (typeof raw['failureId'] === 'string') body.failureId = raw['failureId'] as string;
  const details = sanitizeDetails(raw['details'] as Record<string, unknown> | undefined);
  if (details) body.details = details;
  return body;
}

/**
 * 从「完整对外 ErrorEnvelope（`{error:{...}}`）/ 裸 ErrorBody / 任意可疑输入」白名单重建出**安全的 ErrorEnvelope**（D1）。
 * 标准形态取 `input.error`，容错裸 ErrorBody 直取 `input`，都不像则兜底人话；内层一律过 {@link sanitizeErrorBody}。
 */
export function sanitizeErrorEnvelope(input: unknown): ErrorEnvelope {
  if (typeof input === 'object' && input !== null) {
    const inner = (input as { error?: unknown }).error;
    if (typeof inner === 'object' && inner !== null) {
      return { error: sanitizeErrorBody(inner) };
    }
  }
  // 裸 ErrorBody（或不可信输入）：直接重建。
  return { error: sanitizeErrorBody(input) };
}

/**
 * 对外错误信封构造器（D1）：从分类表取缺省，按需覆盖。
 * **返回的对外信封一律不含 `code`**——内部 code 仅作入参用于分类查表，绝不进对外 payload。
 * 排障经 `traceId` 关联日志里的 code；UI/SSE/HTTP body 一律不含 code（§11.B / D1）。
 * api 层若需把 code 落日志，用 {@link buildErrorWithCode}（同一信封 + 单独的内部 code）。
 */
export function buildError(
  code: ErrorCodeValue,
  traceId: TraceId,
  opts: BuildErrorOptions = {},
): ErrorEnvelope {
  const cls = ERROR_CLASSIFICATION[code];
  const body: ErrorBody = {
    userMessage: opts.userMessage ?? cls.userMessageTemplate,
    retriable: opts.retriable ?? cls.retriable,
    action: opts.action ?? cls.action,
    traceId,
  };
  if (opts.failureId !== undefined) body.failureId = opts.failureId;
  if (opts.details !== undefined) body.details = opts.details;
  return { error: body };
}

/**
 * 内部错误对（D1）：对外信封（不含 code）+ 单独的内部 `code`（仅供日志/告警/文案映射）。
 * api/worker 层用法：把 `envelope` 写进 HTTP body / SSE 帧 / `jobs.error`（不含 code），
 * 把 `code` 连同 `envelope.error.traceId` 写进日志/Sentry（经 traceId 关联，绝不进对外 payload）。
 */
export interface InternalError {
  /** 内部枚举 {DOMAIN}_{REASON}，仅日志/告警/文案映射；绝不进对外 payload。 */
  code: ErrorCodeValue;
  /** 对外信封（不含 code）。 */
  envelope: ErrorEnvelope;
}

/**
 * 构造「对外信封（不含 code）+ 内部 code（供日志）」对（D1）。
 * 对外只发 `envelope`；`code` 只入日志，经 `envelope.error.traceId` 关联。
 */
export function buildErrorWithCode(
  code: ErrorCodeValue,
  traceId: TraceId,
  opts: BuildErrorOptions = {},
): InternalError {
  return { code, envelope: buildError(code, traceId, opts) };
}

/** 取某 code 对应 HTTP 状态（供 api 层据信封回状态行）。 */
export function httpStatusFor(code: ErrorCodeValue): number {
  return ERROR_CLASSIFICATION[code].http;
}
