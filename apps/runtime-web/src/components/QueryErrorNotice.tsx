// 查询失败的统一提示：401 显示「请先登录」并给创作端登录入口，其余展示人话 + 重试。
import { ApiError, isUnauthenticated } from '../api/client.js';
import { loginUrl } from '../navigation/login.js';

export function QueryErrorNotice({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (isUnauthenticated(error)) {
    return (
      <div className="rt-empty rt-empty--error">
        请先登录。{' '}
        <button
          type="button"
          className="rt-btn rt-btn--accent"
          onClick={() => window.location.assign(loginUrl())}
        >
          去登录
        </button>
      </div>
    );
  }
  const message = error instanceof ApiError ? error.userMessage : '加载失败，请稍后重试。';
  return (
    <div className="rt-empty rt-empty--error">
      {message}{' '}
      <button type="button" className="rt-btn" onClick={onRetry}>
        重试
      </button>
    </div>
  );
}
