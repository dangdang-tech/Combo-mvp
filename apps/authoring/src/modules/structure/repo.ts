// 40 · 结构化域仓储（B-24/B-25，40-step3-4-structure §4/§5，受保护写入 §11.A 模板 3）。全部注入 Queryable/Tx，便于 mock，无真 PG。
//   写入铁律（§11.A）：worker 写 structure_state / manifest 用【单条事务 CTE】，fence 经 jobs 联表内联进数据源
//     `... FROM jobs WHERE id=:jobId AND fence_token=:fence AND status='running' AND v.id=:versionId`；
//     禁「先 SELECT 校验 fence、再独立 UPDATE」两步（TOCTOU）。rowCount=0 = 已被 fence out（正常控制流，干净退出）。
//   并发正确性（Codex r2 P0）：四个软字段受保护写（stuck/array-item/state-surgical/done-surgical）的 idx/next_state
//     必须从【锁住的目标行】算——CTE 头 `WITH tgt AS MATERIALIZED (SELECT ... FROM capability_versions WHERE id=$3
//     FOR UPDATE)` 先锁 version 行再读 structure_state，最终 UPDATE 改这把锁下的同一行（v.id = tgt.id AND v.id=$3）。
//     无锁 stale 读会让迟到写（用 stale idx / stale 整列）覆盖并发已落的 done/failed（最严重：done-surgical 的整列写
//     擦掉并发 PATCH / 别字段 done）。AS MATERIALIZED 防 CTE 内联把锁优化掉。
//   锁序决策（死锁分析）：本文件四写【只锁 version 行】，jobs 仅在 UPDATE 的 FROM 里【无锁】读做 fence 守门（不锁 job
//     行）。对齐其它写 version 的路径——structure-edit-repo.ts 的 patchManifestSoftFields / acquireRegenerateFieldJob
//     都先 `SELECT ... FOR UPDATE OF v`（version 优先）；acquireRegenerateFieldJob 之后才 INSERT 新 job 行
//     （version→job 序）。若本处反过来「先锁 job 再锁 version」（即 Codex 提的 job_guard FOR UPDATE 方案）会与 regen 的
//     version→job 反向，构成 job↔version 死锁环；且 fence 守门已在最终 UPDATE 的 WHERE 内联（wrong-fence/cancelled →
//     0 行安全退出），无需为 wrong-fence 额外锁 job 行。故【不引入 job_guard】，统一 version 优先锁序、零死锁环。
//   B-24 建体：单 PG 事务建 capabilities + capability_versions（复合 FK 同 capability，UNIQUE(capability_id,id)）；幂等回放。
//   血缘：source_candidate_id → capability_candidates.id；worker 经候选直读 candidate_evidence/session_segments（§4.C）。
import type { Queryable } from '../../platform/jobs/types.js';
import type { Tx, TxPool } from '../../platform/events/db-tx.js';
import { withTransaction } from '../../platform/events/db-tx.js';
import type { Manifest, StructureState } from '@cb/shared';

// ===========================================================================
// B-25 worker 直读证据（不依赖 ExperiencePack，§4.C）
// ===========================================================================

/** 结构化生成所需的去敏证据片段（candidate_evidence JOIN session_segments，§4.C）。 */
export interface StructureEvidenceSegment {
  segmentId: string;
  title: string | null;
  source: string | null;
  project: string | null;
  content: string;
}
export interface StructureEvidence {
  segments: StructureEvidenceSegment[];
}

/**
 * 经 source_candidate_id 直读该候选的支撑证据段集（§4.C：worker 直读 candidate_evidence/session_segments）。
 *   按 evidence 落库序（e.id 升序，UUID v7 时间有序）；去敏正文导入期已抹隐私（不二次脱敏）。
 *   候选无证据 / 无 source_candidate_id → 段集空（调用方据此抛 STRUCTURE_NO_EVIDENCE，§4.C 错误用例）。
 */
export async function readEvidenceForCandidate(
  db: Queryable,
  candidateId: string,
): Promise<StructureEvidence> {
  const res = await db.query<{
    segment_id: string;
    title: string | null;
    source: string | null;
    project: string | null;
    content: string;
  }>(
    `SELECT e.segment_id AS segment_id,
            seg.title AS title, seg.source AS source, seg.project AS project, seg.content AS content
       FROM candidate_evidence e
       JOIN session_segments seg ON seg.id = e.segment_id
      WHERE e.candidate_id = $1
      ORDER BY e.id ASC`,
    [candidateId],
  );
  return {
    segments: res.rows.map((r) => ({
      segmentId: r.segment_id,
      title: r.title,
      source: r.source,
      project: r.project,
      content: r.content,
    })),
  };
}

// ===========================================================================
// B-25 受保护写 structure_state / manifest（§11.A 模板 3，fence 经 jobs 联表内联）
// ===========================================================================

/**
 * 受保护写 capability_versions.structure_state（§4.C「受保护写入」模板 3 实例）。
 *   fence 经 jobs 联表内联进数据源：j.id+fence_token+status='running' AND v.id=versionId。
 *   取消/重入队换 fence 或离开 running → 命中 0 行 → 返回 false（旧执行安全退出，已生成保留，硬规则③）。
 *   单条事务 CTE：无「先查 fence 再写」两步（TOCTOU）；同一行（该 version）本语句只改一次。
 */
export async function writeStructureStateProtected(
  db: Queryable,
  args: { jobId: string; fenceToken: number; versionId: string; state: StructureState },
): Promise<boolean> {
  const res = await db.query(
    `UPDATE capability_versions v
        SET structure_state = $4::jsonb, updated_at = now()
       FROM jobs j
      WHERE j.id = $1
        AND j.fence_token = $2
        AND j.status = 'running'
        AND v.id = $3`,
    [args.jobId, args.fenceToken, args.versionId, JSON.stringify(args.state)],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * 受保护【条件】写某软字段 stuck 态（仅当该字段仍 generating，§3.3/§11.A，Codex r3 P1）。
 *   只 surgically patch `structure_state.fields[该字段]` 的 `status='stuck'` + `stuckMs`——【绝不写 manifest】、
 *   不携带调用方旧 structure_state 快照（直接对【库内当前行】jsonb_set，故不覆盖并发写回的其它字段值）。
 *   守护条件三要素叠加「该字段仍 generating」：fence/running + v.id + 该字段当前 status='generating'。
 *   竞态兜底（Codex r3 P1）：若终态（done/failed）已先落库，该字段已不再 generating → LATERAL 命中 0 元素 →
 *     UPDATE 影响 0 行 → 迟到的 stuck 写自动 no-op，【永不覆盖已生成内容 / manifest】、永不把 done 打回 stuck。
 *   返回是否命中（rowCount>0）：0 行 = fence out 或该字段已离开 generating（均为正常控制流，静默忽略）。
 */
export async function writeFieldStuckIfGenerating(
  db: Queryable,
  args: {
    jobId: string;
    fenceToken: number;
    versionId: string;
    field: string;
    stuckMs: number;
  },
): Promise<boolean> {
  // idx 经 CTE（tgt）算下标——LATERAL 引用 tgt 而非 UPDATE 目标 v（PG 禁 FROM 内 LATERAL 引用 UPDATE 目标表，
  //   否则抛 invalid reference to FROM-clause entry for table "v"，整 job 立即 INTERNAL）。idx 跨连进 UPDATE FROM：
  //   该字段不再 generating → idx 空 → CROSS JOIN 0 行 → UPDATE 0 行（保留原 LATERAL「0 元素=no-op」竞态兜底）。
  // 并发正确性（Codex r2 P0）：tgt 必须 `FOR UPDATE` 锁住目标 version 行再读 structure_state——否则是无锁 stale 读，
  //   迟到的 stuck 写会用 stale idx 覆盖已并发落 done/failed 的当前行（把 done 打回 stuck）。锁后 idx 从【锁住的最新行】
  //   算，最终 UPDATE 改的就是这把锁下的同一行（v.id = tgt.id），读—算—写全在行锁内原子。`AS MATERIALIZED` 防 CTE
  //   内联把 tgt 优化成可重读/丢锁。锁序：先锁 version 行（与 patchManifestSoftFields / acquireRegenerateFieldJob
  //   一致，均 version 优先），不锁 jobs 行（jobs 仅在最终 UPDATE 的 FROM 里无锁读做 fence 守门），故与 PATCH/regen
  //   写路径锁序统一、不构成 job↔version 死锁环（详见文件顶注锁序决策）。
  const res = await db.query(
    `WITH tgt AS MATERIALIZED (
       SELECT id, structure_state FROM capability_versions WHERE id = $3 FOR UPDATE
     ),
     idx AS (
       SELECT (e.ord - 1) AS i
         FROM tgt,
              LATERAL jsonb_array_elements(tgt.structure_state -> 'fields')
                        WITH ORDINALITY AS e(elem, ord)
        WHERE e.elem ->> 'field' = $4
          AND e.elem ->> 'status' = 'generating'
        LIMIT 1
     )
     UPDATE capability_versions v
        SET structure_state = jsonb_set(
              jsonb_set(
                v.structure_state,
                ARRAY['fields', (idx.i)::text, 'status'],
                '"stuck"'::jsonb,
                false
              ),
              ARRAY['fields', (idx.i)::text, 'stuckMs'],
              to_jsonb($5::int),
              true
            ),
            updated_at = now()
       FROM jobs j, tgt, idx
      WHERE j.id = $1
        AND j.fence_token = $2
        AND j.status = 'running'
        AND v.id = tgt.id
        AND v.id = $3`,
    [args.jobId, args.fenceToken, args.versionId, args.field, args.stuckMs],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * 受保护【条件】写某【数组】软字段逐项 partial value（仅当该字段仍 generating，§4.C「每数组项生成完即落」/§11.A，Codex r4 P1）。
 *   只 surgically 把本项 append 进 `structure_state.fields[该数组字段].value`（jsonb 数组追加）——【绝不写 manifest】、
 *   不动其它字段、不动该字段 status/attempts（仍 generating，整数组完成才由 field_done 落完整 value + done）。
 *   不携带调用方旧 structure_state 快照（直接对【库内当前行】jsonb_set，故不覆盖并发写回的其它字段）。
 *   守护条件叠加「该字段仍 generating」：fence/running + v.id + 该字段当前 status='generating'。
 *   竞态/接管兜底：若终态（done/failed）或被换 fence 已先落库 → 该字段已不再 generating → LATERAL 命中 0 元素 →
 *     UPDATE 影响 0 行 → 迟到的 item 写自动 no-op，调用方据此【不再 emit item-appended】（与 stuck no-op 同思路）。
 *   返回是否命中（rowCount>0）：true = 已落 partial（可安全 emit）；false = fence out / 该字段已离开 generating（不 emit）。
 */
export async function writeArrayItemIfGenerating(
  db: Queryable,
  args: {
    jobId: string;
    fenceToken: number;
    versionId: string;
    field: string;
    item: string;
  },
): Promise<boolean> {
  // idx 经 CTE（tgt）算下标——LATERAL 引用 tgt 而非 UPDATE 目标 v（PG 禁 FROM 内 LATERAL 引用 UPDATE 目标表）。
  //   idx 跨连进 UPDATE FROM：该字段不再 generating → idx 空 → 0 行（保留原「迟到 item 写 no-op」竞态兜底）。
  // 并发正确性（Codex r2 P0）：tgt `FOR UPDATE` 锁住目标 version 行——否则无锁 stale 读下，迟到的 item append 会基于
  //   stale value 把并发已落的 item/done 覆盖。锁后 idx + COALESCE(...value...) 从锁住的最新行读现值再 append，最终
  //   UPDATE 改这把锁下的同一行（v.id = tgt.id），读—改—写原子。`AS MATERIALIZED` 防 CTE 内联丢锁。锁序同上（version 优先）。
  const res = await db.query(
    `WITH tgt AS MATERIALIZED (
       SELECT id, structure_state FROM capability_versions WHERE id = $3 FOR UPDATE
     ),
     idx AS (
       SELECT (e.ord - 1) AS i
         FROM tgt,
              LATERAL jsonb_array_elements(tgt.structure_state -> 'fields')
                        WITH ORDINALITY AS e(elem, ord)
        WHERE e.elem ->> 'field' = $4
          AND e.elem ->> 'status' = 'generating'
        LIMIT 1
     )
     UPDATE capability_versions v
        SET structure_state = jsonb_set(
              v.structure_state,
              ARRAY['fields', (idx.i)::text, 'value'],
              COALESCE(
                v.structure_state #> ARRAY['fields', (idx.i)::text, 'value'],
                '[]'::jsonb
              ) || to_jsonb($5::text),
              true
            ),
            updated_at = now()
       FROM jobs j, tgt, idx
      WHERE j.id = $1
        AND j.fence_token = $2
        AND j.status = 'running'
        AND v.id = tgt.id
        AND v.id = $3`,
    [args.jobId, args.fenceToken, args.versionId, args.field, args.item],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * 受保护 surgical 写单软字段 structure_state 条目的 status/attempts(/error)——【保留该字段 DB 现值 value】（Codex r6/r7 P1）。
 *   worker 起步【占位 generating】与【失败收口】都走它：只 surgically patch 本字段条目的 status（+ attempts，failed 带 error），
 *   绝不动该字段的 value（DB 现值权威）——这样本 attempt 已逐项落库的数组 tail（writeArrayItemIfGenerating）不会被
 *   本地旧 state 整条替换擦掉（Codex r7 P1 #1）。同时清掉 stuckMs（status 转走时不残留）；非 failed 不写 error。
 *   只动本字段条目、不写 manifest、不动其它字段（保留并发 PATCH 改过的其它软字段，Codex r6 P1）。doneCount/totalCount
 *   读时从 fields 重算（surgical 写不刷新存量计数）。
 *   guard：
 *     - 'not-done'（full 模式起步占位）：本字段须存在且当前 status != 'done'——若并发 PATCH 已把它手填成 done，命中 0 元素
 *       → 0 行 no-op（不把并发手改打回 generating，Codex r7 P1 #2）；调用方据此跳过该字段（尊重用户手填，不重生成）。
 *     - 'force'（single-field regen 起步占位）：本字段须存在（任意 status）——端点 F 显式重生成该字段，受理事务已将其置
 *       generating、version 级唯一锁挡并发 regen；强制重写占位（§4.F「强制重生成，即使已 done」）。
 *     - 'in-progress'（失败收口）：本字段须仍 generating 或 stuck（stuck 是 generating 瞬时子态）；终态/被换 fence 已先落库
 *       → 0 元素 → 0 行 no-op（迟到写不覆盖，终态权威）。
 *   守护叠加 fence/running + v.id。0 行 = fence out / guard 不满足（调用方据 guard 语义回退 fenced_out 或 skip）。
 */
export async function writeFieldStateSurgical(
  db: Queryable,
  args: {
    jobId: string;
    fenceToken: number;
    versionId: string;
    field: string;
    status: 'generating' | 'failed';
    attempts: number;
    error?: unknown;
    guard: 'not-done' | 'in-progress' | 'force';
  },
): Promise<boolean> {
  // 只 patch status/attempts（failed 带 error、清 stuckMs），value 保留 DB 现值（jsonb_set 逐键改本字段条目）。
  // idx 经 CTE（tgt）算下标（含 guard 判定）——LATERAL 引用 tgt 而非 UPDATE 目标 v（PG 禁 FROM 内 LATERAL 引用目标）。
  //   idx 跨连进 UPDATE FROM：guard 不满足 → idx 空 → 0 行 no-op（保留原 force/not-done/in-progress guard 语义）。
  // 并发正确性（Codex r2 P0）：tgt `FOR UPDATE` 锁住目标 version 行再做 guard 判定 + 读现值条目——否则无锁 stale 读下，
  //   guard（status<>'done' / status IN(generating,stuck)）可能针对 stale 状态判定通过，把并发已落的 done/done-value
  //   错误地打回 generating/failed。锁后 guard 与 jsonb_set 现值条目都从锁住的最新行读，最终 UPDATE 改这把锁下的同一行
  //   （v.id = tgt.id）。`AS MATERIALIZED` 防 CTE 内联丢锁。锁序同上（version 优先，与 PATCH/regen 写路径一致）。
  const res = await db.query(
    `WITH tgt AS MATERIALIZED (
       SELECT id, structure_state FROM capability_versions WHERE id = $3 FOR UPDATE
     ),
     idx AS (
       SELECT (e.ord - 1) AS i
         FROM tgt,
              LATERAL jsonb_array_elements(tgt.structure_state -> 'fields')
                        WITH ORDINALITY AS e(elem, ord)
        WHERE e.elem ->> 'field' = $4
          AND (
                $8::text = 'force'
             OR ($8::text = 'not-done' AND e.elem ->> 'status' <> 'done')
             OR ($8::text = 'in-progress' AND e.elem ->> 'status' IN ('generating', 'stuck'))
              )
        LIMIT 1
     )
     UPDATE capability_versions v
        SET structure_state = jsonb_set(
              v.structure_state,
              ARRAY['fields', (idx.i)::text],
              (
                -- 取本字段 DB 现条目，逐键改 status/attempts（+ error）、清 stuckMs，保留 value/其它键。
                ( (v.structure_state #> ARRAY['fields', (idx.i)::text])
                    - 'stuckMs'
                    || jsonb_build_object('status', $5::text, 'attempts', $6::int) )
                || CASE WHEN $7::jsonb IS NULL THEN '{}'::jsonb
                        ELSE jsonb_build_object('error', $7::jsonb) END
              ),
              true
            ),
            updated_at = now()
       FROM jobs j, tgt, idx
      WHERE j.id = $1
        AND j.fence_token = $2
        AND j.status = 'running'
        AND v.id = tgt.id
        AND v.id = $3`,
    [
      args.jobId,
      args.fenceToken,
      args.versionId,
      args.field,
      args.status,
      args.attempts,
      args.error !== undefined ? JSON.stringify(args.error) : null,
      args.guard,
    ],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * 受保护【条件】surgical merge：单软字段【完成/收口】只覆盖本字段，保留当前行其它字段（Codex r6 P1）。
 *   旧实现（writeManifestAndStateProtected）落字段完成时把【启动时旧 manifest/state 整列】写回，覆盖了运行期间
 *   并发 PATCH 改过的【其它】软字段的值/状态/partial（已生成不丢被违反）。本实现只对【库内当前行】surgical 改：
 *     - manifest：只 jsonb_set 本字段 value（instructions 派生的 inputs/output 一并 set，仍锁定，§4.E）；其它键不动。
 *     - structure_state.fields[本字段]：整条替换为传入的终态 FieldState（done + value + attempts，清 stuck/error）；
 *       instructions 派生 → 同步刷新 inputs/output 两条 locked 硬字段条目的 value（仍 locked）；其它字段条目不动。
 *   守护条件叠加「该字段仍 generating 或 stuck」：fence/running + v.id + 该字段 status ∈ (generating,stuck)
 *     （stuck 是 generating 瞬时子态，慢字段中途落 stuck 后才收口）。终态（done/failed）/被换 fence 已先落库 →
 *     LATERAL 命中 0 元素 → 0 行 no-op（与 stuck/item 同思路；终态权威、迟到写不覆盖）。
 *   doneCount/totalCount 从重建后的 fields 即时重算（surgical 写不再整列写启动快照、计数须自洽，不留 stale）。
 *   单条事务 CTE，对父行单语句只改一次（§11.A）。0 行 = fence out / 该字段已离开 generating（安全退出，调用方回退 fenced_out）。
 *
 *   入参：
 *     - field：完成的软字段键。
 *     - fieldState：该字段终态条目 JSON（{field,status:'done',value,attempts:0}）——整条替换 structure_state 里该字段。
 *     - manifestField：写进 manifest 的本字段值（与 fieldState.value 一致；分开传以便 jsonb 类型明确）。
 *     - derivedHard：instructions 派生的硬字段（{inputs,output}）；非 instructions 字段传 null（不动硬字段）。
 *       给则同时 jsonb_set manifest.inputs/manifest.output + 刷新 structure_state 里 inputs/output 两条 locked 条目值。
 */
export async function writeFieldDoneSurgical(
  db: Queryable,
  args: {
    jobId: string;
    fenceToken: number;
    versionId: string;
    field: string;
    fieldState: unknown;
    manifestField: string | string[];
    derivedHard: { inputs: unknown; output: unknown } | null;
  },
): Promise<boolean> {
  // manifest surgical set：本字段 value（+ instructions 派生的 inputs/output；仍锁定）。其余键从库内当前行带走。
  // structure_state surgical：整条替换本字段终态条目（done）；instructions 派生时刷新 inputs/output locked 条目值。
  // 守护：LATERAL 仅命中【仍 generating 的本字段】，0 元素 → 0 行 no-op（终态权威）。
  // idx / 重建后的 next_state 全经 CTE（tgt）算——CTE 内 LATERAL 引用 tgt 而非 UPDATE 目标 v（PG 禁 FROM 内
  //   LATERAL 引用目标表，否则抛 invalid reference to FROM-clause entry for table "v"）。idx 跨连进 UPDATE FROM：
  //   本字段不再 generating/stuck → idx 空 → next_state 也空（CROSS JOIN idx）→ 0 行 no-op（保留原「迟到写不覆盖、
  //   终态权威」竞态兜底）。tgt 是本语句单一快照，CTE 内重算与最终 UPDATE 同事务、对父行单语句只改一次（§11.A 原子）。
  // 并发正确性（Codex r2 P0，本函数最敏感）：tgt 必须 `FOR UPDATE` 锁住目标 version 行——否则无锁 stale 读下，next_state
  //   从 stale tgt.structure_state 重建后【整列写】structure_state，会擦掉锁读—写之间并发 PATCH / 别字段 done 落的写。
  //   加锁后：并发写要么在本锁前已提交（则 tgt 读到它、rebuilt 原样保留其它字段）、要么阻塞到本语句提交后再跑（读到本次
  //   done）——整列写不再丢并发字段。idx/rebuilt/next_state 全从锁住的最新 tgt 重建，最终 UPDATE 改这把锁下的同一行
  //   （v.id = tgt.id）。`AS MATERIALIZED` 防 CTE 内联丢锁。锁序同上（version 优先，与 PATCH/regen 写路径一致，无死锁环）。
  const res = await db.query(
    `WITH tgt AS MATERIALIZED (
       SELECT id, manifest, structure_state FROM capability_versions WHERE id = $3 FOR UPDATE
     ),
     idx AS (
       -- 守护：本字段须仍 generating 或 stuck（stuck 是 generating 的瞬时子态，慢字段中途落 stuck 后才收口）。
       --   终态（done/failed）/被换 fence 已先落库 → 命中 0 元素 → idx 空 → 0 行 no-op（迟到写不覆盖，终态权威）。
       SELECT (e.ord - 1) AS i
         FROM tgt,
              LATERAL jsonb_array_elements(tgt.structure_state -> 'fields')
                        WITH ORDINALITY AS e(elem, ord)
        WHERE e.elem ->> 'field' = $4
          AND e.elem ->> 'status' IN ('generating', 'stuck')
        LIMIT 1
     ),
     rebuilt AS (
       -- structure_state.fields 重建：本字段条目整条换终态（$7）；inputs/output 两条 locked 刷新派生值（仍 locked，
       --   非 instructions 字段 $6 NULL → COALESCE 保持原 value）；其它字段条目（含并发 PATCH 改过的软字段）原样保留。
       --   CROSS JOIN idx：idx 空（guard 不满足）→ rebuilt 无行 → next_state 无行 → UPDATE 0 行（与原 LATERAL 同语义）。
       SELECT jsonb_agg(
                CASE
                  WHEN (e.ord - 1) = idx.i
                    THEN $7::jsonb
                  WHEN (e.elem ->> 'field') = 'inputs'
                    THEN jsonb_set(e.elem, ARRAY['value'], COALESCE($6::jsonb -> 'inputs', e.elem -> 'value'), true)
                  WHEN (e.elem ->> 'field') = 'output'
                    THEN jsonb_set(e.elem, ARRAY['value'], COALESCE($6::jsonb -> 'output', e.elem -> 'value'), true)
                  ELSE e.elem
                END
                ORDER BY e.ord
              ) AS fields
         FROM tgt, idx,
              LATERAL jsonb_array_elements(tgt.structure_state -> 'fields')
                        WITH ORDINALITY AS e(elem, ord)
     ),
     next_state AS (
       -- doneCount/totalCount 从重建后的 fields 即时重算（只数软字段 done/全集；硬字段 locked 不计 total）——
       --   surgical 写不再整列写启动快照、计数须自洽（避免 stale，与 manifest.buildStructureState 同口径）。
       SELECT jsonb_set(
                jsonb_set(
                  jsonb_set(tgt.structure_state, ARRAY['fields'], rebuilt.fields, true),
                  ARRAY['doneCount'],
                  to_jsonb((
                    SELECT count(*)
                      FROM jsonb_array_elements(rebuilt.fields) AS sf
                     WHERE sf ->> 'field' IN ('name','tagline','role','goal','instructions','skill_set','starter_prompts')
                       AND sf ->> 'status' = 'done'
                  )::int),
                  true
                ),
                ARRAY['totalCount'],
                to_jsonb((
                  SELECT count(*)
                    FROM jsonb_array_elements(rebuilt.fields) AS sf
                   WHERE sf ->> 'field' IN ('name','tagline','role','goal','instructions','skill_set','starter_prompts')
                )::int),
                true
              ) AS next
         FROM tgt, rebuilt
     )
     UPDATE capability_versions v
        SET manifest =
              CASE
                WHEN $6::jsonb IS NULL THEN
                  jsonb_set(v.manifest, ARRAY[$4::text], $5::jsonb, true)
                ELSE
                  jsonb_set(
                    jsonb_set(
                      jsonb_set(v.manifest, ARRAY[$4::text], $5::jsonb, true),
                      ARRAY['inputs'],
                      ($6::jsonb -> 'inputs'),
                      true
                    ),
                    ARRAY['output'],
                    ($6::jsonb -> 'output'),
                    true
                  )
              END,
            structure_state = next_state.next,
            updated_at = now()
       FROM jobs j, tgt, idx, next_state
      WHERE j.id = $1
        AND j.fence_token = $2
        AND j.status = 'running'
        AND v.id = tgt.id
        AND v.id = $3`,
    [
      args.jobId,
      args.fenceToken,
      args.versionId,
      args.field,
      JSON.stringify(args.manifestField),
      args.derivedHard ? JSON.stringify(args.derivedHard) : null,
      JSON.stringify(args.fieldState),
    ],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * 受保护写 manifest + structure_state（同一行单语句一次改两列，§11.A：对父行单语句只改一次）。
 *   软字段落 manifest、字段级真源落 structure_state，原子同改；fence 经 jobs 联表内联。
 *   0 行 = fence out（安全退出，已生成保留）。
 */
export async function writeManifestAndStateProtected(
  db: Queryable,
  args: {
    jobId: string;
    fenceToken: number;
    versionId: string;
    manifest: Manifest;
    state: StructureState;
  },
): Promise<boolean> {
  const res = await db.query(
    `UPDATE capability_versions v
        SET manifest = $4::jsonb, structure_state = $5::jsonb, updated_at = now()
       FROM jobs j
      WHERE j.id = $1
        AND j.fence_token = $2
        AND j.status = 'running'
        AND v.id = $3`,
    [
      args.jobId,
      args.fenceToken,
      args.versionId,
      JSON.stringify(args.manifest),
      JSON.stringify(args.state),
    ],
  );
  return (res.rowCount ?? 0) > 0;
}

// ===========================================================================
// 读 version（worker 起步读 manifest/structure_state/source_candidate_id；端点 B 读 manifest）
// ===========================================================================

export interface VersionRow {
  id: string;
  capabilityId: string;
  slug: string;
  version: string;
  status: string;
  manifest: Manifest;
  structureState: Partial<StructureState>;
  sourceCandidateId: string | null;
  creatorUserId: string;
  /** 行 updated_at（ISO），用作 PATCH 乐观锁 ETag 的来源（§4.E If-Match，Codex P1-5）。 */
  updatedAt: string;
}

/** 据 updated_at 派生弱 ETag（§4.E If-Match 乐观锁）。客户端拿 manifest 时回显此 ETag、PATCH 带回 If-Match。 */
export function etagFromUpdatedAt(updatedAt: string): string {
  return `"${Date.parse(updatedAt) || updatedAt}"`;
}

/** 读 version 全量（manifest/structure_state/血缘 + owner + updated_at，经 capabilities JOIN）。不存在 → null。 */
export async function readVersion(db: Queryable, versionId: string): Promise<VersionRow | null> {
  const res = await db.query<{
    id: string;
    capability_id: string;
    slug: string;
    version: string;
    status: string;
    manifest: Manifest;
    structure_state: Partial<StructureState>;
    source_candidate_id: string | null;
    creator_user_id: string;
    updated_at: string;
  }>(
    `SELECT v.id, v.capability_id, c.slug, v.version, v.status,
            v.manifest, v.structure_state, v.source_candidate_id,
            c.creator_user_id, v.updated_at
       FROM capability_versions v
       JOIN capabilities c ON c.id = v.capability_id
      WHERE v.id = $1`,
    [versionId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    capabilityId: r.capability_id,
    slug: r.slug,
    version: r.version,
    status: r.status,
    manifest: r.manifest,
    structureState: r.structure_state ?? {},
    sourceCandidateId: r.source_candidate_id,
    creatorUserId: r.creator_user_id,
    updatedAt:
      typeof r.updated_at === 'string' ? r.updated_at : new Date(r.updated_at).toISOString(),
  };
}

// ===========================================================================
// B-24 建能力体 draft 版本（三分支，单 PG 事务，§4.A）
// ===========================================================================

export interface CreateCapabilityArgs {
  capabilityId: string;
  versionId: string;
  creatorUserId: string;
  slug: string;
  version: string;
  manifest: Manifest;
  structureState: StructureState;
  sourceCandidateId: string | null;
}

/**
 * ① 从候选新建首版（sourceCandidateId 分支，§4.A）：单事务建 capabilities + capability_versions。
 *   - capabilities：slug 唯一不可变、current_version_id 先空（draft 不回填生效版，发布步才回填）。
 *   - capability_versions：status=draft、manifest 软字段空 + 硬字段锁定、structure_state 软 pending/硬 locked。
 *   id 由应用层预生成（versionId/capabilityId 入参），便于 manifest.id 内联一致 + 幂等回放可定位。
 */
export async function createCapabilityWithVersionInTx(
  tx: Tx,
  args: CreateCapabilityArgs,
): Promise<void> {
  await tx.query(
    `INSERT INTO capabilities (id, creator_user_id, slug, status)
     VALUES ($1, $2, $3, 'active')`,
    [args.capabilityId, args.creatorUserId, args.slug],
  );
  await tx.query(
    `INSERT INTO capability_versions
       (id, capability_id, version, status, manifest, structure_state, source_candidate_id)
     VALUES ($1, $2, $3, 'draft', $4::jsonb, $5::jsonb, $6)`,
    [
      args.versionId,
      args.capabilityId,
      args.version,
      JSON.stringify(args.manifest),
      JSON.stringify(args.structureState),
      args.sourceCandidateId,
    ],
  );
}

/**
 * ②③ 在已有 capability 下建新 draft 版本（capabilityId 建新版本 / fromVersionId 被拒重发派生，§4.A）。
 *   复合 FK 同 capability（INSERT 落 capability_id = 入参 capabilityId）；status=draft、新 versionId、bump 版本号。
 *   软字段起点由调用方传入 manifest（②空软字段 / ③复制源被拒版软字段）；硬字段重锁。
 */
export async function insertNewVersionInTx(
  tx: Tx,
  args: {
    capabilityId: string;
    versionId: string;
    version: string;
    manifest: Manifest;
    structureState: StructureState;
    sourceCandidateId: string | null;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO capability_versions
       (id, capability_id, version, status, manifest, structure_state, source_candidate_id)
     VALUES ($1, $2, $3, 'draft', $4::jsonb, $5::jsonb, $6)`,
    [
      args.versionId,
      args.capabilityId,
      args.version,
      JSON.stringify(args.manifest),
      JSON.stringify(args.structureState),
      args.sourceCandidateId,
    ],
  );
}

/** 读候选（建体 ① 用：取 owner / snapshot 血缘 / name 作 slug 种子）。不存在/非属主 → null。 */
export async function readCandidateForCreate(
  db: Queryable,
  candidateId: string,
  ownerUserId: string,
): Promise<{ id: string; name: string | null; slug: string; status: string } | null> {
  const res = await db.query<{ id: string; name: string | null; slug: string; status: string }>(
    `SELECT id, name, slug, status
       FROM capability_candidates
      WHERE id = $1 AND owner_user_id = $2`,
    [candidateId, ownerUserId],
  );
  return res.rows[0] ?? null;
}

/** 读能力体当前生效版本状态（建体 ② 用：校验 published 才允许 bump 新 draft，§4.A）。非属主 → null。 */
export async function readCapabilityForNewVersion(
  db: Queryable,
  capabilityId: string,
  ownerUserId: string,
): Promise<{
  id: string;
  slug: string;
  currentVersionStatus: string | null;
  currentVersion: string | null;
} | null> {
  const res = await db.query<{
    id: string;
    slug: string;
    current_version_status: string | null;
    current_version: string | null;
  }>(
    `SELECT c.id, c.slug,
            cur.status  AS current_version_status,
            cur.version AS current_version
       FROM capabilities c
       LEFT JOIN capability_versions cur ON cur.id = c.current_version_id
      WHERE c.id = $1 AND c.creator_user_id = $2`,
    [capabilityId, ownerUserId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    slug: r.slug,
    currentVersionStatus: r.current_version_status,
    currentVersion: r.current_version,
  };
}

/**
 * 同事务回填 drafts.version_id + capability_id + current_step='structure' + selection（§4.A：进入下一步也持久化）。
 *   owner 守卫（Codex P0-2）：owner_user_id + status='active' 内联进 WHERE，杜绝覆盖他人草稿的
 *   version_id/capability_id/current_step/selection（建体本身 owner 由候选/能力体校验，但 draftId 是客户端传入、必须独立守门）。
 *   capability_id（P1-5）：真实 capabilities.id 与 version_id 同源回写（建版同事务），DB 续传据它带出
 *     DraftView.capabilityId → STEP⑤ 拒绝态读 publication 命中真实 publication（不再拿 draftId 冒充 404 降级）。
 *   返回是否命中（rowCount>0）：0 行 = draft 不存在 / 非本人 / 非 active → 调用方回滚整事务 + 403/404（不建能力体）。
 */
export async function backfillDraftInTx(
  tx: Tx,
  args: {
    draftId: string;
    versionId: string;
    capabilityId: string;
    ownerUserId: string;
    selection: unknown;
  },
): Promise<boolean> {
  const res = await tx.query(
    `UPDATE drafts
        SET version_id = $2, capability_id = $5, current_step = 'structure',
            selection = $4::jsonb, updated_at = now()
      WHERE id = $1 AND owner_user_id = $3 AND status = 'active'`,
    [
      args.draftId,
      args.versionId,
      args.ownerUserId,
      JSON.stringify(args.selection),
      args.capabilityId,
    ],
  );
  return (res.rowCount ?? 0) > 0;
}

/** withTransaction 直通（建体三分支由 create-capability.ts 在单事务内编排）。 */
export { withTransaction };
export type { TxPool };
