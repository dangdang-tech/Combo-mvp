// 试用端 API：端点函数 + React Query hooks。类型全来自 @cb/shared runtime-api 契约。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateSessionBody,
  PublicCapabilityView,
  RuntimeCapabilityList,
  RuntimeSessionList,
  RuntimeSessionMeta,
  SessionDetail,
} from '@cb/shared';
import { apiGet, apiPost } from './client.js';

export interface CreateSessionResult {
  session: RuntimeSessionMeta;
  capability: PublicCapabilityView;
}

export function useCapabilities() {
  return useQuery({
    queryKey: ['capabilities'],
    queryFn: () => apiGet<RuntimeCapabilityList>('/runtime/capabilities'),
  });
}

export function useSessions(capabilitySlug?: string) {
  const query = capabilitySlug ? `?slug=${encodeURIComponent(capabilitySlug)}` : '';
  return useQuery({
    queryKey: capabilitySlug ? ['sessions', capabilitySlug] : ['sessions'],
    queryFn: () => apiGet<RuntimeSessionList>(`/runtime/sessions${query}`),
  });
}

export function useSession(id: string | undefined) {
  return useQuery({
    queryKey: ['session', id],
    queryFn: () => apiGet<SessionDetail>(`/runtime/sessions/${id}`),
    enabled: Boolean(id),
    // staleTime 用默认 0：进入/切回会话时回拉最新已落库状态；活跃回合中由 ChatPage hydrate 的 !isSending 闸防覆盖。
  });
}

export function useCreateSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateSessionBody) =>
      apiPost<CreateSessionResult>('/runtime/sessions', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

export function createTrialSession(slugOrId: string): Promise<CreateSessionResult> {
  return apiPost<CreateSessionResult>(
    `/runtime/trial-chains/${encodeURIComponent(slugOrId)}/sessions`,
    { slugOrId },
  );
}

export function createProductionSession(
  slugOrId: string,
  title?: string,
): Promise<CreateSessionResult> {
  return apiPost<CreateSessionResult>('/runtime/sessions', {
    slugOrId,
    mode: 'consume',
    title,
  });
}
