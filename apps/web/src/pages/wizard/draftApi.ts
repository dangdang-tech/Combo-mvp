// 向导草稿数据层（F-12 / F-15）——草稿 bootstrap + STEP③ 存草稿 selection PATCH + 续传读草稿。
//
// 端点真源（脊柱 §8 / 40 §4.G / _index §2）：
//   - POST /api/v1/drafts（写命令，scope=draft.create）：新建流程 STEP① 进入时 bootstrap 真实草稿行，
//     拿 draftId 贯穿后续 snapshot/extract/version/capability/batch 全部回填同一 draft（断点续传基线，P0-2）。
//   - GET  /api/v1/drafts/{draftId}（只读）：按 draftId 读完整 DraftView 续传 hydrate（后端已就绪，端点数 52→54）。
//   - PATCH /api/v1/drafts/{draftId}/selection（写命令，scope=draft.selection.patch）：STEP③ 显式存草稿 /
//     进入下一步前持久化选择；选择切换本身不调它（纯前端即时态，§1.1(a)）。
import {
  IdempotencyScope,
  type CreateDraftBody,
  type DraftView,
  type SelectionDraft,
  type PatchSelectionBody,
} from '@cb/shared';
import { ApiError, apiGet, apiPatch, apiPost, type RequestOptions } from '../../api/index.js';
import { fetchDrafts } from '../dashboard/api.js';

/** 草稿 bootstrap 端点路径（脊柱 §8，写命令 scope=draft.create）。 */
export function draftsPath(): string {
  return '/drafts';
}

/** 单条草稿读端点路径（GET，续传 hydrate；后端已就绪）。 */
export function draftPath(draftId: string): string {
  return `/drafts/${encodeURIComponent(draftId)}`;
}

/** STEP③ 存草稿端点路径（drafts.selection + current_step='select' 持久化，40 §4.G）。 */
export function selectionPath(draftId: string): string {
  return `/drafts/${encodeURIComponent(draftId)}/selection`;
}

/**
 * 新建流程 bootstrap：建一行真实草稿（status='active'、currentStep='import'、落点引用全空），返回 DraftView（含 draftId）。
 *   - 写命令必带 Idempotency-Key（client 自动注入）+ scope=`draft.create`（脊柱 §4 / 硬规则③）。
 *   - 同一 idempotencyKey 重复点新建 → 回放首次结果（同 draftId，不重复建行）；STEP① 进入用稳定 key 兜重渲染/刷新重建。
 *   - title 可选（草稿条可读标题，区分多条；缺省后端置 NULL，前端后续据导入/能力名补）。
 * @returns 后端回 `DraftView`（draftId + currentStep='import' + 引用全空），前端写入 WizardContext + 续传 URL。
 */
export async function createDraft(
  params: { title?: string | undefined; idempotencyKey?: string | undefined } = {},
  opts: RequestOptions = {},
): Promise<DraftView> {
  const body: CreateDraftBody = params.title !== undefined ? { title: params.title } : {};
  return apiPost<DraftView>(draftsPath(), body, {
    ...opts,
    scope: IdempotencyScope.DRAFT_CREATE,
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
  });
}

/**
 * 续传：按 draftId 读完整 DraftView（GET /drafts/{id}，后端已就绪）。
 *   非本人 / 不存在 / 已终态 → 后端 404（不暴露存在性）；本层抛 ApiError（上层落「草稿可能已删除」退路，不裸崩）。
 */
export async function getDraft(draftId: string, opts: RequestOptions = {}): Promise<DraftView> {
  return apiGet<DraftView>(draftPath(draftId), opts);
}

/**
 * STEP③ 显式存草稿：PATCH selection（持久化 `drafts.selection` + `current_step='select'`，B-24 续传）。
 *   - 写命令必带 Idempotency-Key（client 自动注入）+ scope=`draft.selection.patch`（40 §4.G，PATCH 最后写赢）。
 *   - 同一 draftId 重复保存可复用 idempotencyKey（已生成不丢、重复点/刷新只存一次，硬规则③）。
 *   - 选择切换本身**不调本函数**（纯前端，§1.1(a)）；仅「保存草稿」按钮 / 进入下一步前调用。
 * @returns 后端回 `DraftView`（currentStep='select' + selection 全量，供前端确认已存草稿）。
 */
export async function patchSelection(
  draftId: string,
  selection: SelectionDraft,
  idempotencyKey?: string,
): Promise<DraftView> {
  const body: PatchSelectionBody = { selection };
  return apiPatch<DraftView>(selectionPath(draftId), body, {
    scope: IdempotencyScope.DRAFT_SELECTION_PATCH,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
}

/**
 * 续传：按 draftId 定位草稿（服务「只有 draftId 的深链续传」，工作台草稿条点击已直接持有 DraftView）。
 * 首选单条 GET /drafts/{id}（后端已就绪，O(1) 命中）；命中即回。
 * 命中失败（不存在/越权/已终态 404，或 500/网络瞬时错误）→ 回落翻 /dashboard/drafts 列表查找（最多 maxPages 页防失控），
 *   active 草稿仍能在列表里找到、真没了就回 undefined（上层落「草稿可能已删除」退路，不裸崩）。
 *   注：ApiError 不携状态码（D1 不裸露 code/status），故不据状态码分流，统一回落列表确权——既不误报「找到」也不裸崩。
 */
export async function findDraftById(
  draftId: string,
  opts: { signal?: AbortSignal; maxPages?: number } = {},
): Promise<DraftView | undefined> {
  const signalOpts: RequestOptions = opts.signal ? { signal: opts.signal } : {};
  try {
    return await getDraft(draftId, signalOpts);
  } catch (e) {
    // 中止透传（上层据 AbortError 静默）；其余错误回落列表扫描兜底。
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    if (e instanceof ApiError && e.action === 'change_input' && !e.retriable) {
      // 确定性「找不到」（GET 404：action=change_input + 不可重试）→ 直接 undefined，不徒劳翻列表。
      return undefined;
    }
  }
  const maxPages = opts.maxPages ?? 10;
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const res = await fetchDrafts({ cursor }, signalOpts);
    const hit = res.items.find((d) => d.id === draftId);
    if (hit) return hit;
    if (!res.page?.hasMore || !res.page.nextCursor) break;
    cursor = res.page.nextCursor;
  }
  return undefined;
}
