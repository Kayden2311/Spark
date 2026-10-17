import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Pool } from "pg";

import type { RequestMetrics } from "../../infrastructure/metrics.js";

import { registerAnalyticsRoutes } from "./analytics.js";
import { registerAuditRoutes } from "./audit.js";
import { registerBillingRoutes } from "./billing.js";
import { registerCampaignRoutes } from "./campaigns.js";
import { registerCommunityRoutes } from "./communities.js";
import { createStaffGuard } from "./guard.js";
import { registerOverviewRoutes } from "./overview.js";
import { registerReportRoutes } from "./reports.js";
import { registerSystemRoutes } from "./system.js";
import { registerUserRoutes } from "./users.js";

export interface AdminPluginOptions {
  readonly pool: Pool;
  readonly redis?: Redis | undefined;
  readonly metrics?: RequestMetrics | undefined;
}

/**
 * Platform governance API (`/api/v1/admin/*`). Every route checks the caller's platform role, then runs
 * inside a transaction bound to the caller's session so the database re-checks the role and records
 * each write in spark.platform_audit_events.
 */
export function registerAdminRoutes(app: FastifyInstance, options: AdminPluginOptions): void {
  const guard = createStaffGuard(options.pool);
  registerOverviewRoutes(app, guard);
  registerReportRoutes(app, guard);
  registerCommunityRoutes(app, guard);
  registerUserRoutes(app, guard);
  registerCampaignRoutes(app, guard);
  registerAuditRoutes(app, guard);
  registerAnalyticsRoutes(app, guard);
  registerBillingRoutes(app, guard);
  registerSystemRoutes(app, guard, { pool: options.pool, redis: options.redis, metrics: options.metrics });
}
