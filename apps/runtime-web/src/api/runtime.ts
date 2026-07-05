// 试用端 API：端点函数 + React Query hooks。类型全来自 @cb/shared 试用域契约。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ArtifactView, MessageView, SessionDetail, SessionView } from '@cb/shared';
import { apiGet, apiGetText, apiPost } from './client.js';

/** GET /runtime/capabilities 列表项（runtime 侧 TrialCapabilityItem，shared 未收录，这里对齐声明）。 */
export interface TrialCapability {
  id: string;
  name: string;
  summary: string;
  kind: string;
  published: boolean;
  /** 是否本人创作（前端区分「我的 / 已发布」分组）。 */
  owned: boolean;
  createdAt: string;
}

export function useCapabilities() {
  return useQuery({
    queryKey: ['capabilities'],
    queryFn: () => apiGet<TrialCapability[]>('/runtime/capabilities'),
  });
}

/** 我的会话列表；给 capabilityId 时只取该能力下的会话（对话页侧栏按能力隔离）。 */
export function useSessions(capabilityId?: string) {
  return useQuery({
    queryKey: ['sessions', capabilityId ?? null],
    queryFn: () =>
      apiGet<SessionView[]>(
        capabilityId
          ? `/runtime/sessions?capabilityId=${encodeURIComponent(capabilityId)}`
          : '/runtime/sessions',
      ),
  });
}

export function useSession(id: string | undefined) {
  return useQuery({
    queryKey: ['session', id],
    queryFn: () => apiGet<SessionDetail>(`/runtime/sessions/${id}`),
    enabled: Boolean(id),
  });
}

export function useCreateSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (capabilityId: string) =>
      apiPost<SessionView>('/runtime/sessions', { capabilityId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

/** 发消息：202 即返回（user 消息已落库，生成在后端异步跑，进展经 /stream 订阅）。 */
export function sendSessionMessage(sessionId: string, text: string): Promise<MessageView> {
  return apiPost<{ message: MessageView }>(`/runtime/sessions/${sessionId}/messages`, {
    text,
  }).then((r) => r.message);
}

/** 打断当前轮（无进行中的轮 → interrupted=false，幂等）。 */
export function interruptSession(sessionId: string): Promise<{ interrupted: boolean }> {
  return apiPost<{ interrupted: boolean }>(`/runtime/sessions/${sessionId}/interrupt`);
}

/** 产物内容回读（裸文本；updatedAt 进 key，产物更新后自动拉新版）。 */
export function useArtifactContent(artifact: ArtifactView | null) {
  const id = artifact?.id;
  return useQuery({
    queryKey: ['artifact-content', id, artifact?.updatedAt],
    queryFn: () => apiGetText(`/runtime/artifacts/${id}/content`),
    enabled: Boolean(id),
  });
}
