// B-06 · OpenRouter(OpenAI 兼容)适配器:以 fetch 调 /chat/completions(非流式 + SSE 流式),
// 产出与网关已有 Anthropic 形态等价的 Message / RawMessageStreamEvent,使 gateway.ts 的
// chunk/usage 抽取(extractText、message_start/content_block_delta/message_delta)无需改动即可复用。
//
// 为什么用 fetch 而非 openai SDK:本仓未装 openai 依赖;OpenAI 兼容的 /chat/completions + SSE
// 协议足够简单,fetch 即可全覆盖(非流 JSON、流式 data: 行),省一个依赖、单测可直接 mock fetch。
// 错误:HTTP 非 2xx / 网络 / 超时 → 抛 OpenRouterApiError(由 errors.ts 归一到与 Anthropic 一致的内部分类)。
import type Anthropic from '@anthropic-ai/sdk';
import type { LlmSdkClient } from './gateway.js';
import { OpenRouterApiError } from './openrouter-errors.js';

/** OpenRouter 默认网关与默认模型(OpenRouter 上的 Claude;可经 env 覆盖)。 */
export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
// 必须是 OpenRouter 上真实存在的 slug(实测 /api/v1/models 校过)。
//   旧默认 'anthropic/claude-3.7-sonnet' 在 OpenRouter 上不存在 → 不设 LLM_MODEL 跑 OpenRouter
//   会拿不到模型 → 全程 degraded。此处仅是「未设 LLM_MODEL」时的兜底;
//   生产 .env 显式设 LLM_MODEL(现为 deepseek/deepseek-v4-flash,取其便宜快速)。
export const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';

/** 注入(单测可替换 fetch);生产用全局 fetch(Node ≥18)。 */
export interface OpenRouterClientOptions {
  apiKey: string;
  /** 默认 https://openrouter.ai/api/v1。 */
  baseUrl?: string;
  model: string;
  /** 默认全局 fetch;单测注入 mock。 */
  fetchImpl?: typeof fetch;
}

/** OpenAI 兼容 usage 字段(OpenRouter 同形;completion_tokens/prompt_tokens 可缺,缺则记 0)。 */
interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/** /chat/completions 非流式响应(只取我们用到的字段)。 */
interface OpenAiChatCompletion {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: OpenAiUsage;
}

/** SSE 流式增量(只取 delta.content 与末帧 usage)。 */
interface OpenAiChatChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
  usage?: OpenAiUsage;
}

/** 安全取整数 token(缺/非数 → 0)。 */
function tok(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

/** 从 OpenAI 兼容响应抠 Headers,供 errors.ts 读 retry-after(与 Anthropic readRetryAfter 兼容)。 */
function headersOf(res: Response): Headers {
  return res.headers;
}

/** 非 2xx → OpenRouterApiError(带 status + headers + 上游报文片段,仅入日志、不外泄)。 */
async function toApiError(res: Response): Promise<OpenRouterApiError> {
  let bodyText = '';
  try {
    bodyText = await res.text();
  } catch {
    /* 读取响应体失败不致命:status 已足够归一 */
  }
  return new OpenRouterApiError(res.status, headersOf(res), bodyText);
}

/**
 * 把任意传输异常归一到 OpenRouterApiError 语义:
 *   - AbortError(超时/取消)原样上抛(gateway 的超时哨兵 + errors.ts 的 abort 归一处理)。
 *   - 其它(网络/DNS/连接)→ status=undefined 的 OpenRouterApiError(归一为 retriable 上游失败)。
 */
function toTransportError(err: unknown): never {
  if (err instanceof Error && err.name === 'AbortError') {
    throw err;
  }
  throw new OpenRouterApiError(
    undefined,
    undefined,
    err instanceof Error ? err.message : String(err),
  );
}

/** 解析一行 SSE data 帧为 chunk;'[DONE]' / 空行 / 非 JSON → null(跳过)。 */
function parseSseData(line: string): OpenAiChatChunk | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice('data:'.length).trim();
  if (payload === '' || payload === '[DONE]') return null;
  try {
    return JSON.parse(payload) as OpenAiChatChunk;
  } catch {
    return null;
  }
}

/**
 * 读取 SSE 流(ReadableStream<Uint8Array>),逐帧产出 OpenAI 兼容 chunk。
 * 按 \n 切行、跨 read 边界缓冲半行;只认 data: 行。
 */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<OpenAiChatChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const chunk = parseSseData(line);
        if (chunk) yield chunk;
      }
    }
    // 收尾:缓冲里可能残留最后一行(无尾随 \n)。
    const tail = parseSseData(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/**
 * 构造一个 LlmSdkClient 形态的 OpenRouter 适配器。
 *   - messages.create(非流式 body) → Anthropic.Message 形态(content[text] + usage.input/output_tokens)。
 *   - messages.create(stream:true) → AsyncIterable<RawMessageStreamEvent>:
 *       先发 message_start(input_tokens),逐 content_block_delta(text_delta),末发 message_delta(output_tokens)。
 * 这样 gateway.ts 无需感知 provider 即可统一抽 text/usage。
 */
export function createOpenRouterClient(opts: OpenRouterClientOptions): LlmSdkClient {
  const baseUrl = (opts.baseUrl ?? OPENROUTER_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${baseUrl}/chat/completions`;

  // OpenAI 兼容请求头:Bearer key。OpenRouter 可选 HTTP-Referer/X-Title(非必填,省略亦可计量)。
  const baseHeaders: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${opts.apiKey}`,
  };

  /** 把网关给的 Anthropic 风格 body(messages/max_tokens)映射为 OpenAI /chat/completions body。 */
  function toChatBody(
    body: Anthropic.MessageCreateParamsNonStreaming | Anthropic.MessageCreateParamsStreaming,
    stream: boolean,
  ): Record<string, unknown> {
    // 网关只发 [{ role:'user', content: prompt(string) }];content 一律是 string(见 gateway complete/stream)。
    const messages = (body.messages ?? []).map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : '',
    }));
    const chatBody: Record<string, unknown> = {
      model: opts.model,
      max_tokens: body.max_tokens,
      messages,
      // 吞吐优先路由。实测(2026-07-05,deepseek-v4-flash 同 prompt 各 3 次):默认路由被分到
      // 21-90 tok/s 不等的供应商(尾延迟主因),sort:throughput 后稳定 105+ tok/s 且方差 <1s。
      provider: { sort: 'throughput' },
    };
    if (stream) {
      chatBody.stream = true;
      // 要 OpenRouter 在流末附带 usage(OpenAI 兼容扩展;缺省不发 usage)。
      chatBody.stream_options = { include_usage: true };
    }
    return chatBody;
  }

  async function createNonStreaming(
    body: Anthropic.MessageCreateParamsNonStreaming,
    options?: { signal?: AbortSignal },
  ): Promise<Anthropic.Message> {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: baseHeaders,
        body: JSON.stringify(toChatBody(body, false)),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      toTransportError(err);
    }
    if (!res.ok) throw await toApiError(res);

    let json: OpenAiChatCompletion;
    try {
      json = (await res.json()) as OpenAiChatCompletion;
    } catch (err) {
      // 2xx 但响应体非法 JSON:当上游失败处理(可重试)。
      throw new OpenRouterApiError(
        undefined,
        undefined,
        err instanceof Error ? err.message : 'bad json',
      );
    }
    const text = json.choices?.[0]?.message?.content ?? '';
    // 映射成 Anthropic.Message 形态:gateway extractText 读 content[].text、usage.input/output_tokens。
    return {
      id: 'openrouter',
      type: 'message',
      role: 'assistant',
      model: opts.model,
      stop_reason: 'end_turn',
      stop_sequence: null,
      content: [{ type: 'text', text } as Anthropic.TextBlock],
      usage: {
        input_tokens: tok(json.usage?.prompt_tokens),
        output_tokens: tok(json.usage?.completion_tokens),
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
    } as Anthropic.Message;
  }

  async function createStreaming(
    body: Anthropic.MessageCreateParamsStreaming,
    options?: { signal?: AbortSignal },
  ): Promise<AsyncIterable<Anthropic.RawMessageStreamEvent>> {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { ...baseHeaders, accept: 'text/event-stream' },
        body: JSON.stringify(toChatBody(body, true)),
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      toTransportError(err);
    }
    if (!res.ok) throw await toApiError(res);
    const stream = res.body;
    if (!stream) {
      // 流式建连成功但无 body(异常):当上游失败(可重试)。
      throw new OpenRouterApiError(undefined, undefined, 'openrouter stream missing body');
    }

    // 把 OpenAI 兼容 SSE chunk 翻译成 Anthropic RawMessageStreamEvent 序列。
    async function* translate(): AsyncGenerator<Anthropic.RawMessageStreamEvent> {
      let inputTokens = 0;
      let outputTokens = 0;
      let startEmitted = false;
      for await (const chunk of readSse(stream!)) {
        if (chunk.usage) {
          // OpenRouter 末帧 usage(stream_options.include_usage):记最终 token。
          inputTokens = tok(chunk.usage.prompt_tokens) || inputTokens;
          outputTokens = tok(chunk.usage.completion_tokens) || outputTokens;
        }
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          if (!startEmitted) {
            startEmitted = true;
            // gateway 在 message_start 读 input_tokens(此刻多为 0;末帧再以 message_delta 兜 output)。
            yield {
              type: 'message_start',
              message: { usage: { input_tokens: inputTokens } },
            } as unknown as Anthropic.RawMessageStreamEvent;
          }
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: delta },
          } as Anthropic.RawMessageStreamEvent;
        }
      }
      // 末帧:把最终 token 用量交给 gateway(message_delta.usage.output_tokens + message_start 已给 input)。
      yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: outputTokens, input_tokens: inputTokens },
      } as unknown as Anthropic.RawMessageStreamEvent;
    }

    return translate();
  }

  // 与 LlmSdkClient.messages.create 的重载签名对齐:stream:true → 流;否则非流。
  function create(
    body: Anthropic.MessageCreateParamsNonStreaming,
    options?: { signal?: AbortSignal },
  ): Promise<Anthropic.Message>;
  function create(
    body: Anthropic.MessageCreateParamsStreaming,
    options?: { signal?: AbortSignal },
  ): Promise<AsyncIterable<Anthropic.RawMessageStreamEvent>>;
  function create(
    body: Anthropic.MessageCreateParamsNonStreaming | Anthropic.MessageCreateParamsStreaming,
    options?: { signal?: AbortSignal },
  ): Promise<Anthropic.Message | AsyncIterable<Anthropic.RawMessageStreamEvent>> {
    if ((body as Anthropic.MessageCreateParamsStreaming).stream === true) {
      return createStreaming(body as Anthropic.MessageCreateParamsStreaming, options);
    }
    return createNonStreaming(body as Anthropic.MessageCreateParamsNonStreaming, options);
  }

  return { messages: { create } };
}
