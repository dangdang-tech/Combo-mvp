// B-14 · consumer 路由表（70 §1/§3）。按 ACTIVE_OUTBOX_TOPICS 把 topic 分派到 consumer：
//   MarketplaceProjection（capability.* lifecycle，【一条】合并流配置 + 单 cursor，按 topic IN(...)
//                          AND seq>cursor ORDER BY seq 合并消费，保上架/下架严格全局顺序——P0-2）
//   NotifyConsumer       （notify.*，每子 topic 一条配置 + 按 (consumer_name, topic) 拆多行游标，
//                          某子 topic 毒丸不卡其它）
//   MeteringConsumer     （usage.metering，本期【不启动】，登记不挂 process）
import { ACTIVE_OUTBOX_TOPICS, MERGED_LIFECYCLE_CURSOR_TOPIC, type OutboxTopic } from '@cb/shared';
import type { ConsumerTopicConfig, EventProcessor } from './consumer-core.js';
import { marketplaceProjection } from './marketplace-projection.js';
import { notifyConsumer } from './notify-consumer.js';

export const CONSUMER_NAMES = {
  marketplace: 'MarketplaceProjection',
  notify: 'NotifyConsumer',
  metering: 'MeteringConsumer', // 本期不启动
} as const;

/**
 * MarketplaceProjection 合并流的单 cursor key（consumer_cursors.topic 列值）。
 * lifecycle 的 capability.published/unpublished 共用这一条 cursor 行，按合并 seq 流单调推进，
 * 保上架/下架严格全局顺序（不能按子 topic 拆 cursor，否则破坏合并流顺序——P0-2）。
 * 取一个不与任何真实 OutboxTopic 冲突的稳定字面量（'capability.*'，与 shared 的
 * MERGED_LIFECYCLE_CURSOR_TOPIC 同一真源；schema 侧 ConsumerCursorTopicSchema 已容纳）。
 */
export const MARKETPLACE_LIFECYCLE_CURSOR_TOPIC: string = MERGED_LIFECYCLE_CURSOR_TOPIC;

/** topic → consumerName + processor（本期实际产生的 active topic 全集）。 */
const ROUTE: Record<OutboxTopic, { consumerName: string; process: EventProcessor } | undefined> = {
  'capability.published': {
    consumerName: CONSUMER_NAMES.marketplace,
    process: marketplaceProjection,
  },
  'capability.unpublished': {
    consumerName: CONSUMER_NAMES.marketplace,
    process: marketplaceProjection,
  },
  'notify.import_completed': { consumerName: CONSUMER_NAMES.notify, process: notifyConsumer },
  'notify.extract_completed': { consumerName: CONSUMER_NAMES.notify, process: notifyConsumer },
  'notify.publish_completed': { consumerName: CONSUMER_NAMES.notify, process: notifyConsumer },
  'notify.review_decided': { consumerName: CONSUMER_NAMES.notify, process: notifyConsumer },
  'usage.metering': undefined, // 本期不启动 MeteringConsumer
  'runtime.session_event': undefined, // B-40 冻结
};

/** active 全集里属于 MarketplaceProjection 的 lifecycle topic（合并流成员，按 seq 合并消费）。 */
function lifecycleTopics(): OutboxTopic[] {
  return ACTIVE_OUTBOX_TOPICS.filter((t) => ROUTE[t]?.consumerName === CONSUMER_NAMES.marketplace);
}

/**
 * 构建本期所有活跃 cursor 配置（onAlert 由调用方注入）。
 *   - MarketplaceProjection（lifecycle）：capability.published/unpublished 合成【一条】配置
 *     （topics=[两者]、cursorTopic=合并 key）→ 按 `topic IN (...) AND seq > cursor ORDER BY seq`
 *     拉合并流、单 cursor 单调推进，保上架/下架严格全局顺序（P0-2 修复点）。
 *   - NotifyConsumer：每个 notify 子 topic 一条配置（topics=[该 topic]、cursorTopic=该 topic）
 *     → 按 topic 拆多行游标，某子 topic 毒丸不卡其它（§4.1）。
 * 同名 consumer + 单实例 advisory lock 保证全局单活、顺序消费。
 */
export function buildConsumerConfigs(
  onAlert?: ConsumerTopicConfig['onAlert'],
): ConsumerTopicConfig[] {
  const configs: ConsumerTopicConfig[] = [];
  const alertSpread = onAlert ? { onAlert } : {};

  // MarketplaceProjection：lifecycle 合并流单 cursor（P0-2：不按子 topic 拆 cursor）。
  const lifecycle = lifecycleTopics();
  if (lifecycle.length > 0) {
    configs.push({
      consumerName: CONSUMER_NAMES.marketplace,
      topics: lifecycle,
      cursorTopic: MARKETPLACE_LIFECYCLE_CURSOR_TOPIC,
      process: marketplaceProjection,
      ...alertSpread,
    });
  }

  // NotifyConsumer：每个 notify 子 topic 一条配置（按 topic 拆 cursor）。
  for (const topic of ACTIVE_OUTBOX_TOPICS) {
    const route = ROUTE[topic];
    if (!route || route.consumerName !== CONSUMER_NAMES.notify) continue;
    configs.push({
      consumerName: route.consumerName,
      topics: [topic],
      cursorTopic: topic,
      process: route.process,
      ...alertSpread,
    });
  }

  return configs;
}

/** 取某 topic 的路由（供 sweeper 死信补投按 topic 找回 processor）。 */
export function routeForTopic(
  topic: string,
): { consumerName: string; process: EventProcessor } | undefined {
  return ROUTE[topic as OutboxTopic];
}

/**
 * outbox topic → consumer_cursors.topic（cursorTopic）映射（P1 滞留巡查修复）。
 *   - lifecycle（capability.published/unpublished）→ 合并 cursor key `capability.*`（共用一行游标，P0-2）。
 *   - notify 子 topic → 自身（各拆一行游标）。
 * sweeper 的滞留巡查按此映射比对 cursor，与 consumer-core 的 cursorTopic 语义一致——
 * 不再用 `cursor.topic = outbox.topic` 直比（那会把已消费的 capability.* 误报滞留）。
 * 从 buildConsumerConfigs 派生（同一真源），避免映射与实际消费配置漂移。
 */
export function topicToCursorTopic(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const cfg of buildConsumerConfigs()) {
    for (const topic of cfg.topics) map[topic] = cfg.cursorTopic;
  }
  return map;
}
