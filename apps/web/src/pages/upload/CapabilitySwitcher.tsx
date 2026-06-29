// 能力切换列表（F-13/F-14，§5.4/§5.5 左侧）——在这一批能力之间来回切换。
//
// STEP④/⑤ 左侧共用：单选 single 时只一项（仅展示当前能力）；全部发布 all 时列出整批，点选切换右侧内容。
// 每项可带状态徽章（结构化进度 / 发布态），失败项可标红（无连坐：某项失败不影响切到其它项）。
import type { ReactElement } from 'react';

export interface SwitcherItem {
  /** 稳定 key（candidateId / versionId / itemId）。 */
  key: string;
  /** 人话名称。 */
  name: string;
  /** 可选状态徽章文案（如「生成中」「已发布」「失败」）。 */
  badge?: string;
  /** 失败态（标红，无连坐）。 */
  failed?: boolean;
}

export interface CapabilitySwitcherProps {
  items: SwitcherItem[];
  /** 当前选中项 key。 */
  activeKey: string | null;
  onSelect: (key: string) => void;
}

export function CapabilitySwitcher({
  items,
  activeKey,
  onSelect,
}: CapabilitySwitcherProps): ReactElement {
  return (
    <nav className="cb-cap-switcher" aria-label="在这一批能力之间切换">
      <ul className="cb-cap-switcher__list">
        {items.map((it) => {
          const active = it.key === activeKey;
          return (
            <li
              key={it.key}
              className="cb-cap-switcher__item"
              data-failed={it.failed ? 'true' : 'false'}
            >
              <button
                type="button"
                className="cb-cap-switcher__btn"
                aria-current={active ? 'true' : undefined}
                data-active={active ? 'true' : 'false'}
                onClick={() => onSelect(it.key)}
              >
                <span className="cb-cap-switcher__name">{it.name}</span>
                {it.badge && (
                  <span
                    className="cb-cap-switcher__badge"
                    data-failed={it.failed ? 'true' : 'false'}
                  >
                    {it.badge}
                  </span>
                )}
              </button>
            </li>
          );
        })}
        {items.length === 0 && <li className="cb-cap-switcher__empty">还没有可切换的能力。</li>}
      </ul>
    </nav>
  );
}
