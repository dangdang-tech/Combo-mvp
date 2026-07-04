// B-06 · 用量/计费计量记账(落 audit_llm_calls；非计费真源，70 §8.3)。
//   每次 LLM 调用(成功/降级)记 tokens/cost/retries/degraded，供成本审计。
//   生产落 PG audit_llm_calls(同事务非必须——审计非计费真源，失败不阻塞主流程)；
//   本期提供 no-op + 内存收集器(单测断言用)，PG 仓储留 Phase 接(诚实推迟)。
import type { LlmAuditSink, LlmAuditRecord } from './types.js';

/** 不落库的审计端口(无 PG 直跑/冒烟用；记账丢失不致命，审计非计费真源)。 */
export const noopAuditSink: LlmAuditSink = {
  record: () => undefined,
};

/** 内存审计收集器(单测断言记账内容用；生产勿用)。 */
export function createMemoryAuditSink(): LlmAuditSink & { records: LlmAuditRecord[] } {
  const records: LlmAuditRecord[] = [];
  return {
    records,
    record(entry: LlmAuditRecord) {
      records.push(entry);
    },
  };
}

/** PG audit_llm_calls 仓储(实现注入 db.query)。审计写入失败只记日志、不抛(不阻塞主流程)。 */
export interface QueryableDb {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

const INSERT_AUDIT_SQL = `
  INSERT INTO audit_llm_calls
    (owner_user_id, task_id, task_class, model,
     prompt_tokens, completion_tokens, cost_micros, degraded, retries, trace_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
`;

/**
 * PG 审计端口：把记账写入 audit_llm_calls(70 §8.3 DDL)。
 * 写入失败不抛(审计非计费真源、漏记不致命)——只交给 onError 回调(通常落日志)。
 */
export function createPgAuditSink(
  db: QueryableDb,
  onError?: (err: unknown, entry: LlmAuditRecord) => void,
): LlmAuditSink {
  return {
    async record(entry: LlmAuditRecord) {
      try {
        await db.query(INSERT_AUDIT_SQL, [
          entry.ownerUserId ?? null,
          entry.taskId ?? null,
          entry.taskClass,
          entry.model,
          entry.promptTokens,
          entry.completionTokens,
          entry.costMicros,
          entry.degraded,
          entry.retries,
          entry.traceId,
        ]);
      } catch (err) {
        // 审计失败不阻塞主流程(非计费真源)；交回调记日志。
        onError?.(err, entry);
      }
    },
  };
}
