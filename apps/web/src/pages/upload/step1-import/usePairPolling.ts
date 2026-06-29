// 配对状态轮询 hook（F-10）——铸码后按 2s 节奏轮询 /import/connect/pair/{id}，拿到 jobId 即停。
//
// 永不裸转圈：轮询期 status 持续暴露给 CommandBox 渲染会话状态（waiting/uploading）；
//   phase=job_created 停轮询并回 jobId（上层转 SSE）；expired 停轮询给「重新生成」引导；
//   轮询请求失败不立即报错（瞬断容忍）——保留上次 status 继续下一拍，避免一次抖动就打断配对。
import { useEffect, useRef, useState } from 'react';
import type { PairStatusView } from '@cb/shared';
import { fetchPairStatus } from './importApi.js';

/** 轮询间隔（20 §3.4 建议 2s）。 */
export const PAIR_POLL_INTERVAL_MS = 2_000;

export interface UsePairPollingResult {
  /** 最新轮询到的状态（首拍前为 undefined，CommandBox 按 waiting 渲染）。 */
  status: PairStatusView | undefined;
  /** phase=job_created 时给出 jobId（上层转 SSE）。 */
  jobId: string | undefined;
}

/**
 * 轮询某配对会话状态。pairId 为 undefined（未铸码）时不轮询。
 * 命中 job_created / expired 即停（终态，不再无意义轮询）。
 */
export function usePairPolling(pairId: string | undefined): UsePairPollingResult {
  const [status, setStatus] = useState<PairStatusView | undefined>(undefined);
  const [jobId, setJobId] = useState<string | undefined>(undefined);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!pairId) {
      setStatus(undefined);
      setJobId(undefined);
      return;
    }
    let active = true;
    const ctrl = new AbortController();

    const clear = (): void => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const tick = async (): Promise<void> => {
      try {
        const next = await fetchPairStatus(pairId, { signal: ctrl.signal });
        if (!active) return;
        setStatus(next);
        if (next.phase === 'job_created' && next.jobId) {
          setJobId(next.jobId);
          return; // 终态：停轮询，上层转 SSE。
        }
        if (next.phase === 'expired') return; // 终态：停轮询，给重新生成引导。
      } catch (e) {
        // 瞬断容忍：abort 直接退出；其余忽略本拍、下拍再试（不一抖就报错打断配对）。
        if (e instanceof DOMException && e.name === 'AbortError') return;
        if (!active) return;
      }
      timerRef.current = setTimeout(() => void tick(), PAIR_POLL_INTERVAL_MS);
    };

    void tick();
    return () => {
      active = false;
      ctrl.abort();
      clear();
    };
  }, [pairId]);

  return { status, jobId };
}
