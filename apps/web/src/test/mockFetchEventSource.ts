// 受控 MockFetchEventSource —— useSSE 组件测试的离线 SSE 驱动器（无运行后端）。
//
// 为什么换 mock（Codex r2 P1 #7）：旧 MockEventSource 用静态变量「掩盖」原生 EventSource 手动重建
// 无法带 Last-Event-ID 的缺陷——测试看着像续传，真实浏览器其实丢锚点。现 useSSE 改用
// @microsoft/fetch-event-source（Last-Event-ID 走显式请求头），本 mock 据此模拟**真实重连语义**：
//   - 每次 useSSE 发起一次 fetchEventSource(url, init) = 建一条「连接」；init.headers['Last-Event-ID']
//     就是这条连接的续传锚点（重连时 useSSE/库会带上当前 lastEventId）——测试直接断言它，不再靠静态变量。
//   - emit(type, payload, {id}) 触发该连接的 onmessage（带 id = Redis Stream entry id）。
//   - open()/errorDrop()/closeServer() 触发 onopen/onerror/onclose；onerror 返回的重连延迟由测试用假定时器推进。
//   - abort（useSSE 看门狗超时 / done / cleanup）：监听 init.signal 的 abort，标记该连接关闭、停止派发。
//
// 契约对齐（脊柱 §5）：12 个具名 event；首帧 state_snapshot；done 终止关流；Last-Event-ID 续传不重不漏。
import type { FetchEventSourceInit } from '@microsoft/fetch-event-source';
import type { EventSourceMessage } from '@microsoft/fetch-event-source';

/** 一条受控「连接」（= 一次 fetchEventSource 调用）。 */
export class MockSSEConnection {
  readonly url: string;
  readonly init: FetchEventSourceInit;
  /** 本连接建流时携带的 Last-Event-ID 头（续传锚点）；首连为 null。 */
  readonly lastEventIdAtOpen: string | null;
  /** 已 abort（看门狗/done/cleanup）则不再派发。 */
  aborted = false;
  /** 已 open。 */
  opened = false;
  /** 本连接最近派发帧的 id（供后续推进锚点）。 */
  private currentId = '';

  constructor(url: string, init: FetchEventSourceInit) {
    this.url = url;
    this.init = init;
    this.lastEventIdAtOpen = init.headers?.['Last-Event-ID'] ?? null;
    // 监听 abort：useSSE 看门狗超时/cleanup 会 abort signal。
    init.signal?.addEventListener('abort', () => {
      this.aborted = true;
    });
  }

  /**
   * 模拟连接打开（触发 onopen）。**onopen 同步调用**：happy path 的 dispatch('open') 同步生效，
   * 保留既有 `act(() => conn().open())` 同步断言（返回 void，不让 act 误入 async 模式）。
   * 建流前 HTTP 错误反向测试：onopen 是 async，其 rejection 在微任务里转 onerror——
   * 测试用 `await act(async () => { conn().open(errResponse); })` 即可 flush 到错误态（act 异步会清微任务）。
   *
   * 真实库语义：`await onopen(response)` 抛错 → create() 捕获后交给 onerror（onerror 抛致命错误则彻底停连，
   * 鉴权失败不重连）。本 mock 据此把 onopen 的 rejection 路由到 onerror，并吞掉 onerror 的致命抛出
   * （库自己消化它、不外溢给调用方），仅保留「进错误态 + 停连」副作用。
   */
  open(response?: Response): void {
    if (this.aborted) return;
    this.opened = true;
    const resp =
      response ??
      new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    void Promise.resolve(this.init.onopen?.(resp)).catch((err) => {
      try {
        this.init.onerror?.(err);
      } catch {
        /* onerror 抛致命错误 = 停止重连；不外溢 */
      }
    });
  }

  /** 派发一帧具名事件（带 JSON payload + id = Redis Stream entry id）。 */
  emit(type: string, payload: unknown, opts: { id?: string } = {}): void {
    if (this.aborted) return;
    if (opts.id !== undefined) this.currentId = opts.id;
    const msg: EventSourceMessage = {
      id: this.currentId,
      event: type,
      data: payload === undefined ? '' : JSON.stringify(payload),
    };
    this.init.onmessage?.(msg);
  }

  /** 模拟网络/流中断（触发 onerror）。返回 useSSE onerror 的重连延迟（库据此排重连）。 */
  errorDrop(err: unknown = new Error('network drop')): number | null | undefined | void {
    if (this.aborted) return;
    return this.init.onerror?.(err);
  }

  /** 模拟服务端正常关流（非 done；触发 onclose，库视为可重连）。 */
  closeServer(): void {
    if (this.aborted) return;
    this.init.onclose?.();
  }
}

/** fetchEventSource 的受控替身：每次调用 push 一条连接，测试拿 last 驱动它。 */
export class MockFetchEventSource {
  /** 所有「连接」（含已 abort），按发起序——验证重连建了新连接 + 带正确续传锚点。 */
  static connections: MockSSEConnection[] = [];

  static reset(): void {
    MockFetchEventSource.connections = [];
  }

  /** 最近一条（活跃）连接：重连后这就是新连接。 */
  static get last(): MockSSEConnection | undefined {
    return MockFetchEventSource.connections[MockFetchEventSource.connections.length - 1];
  }

  /** 注入给 __setFetchEventSourceForTests 的实现：返回一个永不自然 resolve 的 Promise（流持续）。 */
  static readonly impl = (input: RequestInfo, init: FetchEventSourceInit): Promise<void> => {
    const conn = new MockSSEConnection(String(input), init);
    MockFetchEventSource.connections.push(conn);
    // fetchEventSource 真实语义：返回的 Promise 在 abort / onerror 抛致命错误时才 settle。
    return new Promise<void>((resolve) => {
      init.signal?.addEventListener('abort', () => resolve());
    });
  };
}
