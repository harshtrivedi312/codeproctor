// The whole seed as data (DB-04): a pure function of `now`. Nothing here touches a database, so a
// test can build the plan and check it without one. The applier (apply.ts) inserts what is missing.
import { buildContent, type ContentPlan } from './content';
import { buildDelivery, type DeliveryPlan } from './delivery';

export interface SeedPlan {
  readonly content: ContentPlan;
  readonly delivery: DeliveryPlan;
}

export function buildSeedPlan(now: Date): SeedPlan {
  const content = buildContent(now);
  return { content, delivery: buildDelivery(now, content) };
}
