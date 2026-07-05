// 按路由设置 document.title（#29）：消费端多个会话 tab 此前无法区分。
import { useEffect } from 'react';

const DEFAULT_TITLE = 'Combo · 试用';

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
