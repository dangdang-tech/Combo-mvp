// B-21 自检（20-step1-import §3，mock PG/对象存储/队列，无真实例）：
//   - 纯逻辑：6 位码 CSPRNG + 左补零、command 注入 BASE+code、curlOneLiner 恒定、脚本口径合规（无禁词）。
//   - pairings-repo：mintPairing 只存 hash、recordPartLanded 受保护推进、createImportJobForPairing 建 job+回写+幂等回放。
//   - 路由 handler：connectPair 201、connectScript active/expired、connectUpload uploading/job_created/空/已用、
//     connectPairStatus owner 校验 + 过期折算 expired；判别联合形态（uploading 无 jobId、job_created 必含 jobId+eventsUrl）。
//   - 文案合规：所有对外 userMessage 过 lintUserMessage（脊柱 §3.1/§11.B，无 code/堆栈/状态码）。
import { describe, it, expect, vi } from 'vitest';
import { lintUserMessage, SSE_ROUTES } from '@cb/shared';
import { hashPairingCode } from '../middleware/pair-auth.js';
import {
  buildConnectCommand,
  createImportJobForPairing,
  CURL_ONE_LINER,
  generatePairingCode,
  mintPairing,
  readPairingStatus,
  recordPartLanded,
} from '../import/pairings-repo.js';
import { renderConnectScript, renderExpiredScript } from '../import/connect-script.js';
import { readPairingManifest } from '../import/pairings-repo.js';
import {
  connectPairHandler,
  connectPairStatusHandler,
  connectScriptHandler,
  connectUploadHandler,
} from '../routes/import-connect.js';
import type { QueryResultLike } from '../jobs/types.js';

// ───────────────────────── 内存 import_pairings + jobs 假库 ─────────────────────────

interface PairingRow {
  id: string;
  owner_user_id: string;
  pairing_code_hash: string;
  phase: string;
  upload_id: string | null;
  job_id: string | null;
  uploaded_parts: number;
  total_parts: number | null;
  landed_parts: Record<string, { key: string; hash: string }>;
  draft_id: string | null;
  attempt_count: number;
  max_attempts: number;
  expires_at: number; // epoch ms
  used_at: number | null;
}
interface JobRow {
  id: string;
  type: string;
  status: string;
  owner_user_id: string;
  subject_ref: unknown;
  progress?: unknown;
  fence_token: number;
  attempt_no: number;
  created_at: string;
}

let pairSeq = 0;
let jobSeq = 0;

class FakePairDb {
  readonly pairings = new Map<string, PairingRow>();
  readonly jobs = new Map<string, JobRow>();
  now = 1_000_000;
  readonly queries: string[] = [];

  seedPairing(over: Partial<PairingRow> = {}): PairingRow {
    pairSeq += 1;
    const row: PairingRow = {
      id: `pair-${pairSeq}`,
      owner_user_id: 'creator-1',
      pairing_code_hash: hashPairingCode('000000'),
      phase: 'waiting',
      upload_id: null,
      job_id: null,
      uploaded_parts: 0,
      total_parts: null,
      landed_parts: {},
      draft_id: null,
      attempt_count: 0,
      max_attempts: 5,
      expires_at: this.now + 20 * 60 * 1000,
      used_at: null,
      ...over,
    };
    this.pairings.set(row.id, row);
    return row;
  }

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResultLike<R>> {
    this.queries.push(sql);
    const now = this.now;

    // —— mintPairing：INSERT INTO import_pairings ... ON CONFLICT (pairing_code_hash) WHERE ... DO NOTHING RETURNING ——
    if (sql.includes('INSERT INTO import_pairings')) {
      const ownerUserId = params[0] as string;
      const codeHash = params[1] as string;
      const draftId = params[2] as string | null;
      const ttlMs = Number(params[3]);
      // active 唯一：若已有 active 行同 hash → DO NOTHING（0 行）。
      const collide = [...this.pairings.values()].some(
        (p) =>
          p.pairing_code_hash === codeHash &&
          p.used_at === null &&
          (p.phase === 'waiting' || p.phase === 'uploading'),
      );
      if (collide) return { rows: [], rowCount: 0 };
      pairSeq += 1;
      const id = `pair-${pairSeq}`;
      const expiresAt = now + ttlMs;
      this.pairings.set(id, {
        id,
        owner_user_id: ownerUserId,
        pairing_code_hash: codeHash,
        phase: 'waiting',
        upload_id: null,
        job_id: null,
        uploaded_parts: 0,
        total_parts: null,
        landed_parts: {},
        draft_id: draftId,
        attempt_count: 0,
        max_attempts: 5,
        expires_at: expiresAt,
        used_at: null,
      });
      return {
        rows: [{ id, expires_at: new Date(expiresAt).toISOString() }] as R[],
        rowCount: 1,
      };
    }

    // —— connectScript 反查 pairId：SELECT id FROM import_pairings WHERE pairing_code_hash=$1 AND active ——
    if (sql.includes('SELECT id FROM import_pairings') && sql.includes('pairing_code_hash = $1')) {
      const codeHash = params[0] as string;
      const found = [...this.pairings.values()].find(
        (p) =>
          p.pairing_code_hash === codeHash &&
          p.used_at === null &&
          (p.phase === 'waiting' || p.phase === 'uploading') &&
          p.expires_at > now,
      );
      return { rows: found ? ([{ id: found.id }] as R[]) : [], rowCount: found ? 1 : 0 };
    }

    // —— readPairingStatus：SELECT owner_user_id, phase, job_id, uploaded_parts, total_parts, (expires_at<=now) ——
    if (
      sql.includes('FROM import_pairings') &&
      sql.includes('uploaded_parts') &&
      sql.includes('expires_at <= now()')
    ) {
      const p = this.pairings.get(params[0] as string);
      if (!p) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            owner_user_id: p.owner_user_id,
            phase: p.phase,
            job_id: p.job_id,
            uploaded_parts: p.uploaded_parts,
            total_parts: p.total_parts,
            expired: p.expires_at <= now,
          },
        ] as R[],
        rowCount: 1,
      };
    }

    // —— recordPartLanded：UPDATE import_pairings SET phase='uploading', landed_parts=jsonb_set(...) ... RETURNING landed_parts,total_parts ——
    if (sql.includes("phase          = 'uploading'") && sql.includes('landed_parts')) {
      const p = this.pairings.get(params[0] as string);
      if (!p || (p.phase !== 'waiting' && p.phase !== 'uploading') || p.expires_at <= now) {
        return { rows: [], rowCount: 0 };
      }
      const partIndex = params[1] as string;
      const entry = JSON.parse(params[2] as string) as { key: string; hash: string };
      const totalParts = params[3] as number | null;
      p.phase = 'uploading';
      p.landed_parts = { ...p.landed_parts, [partIndex]: entry };
      p.uploaded_parts = Object.keys(p.landed_parts).length;
      if (totalParts !== null) p.total_parts = totalParts;
      // 受保护更新【不置 used_at】（Codex P1-4：多分片途中可续传）。
      return {
        rows: [{ landed_parts: p.landed_parts, total_parts: p.total_parts }] as R[],
        rowCount: 1,
      };
    }

    // —— readPairingManifest：SELECT landed_parts, total_parts FROM import_pairings WHERE active ——
    if (sql.includes('SELECT landed_parts, total_parts') && sql.includes('FROM import_pairings')) {
      const p = this.pairings.get(params[0] as string);
      if (!p || (p.phase !== 'waiting' && p.phase !== 'uploading') || p.expires_at <= now) {
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: [{ landed_parts: p.landed_parts, total_parts: p.total_parts }] as R[],
        rowCount: 1,
      };
    }

    // —— createImportJobForPairing step1：SELECT job_id, phase, draft_id FROM import_pairings WHERE id=$1 ——
    //   （P0-2：同读 draft_id，建 job 时随 subject_ref.draftId 流到 worker → 完成回填该草稿 snapshot_id。）
    if (sql.includes('job_id, phase') && sql.includes('FROM import_pairings WHERE id')) {
      const p = this.pairings.get(params[0] as string);
      return {
        rows: p ? ([{ job_id: p.job_id, phase: p.phase, draft_id: p.draft_id }] as R[]) : [],
        rowCount: p ? 1 : 0,
      };
    }

    // —— createImportJobForPairing 回放分支：SELECT attempt_no, created_at FROM jobs WHERE id=$1 ——
    if (sql.includes('SELECT attempt_no, created_at FROM jobs')) {
      const j = this.jobs.get(params[0] as string);
      return {
        rows: j ? ([{ attempt_no: j.attempt_no, created_at: j.created_at }] as R[]) : [],
        rowCount: j ? 1 : 0,
      };
    }

    // —— readJobViewForRecovery（终态恢复短路用，Codex P1-r6）：SELECT id, status, progress, attempt_no, created_at FROM jobs WHERE id=$1 AND owner_user_id=$2 AND type='import' ——
    if (
      sql.includes('FROM jobs') &&
      sql.includes('attempt_no, created_at') &&
      sql.includes("type = 'import'")
    ) {
      const jobId = params[0] as string;
      const owner = params[1] as string;
      const j = this.jobs.get(jobId);
      if (!j || j.owner_user_id !== owner || j.type !== 'import') return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            id: j.id,
            status: j.status,
            progress: j.progress ?? null,
            attempt_no: j.attempt_no,
            created_at: j.created_at,
          },
        ] as R[],
        rowCount: 1,
      };
    }

    // —— createImportJobForPairing step2：建 job + 兑换 + 回写 job_id（data-modifying CTE）——
    //   忠实真实 PG 语义：**每个 data-modifying CTE 都执行**，与最终 SELECT 是否引用它无关（Codex P1-r2）；
    //     且**单语句二次改同一行不可靠**：同一条 SQL 里第二个 UPDATE 看到的是语句开始的行快照，
    //     不会可靠地命中已被前一个 CTE 改过的同一行（Codex P1-r4）——本 mock 据此对「旧两次 UPDATE」形态
    //     模拟「第二次回写 job_id 不生效」，从而能抓到「phase='job_created' 但 job_id IS NULL」的不变式破坏。
    //   逐 CTE 解释执行（按本实现的 SQL 形态判别新/旧）：
    //     · 新实现（Codex P1-r4）：active = SELECT ... FOR UPDATE 守门（仅产出 active 行，不写）；
    //         new_job = INSERT ... SELECT FROM active（active 空→0 行，不建孤儿）；
    //         redeemed = **单次** UPDATE 同时写 phase/used_at/job_id（一行只改一次 → job_id 与 phase 同写、绝不脱节）。
    //     · 旧 buggy（Codex r4 命中）：linked = UPDATE 先兑换 phase/used_at；link_job = **二次** UPDATE 同一行回写 job_id
    //         （真实 PG 不可靠 → mock 模拟 job_id 不落回 → 留下 job_created+job_id=null 的破坏，被回归测抓住）。
    //     · 更旧（Codex P1-r2）：INSERT ... VALUES 不依赖守门 → 即使未命中 active 仍无条件建 1 行孤儿 job。
    if (sql.includes('INSERT INTO jobs') && sql.includes('import_pairings')) {
      const pairId = params[0] as string;
      const ownerUserId = params[1] as string;
      const subjectRef = JSON.parse(params[2] as string);
      const p = this.pairings.get(pairId);
      const createdAt = new Date(now).toISOString();

      // 完整 active predicate（Codex P1-r3）：phase 可兑换 AND used_at IS NULL AND expires_at>now() AND attempt_count<max_attempts。
      const isActive = Boolean(
        p &&
        (p.phase === 'waiting' || p.phase === 'uploading') &&
        p.used_at === null &&
        p.expires_at > now &&
        p.attempt_count < p.max_attempts,
      );

      // —— 形态判别（截 INSERT 子句到其 RETURNING 前，避免被末尾 SELECT 干扰）——
      const insertClause = sql.slice(
        sql.indexOf('INSERT INTO jobs'),
        sql.indexOf('RETURNING', sql.indexOf('INSERT INTO jobs')),
      );
      const insertUsesValues = /\bVALUES\b/i.test(insertClause); // 旧旧：INSERT...VALUES（不依赖守门）
      // 新实现以 active 守门 CTE 为数据源；旧实现以 linked（UPDATE）为数据源。统一：守门命中 = isActive。
      const gateHit = isActive;

      // ① 守门 CTE（active SELECT FOR UPDATE / linked UPDATE）。旧 linked 在此即兑换 phase/used_at（第一次改行）。
      const usesLinkedUpdate = /linked AS \(\s*UPDATE/.test(sql); // 旧 buggy：守门是 UPDATE（先兑换）
      if (gateHit && usesLinkedUpdate && p) {
        p.phase = 'job_created';
        p.used_at = now; // 旧实现第一次 UPDATE 即置 phase/used_at（此时 job_id 仍未回写）。
      }

      // ② new_job：INSERT 行数。VALUES（不依赖守门）无条件 1 行；SELECT FROM active/linked 则 = 守门命中数。
      const insertCount = insertUsesValues ? 1 : gateHit ? 1 : 0;
      let firstJobId: string | null = null;
      const firstCreatedAt = createdAt;
      for (let i = 0; i < insertCount; i += 1) {
        jobSeq += 1;
        const jobId = `job-${jobSeq}`;
        this.jobs.set(jobId, {
          id: jobId,
          type: 'import',
          status: 'queued',
          owner_user_id: ownerUserId,
          subject_ref: subjectRef,
          fence_token: 1,
          attempt_no: 0,
          created_at: createdAt,
        });
        if (firstJobId === null) firstJobId = jobId;
      }

      // ③ 末尾 UPDATE 回写。
      if (gateHit && p && firstJobId !== null) {
        if (usesLinkedUpdate) {
          // 旧 buggy：这是对同一行的【第二次】UPDATE（同语句二次改同一行）。
          //   忠实真实 PG：第二次改不可靠——模拟 job_id **不落回**（phase 已被第一次置 job_created，job_id 留 null）。
          //   → 留下 phase='job_created' AND job_id IS NULL 的不变式破坏（回归测据此抓到旧实现）。
          /* 故意不写 p.job_id：模拟二次 UPDATE 未命中已改行 */
        } else {
          // 新实现（Codex P1-r4）：单次 UPDATE 一并写 phase/used_at/job_id（一行只改一次 → 三列同时落）。
          p.phase = 'job_created';
          p.used_at = now;
          p.job_id = firstJobId;
        }
      }

      // 最终 SELECT id, fence_token, attempt_no, created_at FROM new_job —— 返回 INSERT 的所有行。
      if (insertCount === 0 || firstJobId === null) return { rows: [], rowCount: 0 };
      return {
        rows: [
          { id: firstJobId, fence_token: 1, attempt_no: 0, created_at: firstCreatedAt },
        ] as R[],
        rowCount: 1,
      };
    }

    throw new Error(`FakePairDb: unhandled SQL: ${sql.slice(0, 80)}`);
  }
}

// ───────────────────────── req/reply 夹具 ─────────────────────────

function makeReply() {
  const sent: { code: number; headers: Record<string, string>; body: unknown } = {
    code: 0,
    headers: {},
    body: undefined,
  };
  const reply = {
    code(c: number) {
      sent.code = c;
      return this;
    },
    header(k: string, v: string) {
      sent.headers[k] = v;
      return this;
    },
    send(b: unknown) {
      sent.body = b;
      return this;
    },
  };
  return { reply, sent };
}

/** 共享 FakeObjectStore（记录 putObject 落桶；可注入 failPut）。 */
class FakeStore {
  failPut = false;
  readonly puts: Array<{ key: string; bytes: number }> = [];
  async putObject(_bucket: string, key: string, body: Uint8Array): Promise<{ key: string }> {
    if (this.failPut) throw new Error('s3 put failure');
    this.puts.push({ key, bytes: body.length });
    return { key };
  }
}

function baseReq(db: FakePairDb, over: Record<string, unknown> = {}) {
  return {
    id: 'trace-1',
    headers: { host: 'agora.app', 'x-forwarded-proto': 'https' },
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    protocol: 'https',
    query: {},
    server: {
      infra: {
        db,
        objectStore: new FakeStore(),
        queue: { enqueue: vi.fn(async () => undefined), remove: vi.fn() },
      },
    },
    ...over,
  };
}

/**
 * 模拟一次 multipart 上传请求（parts() 异步迭代器）。
 *   协议：pairId/partIndex/totalParts/source 走 query（Codex P0-1/P1-5），原文走 multipart 文件域。
 *   pairId 由 PairAuth 注入 req.pairAuth（测试直接设），这里把 partIndex/totalParts/source 灌进 req.query。
 */
function withMultipart(
  req: Record<string, unknown>,
  fields: { source?: string; partIndex?: string; totalParts?: string },
  fileBytes: Buffer | null,
): Record<string, unknown> {
  async function* parts() {
    if (fileBytes !== null) {
      async function* fileGen() {
        yield fileBytes as Buffer;
      }
      yield { type: 'file', fieldname: 'file', file: fileGen() };
    }
  }
  const query: Record<string, string> = { ...((req.query as Record<string, string>) ?? {}) };
  if (fields.source !== undefined) query.source = fields.source;
  if (fields.partIndex !== undefined) query.partIndex = fields.partIndex;
  if (fields.totalParts !== undefined) query.totalParts = fields.totalParts;
  return { ...req, query, parts };
}

function errBody(sent: { body: unknown }): { userMessage: string; action: string } {
  return (sent.body as { error: { userMessage: string; action: string } }).error;
}

// ───────────────────────── 纯逻辑 ─────────────────────────

describe('B-21 纯逻辑', () => {
  it('generatePairingCode 恒 6 位数字（含左补零）', () => {
    for (let i = 0; i < 200; i += 1) {
      const c = generatePairingCode();
      expect(c).toMatch(/^\d{6}$/);
    }
  });

  it('buildConnectCommand 注入 BASE+code、去尾斜杠、走 sh', () => {
    expect(buildConnectCommand('https://agora.app/', '123456')).toBe(
      'curl -fsSL https://agora.app/api/v1/import/connect/script?code=123456 | sh',
    );
  });

  it('curlOneLiner 恒为验收口径固定串（导入-03/24）', () => {
    expect(CURL_ONE_LINER).toBe('curl -fsSL agora.app/import | sh');
  });

  it('助手脚本口径合规：sh+curl、注入 pairId/code、query 协议、per-part 幂等键、完整上传，绝不含禁词（导入-04/05/29）', () => {
    const script = renderConnectScript({
      base: 'https://agora.app',
      pairId: 'pair-1',
      pairingCode: '654321',
    });
    // 执行器为 sh（命令行优先方案·第一步）。
    expect(script).toContain('#!/bin/sh');
    // 注入正确（单引号安全注入）。
    expect(script).toContain("'pair-1'");
    expect(script).toContain("'654321'");
    expect(script).toContain('/api/v1/import/connect/upload');
    expect(script).toContain('Bearer');
    // 打包 + gzip：整文件拼进分片、gzip 压缩再传（用户实测 7370 文件「一文件一请求」太慢）；上传分片文件 ${pf}。
    expect(script).toContain('curl');
    expect(script).toContain('-F "file=@${pf}"');
    expect(script).toContain('SENTINEL=');
    expect(script).toContain('__AGORA_FILE_BOUNDARY__');
    expect(script).toContain('打包');
    expect(script).toContain('gzip -c');
    expect(script).toContain('part-${PART}.gz');
    // 打包阶段也报进度（大量文件不静默）。
    expect(script).toContain('正在打包… 已处理');
    // 上传直连、不走代理（需求 3）。
    expect(script).toContain("--noproxy '*'");
    // 跟随 80→443 跳转并在同源重定向重发鉴权（BASE 万一是 http 也能传，用户实测修复）。
    expect(script).toContain('--location-trusted');
    // 裸变量紧跟中文标点会在 macOS bash 崩；必须大括号包裹，绝不出现 $http）。
    expect(script).not.toContain('$http）');
    // 并发上传池（用户实测串行太慢）：默认路数可 AGORA_JOBS 覆盖。
    expect(script).toContain('AGORA_JOBS');
    expect(script).toContain('upload_one');
    expect(script).toContain('wait');
    // pairId/partIndex/totalParts/contentSha256 走 query（Codex P0-1）。
    expect(script).toContain('pairId=${PAIR_ID}');
    expect(script).toContain('partIndex=${idx}');
    expect(script).toContain('contentSha256=${sha}');
    // per-part 幂等键含 partIndex + 内容 hash（Codex P1-5）。
    expect(script).toContain('pair-${PAIR_ID}-${idx}-${sha}');
    // 扫两个子目录的 .jsonl。
    expect(script).toContain('.claude/projects');
    expect(script).toContain('.codex/sessions');
    expect(script).toContain("-name '*.jsonl'");
    // 正向口径（完整上传 + 云端去敏）。
    expect(script).toContain('完整上传');
    // 负向禁词（导入-05/29 P0）。
    const forbidden = [
      '数据不出本机',
      '仅上传精简',
      '原始日志不出本机',
      '解析在你浏览器',
      '本机本地完成',
      '只上传提取后',
    ];
    for (const f of forbidden) expect(script).not.toContain(f);
  });

  it('过期脚本片段：人话 stderr、非零退出、不裸 JSON 错误码', () => {
    const s = renderExpiredScript();
    expect(s).toContain('#!/bin/sh');
    expect(s).toContain('配对码已失效');
    expect(s).toContain('exit 1');
    expect(s).not.toContain('"error"');
    expect(s).not.toContain('NOT_FOUND');
  });
});

// ───────────────────────── pairings-repo ─────────────────────────

describe('mintPairing（只存 hash，明文返一次，Codex#15）', () => {
  it('插入一行 active 配对，返回 pairId+明文码+过期；库里只存 hash 不存明文', async () => {
    const db = new FakePairDb();
    const minted = await mintPairing(db, { ownerUserId: 'creator-9' });
    expect(minted.pairId).toMatch(/^pair-/);
    expect(minted.pairingCode).toMatch(/^\d{6}$/);
    const row = db.pairings.get(minted.pairId)!;
    expect(row.owner_user_id).toBe('creator-9');
    expect(row.phase).toBe('waiting');
    // 库里存的是 hash，且 = hash(明文)；绝不等于明文。
    expect(row.pairing_code_hash).toBe(hashPairingCode(minted.pairingCode));
    expect(row.pairing_code_hash).not.toBe(minted.pairingCode);
  });

  it('挂接 draftId 落库', async () => {
    const db = new FakePairDb();
    const minted = await mintPairing(db, { ownerUserId: 'c', draftId: 'draft-7' });
    expect(db.pairings.get(minted.pairId)!.draft_id).toBe('draft-7');
  });
});

describe('recordPartLanded（受保护登记 manifest，多分片协议）', () => {
  it('active 配对首片落地 → phase=uploading + manifest 登记 + 【不置 used_at】（Codex P1-4）', async () => {
    const db = new FakePairDb();
    const p = db.seedPairing();
    const r = await recordPartLanded(db, {
      pairId: p.id,
      partIndex: 0,
      s3Key: 'raw/c/p/part-0',
      contentSha256: 'h0',
      totalParts: 3,
    });
    expect(r.recorded).toBe(true);
    expect(p.phase).toBe('uploading');
    expect(r.uploadedParts).toBe(1);
    expect(r.totalParts).toBe(3);
    expect(r.complete).toBe(false); // 3 片只到 1 片
    expect(p.used_at).toBeNull(); // used_at 不在分片途中置（Codex P1-4：后续片不被拒）
    expect(p.landed_parts['0']).toEqual({ key: 'raw/c/p/part-0', hash: 'h0' });
  });

  it('多分片全到齐 → complete=true + 有序 rawS3Keys（Codex P1-8）', async () => {
    const db = new FakePairDb();
    const p = db.seedPairing();
    await recordPartLanded(db, {
      pairId: p.id,
      partIndex: 0,
      s3Key: 'k0',
      contentSha256: 'h0',
      totalParts: 3,
    });
    await recordPartLanded(db, {
      pairId: p.id,
      partIndex: 2,
      s3Key: 'k2',
      contentSha256: 'h2',
      totalParts: 3,
    });
    const r = await recordPartLanded(db, {
      pairId: p.id,
      partIndex: 1,
      s3Key: 'k1',
      contentSha256: 'h1',
      totalParts: 3,
    });
    expect(r.uploadedParts).toBe(3);
    expect(r.complete).toBe(true);
    const manifest = await readPairingManifest(db, p.id);
    expect(manifest!.rawS3Keys).toEqual(['k0', 'k1', 'k2']); // 按 partIndex 有序
    // used_at 在登记阶段仍未置（兑换才置）。
    expect(p.used_at).toBeNull();
  });

  it('单片无 totalParts → 视作 1 片即 complete', async () => {
    const db = new FakePairDb();
    const p = db.seedPairing();
    const r = await recordPartLanded(db, {
      pairId: p.id,
      partIndex: 0,
      s3Key: 'k0',
      contentSha256: 'h0',
    });
    expect(r.complete).toBe(true);
  });

  it('已终态/过期配对 → recorded=false（0 行，不登记）', async () => {
    const db = new FakePairDb();
    const done = db.seedPairing({ phase: 'job_created' });
    expect(
      (
        await recordPartLanded(db, {
          pairId: done.id,
          partIndex: 0,
          s3Key: 'k',
          contentSha256: 'h',
        })
      ).recorded,
    ).toBe(false);
    const expired = db.seedPairing({ expires_at: db.now - 1 });
    expect(
      (
        await recordPartLanded(db, {
          pairId: expired.id,
          partIndex: 0,
          s3Key: 'k',
          contentSha256: 'h',
        })
      ).recorded,
    ).toBe(false);
  });
});

describe('createImportJobForPairing（建 job + 回写 + 兑换 used_at + 幂等回放）', () => {
  it('active 配对 → 建 import job（subject 带 rawS3Keys）、回写 job_created、置 used_at、fenceToken>0', async () => {
    const db = new FakePairDb();
    const p = db.seedPairing({ phase: 'uploading' });
    const created = await createImportJobForPairing(db, {
      pairId: p.id,
      ownerUserId: 'creator-1',
      source: 'mixed',
      rawS3Keys: ['raw/c/p/part-0', 'raw/c/p/part-1'],
    });
    expect(created).not.toBeNull();
    expect(created!.fenceToken).toBeGreaterThan(0);
    expect(typeof created!.attemptNo).toBe('number');
    expect(created!.createdAt).toBeTruthy();
    const job = db.jobs.get(created!.jobId)!;
    expect(job.type).toBe('import');
    expect(job.status).toBe('queued');
    expect(job.owner_user_id).toBe('creator-1');
    // subject_ref 带 rawS3Keys（worker 据此拉原文，Codex P0-2）。
    expect((job.subject_ref as { rawS3Keys: string[] }).rawS3Keys).toEqual([
      'raw/c/p/part-0',
      'raw/c/p/part-1',
    ]);
    expect(p.phase).toBe('job_created');
    expect(p.job_id).toBe(created!.jobId);
    expect(p.used_at).not.toBeNull(); // 兑换时置 used_at（Codex P1-4）
    // 不变式（Codex P1-r4）：job_created 终态 ⇒ job_id 非空（job_id 与 phase 同一次 UPDATE 落，绝不脱节）。
    expect(p.phase === 'job_created' && p.job_id === null).toBe(false);
    // job_id 真能恢复出建出的 job（网页据此恢复 eventsUrl/jobId）。
    expect(db.jobs.has(p.job_id!)).toBe(true);
  });

  it('【单次 UPDATE 不变式 Codex P1-r4】成功兑换后绝不出现 phase=job_created 且 job_id IS NULL（job_id 与 phase 同写落回）', async () => {
    const db = new FakePairDb();
    const p = db.seedPairing({ phase: 'uploading' });
    const created = await createImportJobForPairing(db, {
      pairId: p.id,
      ownerUserId: 'creator-1',
      source: 'mixed',
      rawS3Keys: ['k0'],
    });
    expect(created).not.toBeNull();
    // 关键不变式：单次 UPDATE 把 phase='job_created'/used_at/job_id 一并落 → job_id 必非空、必 = 建出的 job。
    expect(p.phase).toBe('job_created');
    expect(p.job_id).not.toBeNull();
    expect(p.job_id).toBe(created!.jobId);
    // 用「读状态」验证可恢复性（网页轮询 readPairingStatus 能拿到 jobId → 组 eventsUrl）。
    const status = await readPairingStatus(db, p.id);
    expect(status!.phase).toBe('job_created');
    expect(status!.jobId).toBe(created!.jobId);
  });

  it('【忠实 mock 自证 Codex P1-r4】旧 buggy SQL（linked UPDATE 兑换 + link_job 二次 UPDATE 同行回写）→ 真实 PG 二次改不可靠 → 留下 job_created 但 job_id IS NULL', async () => {
    // 直接喂忠实 mock 一条「旧两次 UPDATE 同一行」形态的 data-modifying CTE。
    //   linked    = UPDATE import_pairings 先兑换 phase/used_at（第一次改该行）。
    //   link_job  = UPDATE import_pairings SET job_id=new_job.id（**第二次**改同一行）。
    //   忠实真实 PG：单语句二次改同一行不可靠 → mock 模拟 job_id 不落回 → 不变式破坏：job_created 但 job_id 仍 null。
    //   这证明 mock 已忠实建模该 PG 语义；新实现（单次 UPDATE）则绝不会留下此破坏（见上一条回归）。
    const db = new FakePairDb();
    const p = db.seedPairing({ phase: 'uploading' });
    const buggyTwoUpdateSql = `WITH linked AS (
        UPDATE import_pairings p
           SET phase='job_created', used_at=now()
         WHERE p.id=$1 AND p.phase IN ('waiting','uploading') AND p.used_at IS NULL
           AND p.expires_at > now() AND p.attempt_count < p.max_attempts
         RETURNING p.id
     ),
     new_job AS (
        INSERT INTO jobs (type, status, owner_user_id, subject_ref, progress, fence_token)
        SELECT 'import','queued',$2,$3::jsonb,$4::jsonb,1 FROM linked
        RETURNING id, fence_token, attempt_no, created_at
     ),
     link_job AS (
        UPDATE import_pairings p SET job_id=(SELECT id FROM new_job) FROM linked
         WHERE p.id = linked.id RETURNING p.id
     )
     SELECT id, fence_token, attempt_no, created_at FROM new_job`;
    await db.query(buggyTwoUpdateSql, [
      p.id,
      'creator-1',
      JSON.stringify({ rawS3Keys: ['k'] }),
      '{}',
    ]);
    // 忠实 PG：第一次 UPDATE 兑换了 phase/used_at，但第二次 UPDATE（回写 job_id）不可靠 → job_id 仍 null。
    expect(p.phase).toBe('job_created');
    expect(p.job_id).toBeNull(); // ⚠️ 不变式破坏：job_created 却无 job_id（网页无法恢复 eventsUrl/jobId）。
    expect(db.jobs.size).toBe(1); // job 已建（但 pairing 回不出它 → 正是 Codex r4 命中的 bug）。
  });

  it('【CTE 语义回归 Codex P1-r2】UPDATE 未命中 active row（配对 expired）→ INSERT 不建 job（忠实 PG 语义）', async () => {
    const db = new FakePairDb();
    // 配对已过期且未达 job_created 终态（phase=expired）：step1 lookup 非 job_created → 落到 CTE；
    //   CTE 的 linked UPDATE WHERE phase IN ('waiting','uploading') 不命中 → linked 空。
    //   新实现 INSERT ... SELECT FROM linked → 0 行 → 不建孤儿 job。
    //   （忠实 mock 下，旧实现 INSERT ... VALUES 会无条件建 job → 本断言会 fail，守门 bug。）
    const p = db.seedPairing({ phase: 'expired' });
    const created = await createImportJobForPairing(db, {
      pairId: p.id,
      ownerUserId: 'creator-1',
      source: 'mixed',
      rawS3Keys: ['k0'],
    });
    expect(created).toBeNull(); // 未兑换成功 → 不建 job
    expect(db.jobs.size).toBe(0); // 关键：绝无孤儿 queued job
    expect(p.job_id).toBeNull();
  });

  it('【完整 active predicate Codex P1-r3】phase=uploading 但已过期（expires_at<now）→ linked 空 → 不建 job', async () => {
    const db = new FakePairDb();
    // phase 合法可兑换（uploading），但 expires_at 已过：完整 active predicate 的 expires_at>now() 不满足。
    //   linked WHERE 含 expires_at>now() → 不命中 → linked 空 → INSERT(SELECT FROM linked) 0 行 → 不建 job、不兑换。
    const p = db.seedPairing({ phase: 'uploading', expires_at: db.now - 1 });
    const created = await createImportJobForPairing(db, {
      pairId: p.id,
      ownerUserId: 'creator-1',
      source: 'mixed',
      rawS3Keys: ['k0'],
    });
    expect(created).toBeNull();
    expect(db.jobs.size).toBe(0); // 绝无孤儿 job
    expect(p.phase).toBe('uploading'); // 未兑换：phase 不变
    expect(p.used_at).toBeNull(); // 未兑换：used_at 不变
    expect(p.job_id).toBeNull();
  });

  it('【完整 active predicate Codex P1-r3】used_at 已置（已被一次性兑换）→ linked 空 → 不建 job（不重复兑换）', async () => {
    const db = new FakePairDb();
    // phase=uploading 且未过期，但 used_at 已被置（前一次兑换过）：active predicate 的 used_at IS NULL 不满足。
    const p = db.seedPairing({ phase: 'uploading', used_at: db.now - 1000 });
    const created = await createImportJobForPairing(db, {
      pairId: p.id,
      ownerUserId: 'creator-1',
      source: 'mixed',
      rawS3Keys: ['k0'],
    });
    expect(created).toBeNull();
    expect(db.jobs.size).toBe(0);
    expect(p.phase).toBe('uploading'); // 未二次兑换
  });

  it('【完整 active predicate Codex P1-r3】attempts 耗尽（attempt_count≥max_attempts）→ linked 空 → 不建 job', async () => {
    const db = new FakePairDb();
    // phase=uploading、未过期、未用，但重试已耗尽：active predicate 的 attempt_count<max_attempts 不满足。
    const p = db.seedPairing({ phase: 'uploading', attempt_count: 5, max_attempts: 5 });
    const created = await createImportJobForPairing(db, {
      pairId: p.id,
      ownerUserId: 'creator-1',
      source: 'mixed',
      rawS3Keys: ['k0'],
    });
    expect(created).toBeNull();
    expect(db.jobs.size).toBe(0);
    expect(p.used_at).toBeNull(); // 未兑换
  });

  it('【忠实 mock 自证】旧 buggy SQL（INSERT ... VALUES 不依赖 linked）在非 active 配对下仍建孤儿 job（mock 暴露 bug）', async () => {
    // 直接喂忠实 mock 一条「旧实现形态」的 data-modifying CTE（INSERT ... VALUES，不 SELECT FROM linked）。
    //   断言：UPDATE 未命中（配对 expired）时，真实 PG 仍执行 INSERT → 建出 1 个孤儿 job。
    //   这证明 mock 已忠实「所有 data-modifying CTE 都执行」的 PG 语义（旧实现在此 mock 下会被回归测抓到）。
    const db = new FakePairDb();
    const p = db.seedPairing({ phase: 'expired' });
    const buggyOldSql = `WITH new_job AS (
        INSERT INTO jobs (type, status, owner_user_id, subject_ref, progress, fence_token)
        VALUES ('import', 'queued', $2, $3::jsonb, $4::jsonb, 1)
        RETURNING id, fence_token, attempt_no, created_at
     ),
     linked AS (
        UPDATE import_pairings p SET phase='job_created'
         WHERE p.id = $1 AND p.phase IN ('waiting','uploading')
         RETURNING p.id
     )
     SELECT id, fence_token, attempt_no, created_at FROM new_job WHERE EXISTS (SELECT 1 FROM linked)`;
    await db.query(buggyOldSql, [p.id, 'creator-1', JSON.stringify({ rawS3Keys: ['k'] }), '{}']);
    // 忠实 PG：INSERT（VALUES，不依赖 linked）已执行 → 孤儿 job 已建（即使 UPDATE 未命中 active row）。
    expect(db.jobs.size).toBe(1);
  });

  it('已 job_created 配对 → 回放既有 jobId、fenceToken=0（不重复建 job，幂等）', async () => {
    const db = new FakePairDb();
    const p = db.seedPairing({ phase: 'job_created', job_id: 'job-existing' });
    db.jobs.set('job-existing', {
      id: 'job-existing',
      type: 'import',
      status: 'queued',
      owner_user_id: 'creator-1',
      subject_ref: {},
      fence_token: 1,
      attempt_no: 0,
      created_at: new Date(db.now).toISOString(),
    });
    const created = await createImportJobForPairing(db, {
      pairId: p.id,
      ownerUserId: 'creator-1',
      source: 'mixed',
      rawS3Keys: ['k'],
    });
    expect(created!.jobId).toBe('job-existing');
    expect(created!.fenceToken).toBe(0);
    expect(db.jobs.size).toBe(1); // 未建新 job（只有回放的既有 job）
  });
});

// ───────────────────────── 路由 handler ─────────────────────────

describe('connectPairHandler', () => {
  it('已登录 creator → 201 + PairResult（command 注入 BASE+code、curlOneLiner 固定）', async () => {
    const db = new FakePairDb();
    const req = baseReq(db, { auth: { userId: 'creator-1' }, body: {} });
    const { reply, sent } = makeReply();
    await connectPairHandler().call(undefined as never, req as never, reply as never);
    expect(sent.code).toBe(201);
    const data = (sent.body as { data: Record<string, string> }).data;
    expect(data.pairId).toMatch(/^pair-/);
    expect(data.pairingCode).toMatch(/^\d{6}$/);
    expect(data.command).toContain('https://agora.app/api/v1/import/connect/script?code=');
    expect(data.command).toContain('| sh');
    expect(data.curlOneLiner).toBe('curl -fsSL agora.app/import | sh');
    expect(data.expiresAt).toBeTruthy();
  });

  it('未登录 → 401', async () => {
    const db = new FakePairDb();
    const req = baseReq(db, { auth: undefined, body: {} });
    const { reply, sent } = makeReply();
    await connectPairHandler().call(undefined as never, req as never, reply as never);
    expect(sent.code).toBe(401);
  });
});

describe('connectScriptHandler', () => {
  it('active 码 → 200 text/x-shellscript，注入反查到的 pairId + code', async () => {
    const db = new FakePairDb();
    const p = db.seedPairing({ pairing_code_hash: hashPairingCode('424242') });
    const req = baseReq(db, { query: { code: '424242' } });
    const { reply, sent } = makeReply();
    await connectScriptHandler().call(undefined as never, req as never, reply as never);
    expect(sent.code).toBe(200);
    expect(sent.headers['content-type']).toContain('text/x-shellscript');
    expect(String(sent.body)).toContain(p.id);
    expect(String(sent.body)).toContain('424242');
  });

  it('无 code → 404 + 人话 stderr 脚本（不裸 JSON 错误码）', async () => {
    const db = new FakePairDb();
    const req = baseReq(db, { query: {} });
    const { reply, sent } = makeReply();
    await connectScriptHandler().call(undefined as never, req as never, reply as never);
    expect(sent.code).toBe(404);
    expect(sent.headers['content-type']).toContain('text/x-shellscript');
    expect(String(sent.body)).toContain('配对码已失效');
    expect(String(sent.body)).not.toContain('"error"');
  });

  it('过期码 → 404 人话脚本（反查不到 active）', async () => {
    const db = new FakePairDb();
    db.seedPairing({ pairing_code_hash: hashPairingCode('999999'), expires_at: db.now - 1 });
    const req = baseReq(db, { query: { code: '999999' } });
    const { reply, sent } = makeReply();
    await connectScriptHandler().call(undefined as never, req as never, reply as never);
    expect(sent.code).toBe(404);
    expect(String(sent.body)).toContain('配对码已失效');
  });
});

describe('connectUploadHandler（多分片协议：判别联合 Codex#14 + 落桶 P0-2 + 传齐才建 P1-8）', () => {
  it('parts 未齐 → 200 status:uploading（无 jobId/eventsUrl，不裸转圈，不建 job，Codex P1-8）', async () => {
    const db = new FakePairDb();
    const p = db.seedPairing();
    let req = baseReq(db, { pairAuth: { pairId: p.id, ownerUserId: 'creator-1' } });
    req = withMultipart(
      req,
      { partIndex: '0', totalParts: '3' },
      Buffer.from('raw-jsonl'),
    ) as never;
    const { reply, sent } = makeReply();
    await connectUploadHandler().call(undefined as never, req as never, reply as never);
    expect(sent.code).toBe(200);
    const data = (sent.body as { data: Record<string, unknown> }).data;
    expect(data.status).toBe('uploading');
    expect(data.uploadedParts).toBe(1);
    expect(data.totalParts).toBe(3);
    expect(data).not.toHaveProperty('jobId');
    expect(db.jobs.size).toBe(0); // 未齐绝不建 job（Codex P1-8）
    // 该片真实落桶（Codex P0-2）。
    const store = (req as { server: { infra: { objectStore: FakeStore } } }).server.infra
      .objectStore;
    expect(store.puts).toHaveLength(1);
    expect(store.puts[0]!.key).toBe('raw/creator-1/' + p.id + '/part-0');
  });

  it('多分片全流程：3 片到齐才建 job_created（必含 jobId+eventsUrl+jobView）+ enqueue 一次（Codex P0-2/P1-7/P1-8）', async () => {
    const db = new FakePairDb();
    const p = db.seedPairing();
    const enqueue = vi.fn(async () => undefined);
    const store = new FakeStore();
    function partReq(idx: number): Record<string, unknown> {
      let r = baseReq(db, { pairAuth: { pairId: p.id, ownerUserId: 'creator-1' } });
      (
        r.server as { infra: { queue: { enqueue: unknown }; objectStore: unknown } }
      ).infra.queue.enqueue = enqueue;
      (r.server as { infra: { objectStore: unknown } }).infra.objectStore = store;
      r = withMultipart(
        r,
        { source: 'mixed', partIndex: String(idx), totalParts: '3' },
        Buffer.from('part' + idx),
      ) as never;
      return r;
    }
    // 片 0、1 → uploading，未建 job。
    for (const idx of [0, 1]) {
      const { reply, sent } = makeReply();
      await connectUploadHandler().call(undefined as never, partReq(idx) as never, reply as never);
      expect((sent.body as { data: { status: string } }).data.status).toBe('uploading');
    }
    expect(db.jobs.size).toBe(0);
    // 片 2（最后一片到齐）→ job_created。
    const { reply, sent } = makeReply();
    await connectUploadHandler().call(undefined as never, partReq(2) as never, reply as never);
    expect(sent.code).toBe(200);
    const data = (sent.body as { data: Record<string, unknown> }).data;
    expect(data.status).toBe('job_created');
    expect(typeof data.jobId).toBe('string');
    expect(data.eventsUrl).toBe(SSE_ROUTES.jobEvents(data.jobId as string));
    // 完整 JobView（Codex P1-7）：queued + 五项子任务 pending + attemptNo/createdAt。
    const jv = data.jobView as {
      status: string;
      progress: { subtasks: Array<{ status: string }> };
      attemptNo: number;
      createdAt: string;
    };
    expect(jv.status).toBe('queued');
    expect(jv.progress.subtasks).toHaveLength(5);
    expect(jv.progress.subtasks.every((s) => s.status === 'pending')).toBe(true);
    expect(jv.createdAt).toBeTruthy();
    // 全部 3 片落桶 + 仅入队一次。
    expect(store.puts).toHaveLength(3);
    expect(enqueue).toHaveBeenCalledOnce();
    // job subject_ref 带全部 3 个 rawS3Keys（Codex P0-2）。
    const job = db.jobs.get(data.jobId as string)!;
    expect((job.subject_ref as { rawS3Keys: string[] }).rawS3Keys).toHaveLength(3);
  });

  it('单片无 totalParts → 一片即齐 → job_created', async () => {
    const db = new FakePairDb();
    const p = db.seedPairing();
    let req = baseReq(db, { pairAuth: { pairId: p.id, ownerUserId: 'creator-1' } });
    req = withMultipart(req, { partIndex: '0' }, Buffer.from('raw')) as never;
    const { reply, sent } = makeReply();
    await connectUploadHandler().call(undefined as never, req as never, reply as never);
    expect(sent.code).toBe(200);
    expect((sent.body as { data: { status: string } }).data.status).toBe('job_created');
  });

  it('落桶失败（S3 不可用）→ 503 DEPENDENCY_UNAVAILABLE（人话 wait，不建 job，Codex P0-2）', async () => {
    const db = new FakePairDb();
    const p = db.seedPairing();
    const store = new FakeStore();
    store.failPut = true;
    let req = baseReq(db, { pairAuth: { pairId: p.id, ownerUserId: 'creator-1' } });
    (req.server as { infra: { objectStore: unknown } }).infra.objectStore = store;
    req = withMultipart(req, { partIndex: '0', totalParts: '1' }, Buffer.from('raw')) as never;
    const { reply, sent } = makeReply();
    await connectUploadHandler().call(undefined as never, req as never, reply as never);
    expect(sent.code).toBe(503);
    expect(errBody(sent).action).toBe('wait');
    expect(db.jobs.size).toBe(0);
  });

  it('助手扫到空（无文件）→ 400 IMPORT_NO_CONTENT change_input（不落桶、不建 job，导入-20）', async () => {
    const db = new FakePairDb();
    const p = db.seedPairing();
    let req = baseReq(db, { pairAuth: { pairId: p.id, ownerUserId: 'creator-1' } });
    req = withMultipart(req, { partIndex: '0' }, null) as never;
    const { reply, sent } = makeReply();
    await connectUploadHandler().call(undefined as never, req as never, reply as never);
    expect(sent.code).toBe(400);
    expect(errBody(sent).action).toBe('change_input');
    expect(db.jobs.size).toBe(0);
  });

  it('零字节文件 → 400 IMPORT_NO_CONTENT', async () => {
    const db = new FakePairDb();
    const p = db.seedPairing();
    let req = baseReq(db, { pairAuth: { pairId: p.id, ownerUserId: 'creator-1' } });
    req = withMultipart(req, { partIndex: '0' }, Buffer.alloc(0)) as never;
    const { reply, sent } = makeReply();
    await connectUploadHandler().call(undefined as never, req as never, reply as never);
    expect(sent.code).toBe(400);
    expect(errBody(sent).action).toBe('change_input');
  });

  it('配对已终态（job_created）但 pairAuth 未带 recovery（非恢复语境）→ 409 STATE_CONFLICT change_input', async () => {
    const db = new FakePairDb();
    const p = db.seedPairing({ phase: 'job_created', job_id: 'job-x' });
    let req = baseReq(db, { pairAuth: { pairId: p.id, ownerUserId: 'creator-1' } });
    req = withMultipart(req, { partIndex: '0', totalParts: '1' }, Buffer.from('raw')) as never;
    const { reply, sent } = makeReply();
    await connectUploadHandler().call(undefined as never, req as never, reply as never);
    expect(sent.code).toBe(409);
    expect(errBody(sent).action).toBe('change_input');
  });

  it('【终态恢复短路 Codex P1-r6】pairAuth.recovery 命中 → 200 job_created + 恢复同一 jobId/jobView（非 409，不解析 multipart/不登记/不建 job）', async () => {
    const db = new FakePairDb();
    const p = db.seedPairing({ phase: 'job_created', job_id: 'job-recover' });
    // 既有 job（PairAuth 已凭正确 code 放行恢复，注入 recovery.jobId）。
    db.jobs.set('job-recover', {
      id: 'job-recover',
      type: 'import',
      status: 'running',
      owner_user_id: 'creator-1',
      subject_ref: {},
      progress: { percent: 42, phrase: '解析中…', subtasks: [], items: [] },
      fence_token: 1,
      attempt_no: 1,
      created_at: new Date(db.now).toISOString(),
    });
    const enqueue = vi.fn(async () => undefined);
    const store = new FakeStore();
    let req = baseReq(db, {
      pairAuth: { pairId: p.id, ownerUserId: 'creator-1', recovery: { jobId: 'job-recover' } },
    });
    (
      req.server as { infra: { queue: { enqueue: unknown }; objectStore: unknown } }
    ).infra.queue.enqueue = enqueue;
    (req.server as { infra: { objectStore: unknown } }).infra.objectStore = store;
    // 即使带文件，也不应被解析/登记/落桶（恢复短路在最前）。
    req = withMultipart(req, { partIndex: '0', totalParts: '3' }, Buffer.from('raw')) as never;
    const { reply, sent } = makeReply();
    await connectUploadHandler().call(undefined as never, req as never, reply as never);
    expect(sent.code).toBe(200); // 非 409
    const data = (sent.body as { data: Record<string, unknown> }).data;
    expect(data.status).toBe('job_created');
    expect(data.jobId).toBe('job-recover'); // 恢复同一 job
    expect(data.eventsUrl).toBe(SSE_ROUTES.jobEvents('job-recover'));
    const jv = data.jobView as { status: string; attemptNo: number };
    expect(jv.status).toBe('running'); // 恢复出 job 的真实状态（非伪 queued）
    expect(jv.attemptNo).toBe(1);
    // 关键：恢复短路——绝不落桶、绝不入队、绝不重复建 job。
    expect(store.puts).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(db.jobs.size).toBe(1);
  });

  it('【终态恢复短路 Codex P1-r6】recovery.jobId 指向已不存在的 job（极端）→ 409 引导重发', async () => {
    const db = new FakePairDb();
    const p = db.seedPairing({ phase: 'job_created', job_id: 'job-gone' });
    let req = baseReq(db, {
      pairAuth: { pairId: p.id, ownerUserId: 'creator-1', recovery: { jobId: 'job-gone' } },
    });
    req = withMultipart(req, { partIndex: '0', totalParts: '1' }, Buffer.from('raw')) as never;
    const { reply, sent } = makeReply();
    await connectUploadHandler().call(undefined as never, req as never, reply as never);
    expect(sent.code).toBe(409);
    expect(errBody(sent).action).toBe('change_input');
  });

  it('缺 pairAuth → 401', async () => {
    const db = new FakePairDb();
    let req = baseReq(db, { pairAuth: undefined });
    req = withMultipart(req, { partIndex: '0' }, Buffer.from('raw')) as never;
    const { reply, sent } = makeReply();
    await connectUploadHandler().call(undefined as never, req as never, reply as never);
    expect(sent.code).toBe(401);
  });
});

describe('connectPairStatusHandler（owner 校验 + phase 折算）', () => {
  it('本人 waiting → 200 phase=waiting（无 jobId）', async () => {
    const db = new FakePairDb();
    const p = db.seedPairing({ owner_user_id: 'creator-1' });
    const req = baseReq(db, { auth: { userId: 'creator-1' }, params: { pairId: p.id } });
    const { reply, sent } = makeReply();
    await connectPairStatusHandler().call(undefined as never, req as never, reply as never);
    expect(sent.code).toBe(200);
    const data = (sent.body as { data: Record<string, unknown> }).data;
    expect(data.phase).toBe('waiting');
    expect(data).not.toHaveProperty('jobId');
  });

  it('本人 job_created → 200 phase=job_created + jobId + eventsUrl（Codex#14 对齐）', async () => {
    const db = new FakePairDb();
    const p = db.seedPairing({
      owner_user_id: 'creator-1',
      phase: 'job_created',
      job_id: 'job-42',
    });
    const req = baseReq(db, { auth: { userId: 'creator-1' }, params: { pairId: p.id } });
    const { reply, sent } = makeReply();
    await connectPairStatusHandler().call(undefined as never, req as never, reply as never);
    expect(sent.code).toBe(200);
    const data = (sent.body as { data: Record<string, unknown> }).data;
    expect(data.phase).toBe('job_created');
    expect(data.jobId).toBe('job-42');
    expect(data.eventsUrl).toBe(SSE_ROUTES.jobEvents('job-42'));
  });

  it('过期未用 → phase 折算 expired（有出口态，导入-19）', async () => {
    const db = new FakePairDb();
    const p = db.seedPairing({ owner_user_id: 'creator-1', expires_at: db.now - 1 });
    const req = baseReq(db, { auth: { userId: 'creator-1' }, params: { pairId: p.id } });
    const { reply, sent } = makeReply();
    await connectPairStatusHandler().call(undefined as never, req as never, reply as never);
    expect(sent.code).toBe(200);
    expect((sent.body as { data: { phase: string } }).data.phase).toBe('expired');
  });

  it('非本人 → 404（不暴露存在性，10-auth §6.3）', async () => {
    const db = new FakePairDb();
    const p = db.seedPairing({ owner_user_id: 'creator-1' });
    const req = baseReq(db, { auth: { userId: 'attacker' }, params: { pairId: p.id } });
    const { reply, sent } = makeReply();
    await connectPairStatusHandler().call(undefined as never, req as never, reply as never);
    expect(sent.code).toBe(404);
  });

  it('不存在 → 404', async () => {
    const db = new FakePairDb();
    const req = baseReq(db, { auth: { userId: 'creator-1' }, params: { pairId: 'nope' } });
    const { reply, sent } = makeReply();
    await connectPairStatusHandler().call(undefined as never, req as never, reply as never);
    expect(sent.code).toBe(404);
  });

  it('未登录 → 401', async () => {
    const db = new FakePairDb();
    const req = baseReq(db, { auth: undefined, params: { pairId: 'x' } });
    const { reply, sent } = makeReply();
    await connectPairStatusHandler().call(undefined as never, req as never, reply as never);
    expect(sent.code).toBe(401);
  });
});

// ───────────────────────── 文案合规（脊柱 §3.1/§11.B） ─────────────────────────

describe('对外 userMessage 文案合规（无 code/堆栈/状态码，脊柱 §11.B）', () => {
  it('上传 handler 各错误 userMessage 均过 lintUserMessage', async () => {
    const db = new FakePairDb();
    const messages: string[] = [];

    // 空内容。
    {
      const p = db.seedPairing();
      let req = baseReq(db, { pairAuth: { pairId: p.id, ownerUserId: 'creator-1' } });
      req = withMultipart(req, { partIndex: '0' }, null) as never;
      const { reply, sent } = makeReply();
      await connectUploadHandler().call(undefined as never, req as never, reply as never);
      messages.push(errBody(sent).userMessage);
    }
    // 已终态。
    {
      const p = db.seedPairing({ phase: 'job_created', job_id: 'j' });
      let req = baseReq(db, { pairAuth: { pairId: p.id, ownerUserId: 'creator-1' } });
      req = withMultipart(req, { partIndex: '0' }, Buffer.from('raw')) as never;
      const { reply, sent } = makeReply();
      await connectUploadHandler().call(undefined as never, req as never, reply as never);
      messages.push(errBody(sent).userMessage);
    }

    expect(messages.length).toBeGreaterThan(0);
    for (const m of messages) {
      expect(m).toBeTruthy();
      expect(lintUserMessage(m)).toEqual([]);
    }
  });

  it('readPairingStatus 过期折算到 expired（仓库层直测）', async () => {
    const db = new FakePairDb();
    const p = db.seedPairing({ expires_at: db.now - 1 });
    const row = await readPairingStatus(db, p.id);
    expect(row?.phase).toBe('expired');
  });
});
