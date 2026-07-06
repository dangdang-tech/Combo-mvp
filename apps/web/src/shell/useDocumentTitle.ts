// 按路由设置 document.title（#29）：公开分享链接的 tab/预览此前全显示「Combo 创作者中心」。
import { useEffect } from 'react';

const DEFAULT_TITLE = 'Combo 创作者中心';

/** 设置页面标题；卸载时还原默认。传 undefined 时不动（数据未就绪）。 */
export function useDocumentTitle(title: string | undefined): void {
  useEffect(() => {
    if (!title) return;
    document.title = title;
    return () => {
      document.title = DEFAULT_TITLE;
    };
  }, [title]);
}
