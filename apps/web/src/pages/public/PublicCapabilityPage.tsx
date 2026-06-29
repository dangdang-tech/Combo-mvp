// 公开能力页 /a/:slug（对外只读，裸壳 PublicLayout，无创作者外壳）。
//
// 本期范围（契约 §2.9）：公开能力详情后端端点（GET /api/v1/apps/{slug}）本期范围外、仅契约冻结、不造。
//   故此页不拉数据、不伪造卡片：诚实告知「公开能力页即将上线」，不裸 404、不裸转圈、不渗漏内部文案。
//   待消费侧上线接通真实端点后，再在此渲染真实只读卡。
import type { ReactElement } from 'react';

export function PublicCapabilityPage(): ReactElement {
  return (
    <section className="cb-page cb-public" aria-labelledby="cb-public-capability-title">
      <div className="cb-public__notice">
        <h2 className="cb-public__title" id="cb-public-capability-title">
          公开能力页即将上线
        </h2>
        <p className="cb-public__lead">
          能力的对外只读页正在筹备中，将随市集消费侧一起开放。敬请期待。
        </p>
      </div>
    </section>
  );
}
