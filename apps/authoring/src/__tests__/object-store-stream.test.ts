// P0 回归（live E2E 抓到、旧单测 mock 盖住）：S3 getObject 的 Body 在 Node 运行时是 **Node Readable**
//   （AWS SDK v3 + Node：底层 IncomingMessage/Readable，**无** .getReader）。旧实现把它当 web ReadableStream
//   调 stream.getReader() → `body.getReader is not a function` → import fetch_index 必败 → DEPENDENCY_UNAVAILABLE。
//
// 本测试用真实 Node Readable / web ReadableStream / SdkStream 喂统一读法 readStreamToString，断言正确读出文本；
//   并【反向破坏】证明旧的 web 流 getReader() 读法对 Node Readable 会抛 TypeError（即能抓到本 bug）。
import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { readStreamToString } from '../platform/infra/object-store.js';

const SAMPLE = '{"role":"user","content":"héllo 世界 🌍"}\n{"role":"assistant","content":"hi"}\n';

describe('readStreamToString — 统一正确读法（P0 fetch_index getReader 回归）', () => {
  it('真实 Node Readable（生产真值：S3 Body 在 Node 下的形态）→ 正确读出 utf-8 字符串', async () => {
    const stream = Readable.from([Buffer.from(SAMPLE, 'utf-8')]);
    const text = await readStreamToString(stream);
    expect(text).toBe(SAMPLE);
  });

  it('Node Readable 多块（含跨块的多字节 UTF-8）→ 不乱码（流式解码）', async () => {
    // 把多字节字符（世界 🌍）的字节切到两个 chunk 边界中间，验证流式 TextDecoder 跨块拼接正确。
    const bytes = Buffer.from(SAMPLE, 'utf-8');
    const mid = Math.floor(bytes.length / 2);
    const stream = Readable.from([bytes.subarray(0, mid), bytes.subarray(mid)]);
    const text = await readStreamToString(stream);
    expect(text).toBe(SAMPLE);
  });

  it('web ReadableStream（跨运行时/未来兼容）→ 仍能正确读出', async () => {
    const web = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(SAMPLE));
        controller.close();
      },
    });
    const text = await readStreamToString(web);
    expect(text).toBe(SAMPLE);
  });

  it('SdkStream（AWS SDK 经 sdkStreamMixin 注入 transformToString）→ 优先走 SDK transform', async () => {
    // 模拟 SDK Body：Node Readable 上挂 transformToString（SDK 跨运行时保证的最稳读法）。
    const base = Readable.from([Buffer.from('via-sdk-transform', 'utf-8')]);
    const sdkStream = Object.assign(base, {
      transformToString: async (_enc?: string): Promise<string> => 'via-sdk-transform',
    });
    const text = await readStreamToString(sdkStream);
    expect(text).toBe('via-sdk-transform');
  });

  it('空/边界：null → 空串；string 透传；Uint8Array 解码', async () => {
    expect(await readStreamToString(null)).toBe('');
    expect(await readStreamToString('already-text')).toBe('already-text');
    expect(await readStreamToString(new TextEncoder().encode('bytes'))).toBe('bytes');
  });

  it('反向破坏：旧实现 stream.getReader() 对真实 Node Readable 会抛 TypeError（证明本测试能抓到 P0 bug）', async () => {
    const stream = Readable.from([Buffer.from(SAMPLE, 'utf-8')]);
    // Node Readable 没有 .getReader（web 流才有）——旧 import.ts readStreamToString 第一行就是这句。
    expect(() => (stream as unknown as ReadableStream).getReader()).toThrow(TypeError);
    // 同时确认它确实是 undefined（不是别的可调用）。
    expect((stream as unknown as { getReader?: unknown }).getReader).toBeUndefined();
  });
});
