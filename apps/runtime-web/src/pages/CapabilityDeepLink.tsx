// 深链承接页：创作端「去试用」跳 /try/c/:capabilityId，进来即为该能力建会话并转入对话页。
// 建会话失败（未发布且非本人 / 已删除）→ 提示后回市集页。
import { useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useCreateSession } from '../api/runtime.js';

export function CapabilityDeepLink() {
  const { capabilityId } = useParams<{ capabilityId: string }>();
  const navigate = useNavigate();
  const createSession = useCreateSession();
  const fired = useRef(false);

  useEffect(() => {
    if (!capabilityId || fired.current) return;
    fired.current = true; // StrictMode 双跑守卫：只建一次会话
    createSession.mutate(capabilityId, {
      onSuccess: (session) => navigate(`/session/${session.id}`, { replace: true }),
      onError: () => navigate('/market', { replace: true }),
    });
  }, [capabilityId, createSession, navigate]);

  return <p className="rt-deeplink">正在为你打开试用会话…</p>;
}
