// 市集卡来源说明表（F-14，§5.5 右侧）——卡的每个位置分别从哪来（发布-06）。
//
// 静态映射（依 MarketCard schema 渲染，不另开端点，50 §2.2 注）：
//   名称 / 一句话卖点 ← 软字段（发布前可改）；封面 / 价格 ← 创作者设定；署名 ← 自动取账号；
//   装机量 / 评分 ← 上线后真实数据；试用 ← 系统固定。
import type { ReactElement } from 'react';

const SOURCE_ROWS: ReadonlyArray<{ position: string; from: string }> = [
  { position: '名称、一句话卖点', from: '来自上一步 App Identity 的软字段，发布前可改' },
  { position: '封面图标、价格', from: '由创作者在发布前自己设定' },
  { position: '创作者署名', from: '自动取创作者账号' },
  { position: '装机量、评分', from: '上线后由真实使用数据填充' },
  { position: '试用按钮', from: '系统固定，所有能力卡都有' },
];

export function SourceTable(): ReactElement {
  return (
    <aside className="cb-source-table" aria-label="市集卡各位置的来源说明">
      <h3 className="cb-source-table__title">这张卡从哪来</h3>
      <table className="cb-source-table__table">
        <thead>
          <tr>
            <th scope="col">卡片上的位置</th>
            <th scope="col">内容从哪来</th>
          </tr>
        </thead>
        <tbody>
          {SOURCE_ROWS.map((r) => (
            <tr key={r.position}>
              <td className="cb-source-table__pos">{r.position}</td>
              <td className="cb-source-table__from">{r.from}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </aside>
  );
}
