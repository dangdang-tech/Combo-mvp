// 个人主页状态机（F-06）——主聚合一次拉六分区，分区局部失败用后端 sectionErrors 派生，
// 局部错误条 + 子端点重试（主页-17，整页不崩）。
//
// 设计：
//   - 整页级：主聚合 loading / error（404 / 整页 500）。主聚合成功后整页恒在，其余皆分区级。
//   - 分区级：density / heatmap / network / works 各自可「局部失败 → 局部重试（子端点）」。
//     局部失败的真源是后端 CreatorProfile.sectionErrors（前端不自造），重试成功后只 patch 该分区。
//   - 派生 displayState：每分区一个 ok | error | retrying 三态，从主聚合数据 + 重试态派生，组件据此渲染。
//   - 密度榜「展开更多」、作品墙翻页：调子端点拿更多，合并进对应分区（hasMore 由后端给）。
//     cursor 不透明（脊柱 §2.3，前端不可构造）：主聚合切片不含 cursor，故首次「展开/翻页」用更大 limit
//     一次取全替换，之后若后端给 nextCursor 则按 cursor 续翻——绝不前端伪造 opaque cursor。
// 公开只读：本 hook 只发 GET，不发任何写命令、不碰经营维度。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CreatorProfile, ProfileSectionKey, Meta } from '@cb/shared';
import { ApiError } from '../../api/index.js';
import { fetchProfile, fetchDensity, fetchHeatmap, fetchNetwork, fetchWorks } from './api.js';

/**
 * 可局部失败/局部重试的分区键（hero 随主聚合恒在，不在此列）。
 *   metrics 也纳入（Codex r1#2）：后端 caps 源失败时给 metrics:null + sectionErrors[metrics]，
 *   前端必须出局部错误条 + 重试（不静默吞）。metrics 无独立子端点，重试走整页聚合（见 retrySection）。
 */
export type RetriableSection = 'metrics' | 'density' | 'heatmap' | 'network' | 'works';

/** 分区展示态（派生）：ok=有数据可渲染；error=后端标记该分区失败（出局部错误条）；retrying=正在子端点重试。 */
export type SectionDisplayState = 'ok' | 'error' | 'retrying';

export type ProfilePhase = 'loading' | 'error' | 'ready';

/** 「展开更多」一次取全的上限（密度榜 limit 上限 50，§2.3）。 */
const DENSITY_EXPAND_LIMIT = 50;
/** 作品墙翻页一次取的页大小（§2.6 上限 60）。 */
const WORKS_PAGE_LIMIT = 24;

export interface UseProfileState {
  phase: ProfilePhase;
  /** 整页级错误（404 / 整页聚合失败）；phase==='error' 时有值。 */
  error: unknown;
  /** 主聚合数据（phase==='ready' 时有值）。 */
  profile: CreatorProfile | null;
  /** 主聚合 meta（usage 占位 placeholders 真源）。 */
  meta: Meta | undefined;
  /** 每分区展示态（从 sectionErrors + 重试态派生）。 */
  sectionState: Record<RetriableSection, SectionDisplayState>;
  /** 整页重试（404/整页失败时）。 */
  retry: () => void;
  /** 分区局部重试（调对应子端点，成功后只 patch 该分区）。 */
  retrySection: (section: RetriableSection) => void;
  /** 密度榜「展开更多」（合并进 density.rows）。 */
  loadMoreDensity: () => void;
  /** 密度榜展开中标记。 */
  densityLoadingMore: boolean;
  /** 作品墙翻页（合并进 works.cards）。 */
  loadMoreWorks: () => void;
  /** 作品墙翻页中标记。 */
  worksLoadingMore: boolean;
}

const RETRIABLE_SECTIONS: RetriableSection[] = [
  'metrics',
  'density',
  'heatmap',
  'network',
  'works',
];

/** 从 sectionErrors 派生：被标记 → error；否则 ok（重试态由调用方叠加）。 */
function deriveSectionState(
  profile: CreatorProfile,
): Record<RetriableSection, SectionDisplayState> {
  const failed = new Set<ProfileSectionKey>(profile.sectionErrors.map((e) => e.section));
  const state = {} as Record<RetriableSection, SectionDisplayState>;
  for (const s of RETRIABLE_SECTIONS) {
    state[s] = failed.has(s) ? 'error' : 'ok';
  }
  return state;
}

export function useProfile(creatorId: string): UseProfileState {
  const [phase, setPhase] = useState<ProfilePhase>('loading');
  const [error, setError] = useState<unknown>(null);
  const [profile, setProfile] = useState<CreatorProfile | null>(null);
  const [meta, setMeta] = useState<Meta | undefined>(undefined);
  const [sectionState, setSectionState] = useState<Record<RetriableSection, SectionDisplayState>>({
    metrics: 'ok',
    density: 'ok',
    heatmap: 'ok',
    network: 'ok',
    works: 'ok',
  });
  const [densityLoadingMore, setDensityLoadingMore] = useState(false);
  const [worksLoadingMore, setWorksLoadingMore] = useState(false);
  // 续翻 cursor（来自子端点 page.nextCursor；主聚合切片不带 cursor 故初始 undefined）。
  const densityCursor = useRef<string | undefined>(undefined);
  const worksCursor = useRef<string | undefined>(undefined);
  // 整页 retry 触发器（自增以重跑 effect）。
  const [reloadTick, setReloadTick] = useState(0);
  // 卸载守卫：避免在已卸载组件上 setState。
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    const controller = new AbortController();
    setPhase('loading');
    setError(null);
    densityCursor.current = undefined;
    worksCursor.current = undefined;
    fetchProfile(creatorId, { signal: controller.signal })
      .then((res) => {
        if (!aliveRef.current) return;
        setProfile(res.data);
        setMeta(res.meta);
        setSectionState(deriveSectionState(res.data));
        // 作品墙首屏切片的续翻游标由后端铸造（§2.6，Codex r1#5）：首次「加载更多」即按此真追加，不重拉首页替换。
        worksCursor.current = res.data.works?.nextCursor ?? undefined;
        setPhase('ready');
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (!aliveRef.current) return;
        setError(err);
        setPhase('error');
      });
    return () => {
      aliveRef.current = false;
      controller.abort();
    };
  }, [creatorId, reloadTick]);

  const retry = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);

  // 分区局部重试：标 retrying → 调子端点 → 成功只 patch 该分区 + 从 sectionErrors 摘除；失败回到 error。
  //   metrics 无独立子端点（指标带随主聚合派生），其重试走整页聚合重拉（reloadTick），与契约
  //   §2.7「重试走整页聚合或补 metrics 子端点」一致——不静默吞、点了有可见结果（Codex r1#2）。
  const retrySection = useCallback(
    (section: RetriableSection) => {
      if (section === 'metrics') {
        setSectionState((s) => ({ ...s, metrics: 'retrying' }));
        setReloadTick((t) => t + 1); // effect 重跑主聚合 → 成功后 deriveSectionState 复位全分区。
        return;
      }
      const id = creatorId;
      setSectionState((s) => ({ ...s, [section]: 'retrying' }));

      const onOk = (patch: (p: CreatorProfile) => CreatorProfile): void => {
        if (!aliveRef.current) return;
        setProfile((p) =>
          p
            ? {
                ...patch(p),
                sectionErrors: p.sectionErrors.filter((e) => e.section !== section),
              }
            : p,
        );
        setSectionState((s) => ({ ...s, [section]: 'ok' }));
      };
      const onFail = (): void => {
        if (!aliveRef.current) return;
        setSectionState((s) => ({ ...s, [section]: 'error' }));
      };

      if (section === 'density') {
        fetchDensity(id, { limit: DENSITY_EXPAND_LIMIT })
          .then((res) => {
            densityCursor.current = res.page?.nextCursor ?? undefined;
            onOk((p) => ({
              ...p,
              density: { rows: res.items, hasMore: res.page?.hasMore ?? false },
            }));
          })
          .catch(onFail);
      } else if (section === 'heatmap') {
        fetchHeatmap(id)
          .then((res) =>
            onOk((p) => ({ ...p, heatmap: res.data, heatmapEnabled: res.data.enabled })),
          )
          .catch(onFail);
      } else if (section === 'network') {
        fetchNetwork(id)
          .then((res) => onOk((p) => ({ ...p, network: res.data })))
          .catch(onFail);
      } else {
        fetchWorks(id, { limit: WORKS_PAGE_LIMIT })
          .then((res) => {
            worksCursor.current = res.page?.nextCursor ?? undefined;
            onOk((p) => ({
              ...p,
              works: {
                cards: res.items,
                hasMore: res.page?.hasMore ?? false,
                nextCursor: res.page?.nextCursor ?? null,
              },
            }));
          })
          .catch(onFail);
      }
    },
    [creatorId],
  );

  const loadMoreDensity = useCallback(() => {
    const cur = profile?.density;
    if (!cur || !cur.hasMore || densityLoadingMore) return;
    setDensityLoadingMore(true);
    const cursor = densityCursor.current;
    // 无 cursor（首次从聚合切片展开）→ 一次取全（更大 limit）替换；有 cursor → 续翻追加。
    fetchDensity(creatorId, cursor ? { cursor } : { limit: DENSITY_EXPAND_LIMIT })
      .then((res) => {
        if (!aliveRef.current) return;
        densityCursor.current = res.page?.nextCursor ?? undefined;
        setProfile((p) =>
          p && p.density
            ? {
                ...p,
                density: {
                  rows: cursor ? mergeRows(p.density.rows, res.items) : res.items,
                  hasMore: res.page?.hasMore ?? false,
                },
              }
            : p,
        );
      })
      .catch(() => {
        /* 展开更多失败：保留已展开内容，不整页崩；按钮恢复可点供再试。 */
      })
      .finally(() => {
        if (aliveRef.current) setDensityLoadingMore(false);
      });
  }, [creatorId, profile, densityLoadingMore]);

  const loadMoreWorks = useCallback(() => {
    const cur = profile?.works;
    if (!cur || !cur.hasMore || worksLoadingMore) return;
    setWorksLoadingMore(true);
    // cursor 自首屏切片即由后端铸造（§2.6，Codex r1#5），故「加载更多」恒带 cursor → 真追加（按 capabilityId 去重），
    //   不再首次重拉首页替换原卡。仅在极端无 cursor（旧后端兼容）时回退一次取页（mergeCards 仍去重防错位）。
    const cursor = worksCursor.current;
    fetchWorks(creatorId, cursor ? { cursor } : { limit: WORKS_PAGE_LIMIT })
      .then((res) => {
        if (!aliveRef.current) return;
        worksCursor.current = res.page?.nextCursor ?? undefined;
        setProfile((p) =>
          p && p.works
            ? {
                ...p,
                works: {
                  // 有 cursor → 追加去重；无 cursor 回退 → 合并去重（不盲目替换丢已加载卡）。
                  cards: mergeCards(p.works.cards, res.items),
                  hasMore: res.page?.hasMore ?? false,
                  nextCursor: res.page?.nextCursor ?? null,
                },
              }
            : p,
        );
      })
      .catch(() => {
        /* 翻页失败：保留已加载卡，不整页崩。 */
      })
      .finally(() => {
        if (aliveRef.current) setWorksLoadingMore(false);
      });
  }, [creatorId, profile, worksLoadingMore]);

  return {
    phase,
    error,
    profile,
    meta,
    sectionState,
    retry,
    retrySection,
    loadMoreDensity,
    densityLoadingMore,
    loadMoreWorks,
    worksLoadingMore,
  };
}

/** 合并密度行：按 capabilityId 去重追加（防 cursor 边界重复）。 */
function mergeRows<T extends { capabilityId: string }>(prev: T[], next: T[]): T[] {
  const seen = new Set(prev.map((x) => x.capabilityId));
  return [...prev, ...next.filter((x) => !seen.has(x.capabilityId))];
}
/** 合并作品卡：按 capabilityId 去重追加。 */
function mergeCards<T extends { capabilityId: string }>(prev: T[], next: T[]): T[] {
  return mergeRows(prev, next);
}

export { ApiError };
