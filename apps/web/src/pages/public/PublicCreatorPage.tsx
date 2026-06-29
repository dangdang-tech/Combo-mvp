// 公开创作者主页 /c/:slug（对外只读，裸壳 PublicLayout，无创作者外壳）。
//
// 本期范围（契约 §2.9）：公开创作者 by-slug 后端端点本期范围外、仅契约冻结、不造。
//   故此页不拉数据、不伪造主页：诚实告知「公开创作者主页即将上线」，不裸 404、不裸转圈、不渗漏内部文案。
//   此前 /c/... 无路由 → 落 404 占位、渗漏开发脚手架文案；此页同时堵掉该泄漏路径（BUG-006）。
import type { ReactElement } from 'react';

export function PublicCreatorPage(): ReactElement {
  return (
    <section className="cb-page cb-public" aria-labelledby="cb-public-creator-title">
      <div className="cb-public__notice">
        <h2 className="cb-public__title" id="cb-public-creator-title">
          公开创作者主页即将上线
        </h2>
        <p className="cb-public__lead">
          创作者的对外只读主页正在筹备中，将随市集消费侧一起开放。敬请期待。
        </p>
      </div>
    </section>
  );
}
