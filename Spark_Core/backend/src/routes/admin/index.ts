import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { registerAuditRoutes } from "./audit.js";
import { registerCampaignRoutes } from "./campaigns.js";
import { registerCommunityRoutes } from "./communities.js";
import { createStaffGuard } from "./guard.js";
import { registerOverviewRoutes } from "./overview.js";
import { registerReportRoutes } from "./reports.js";
import { registerUserRoutes } from "./users.js";

export interface AdminPluginOptions {
  readonly pool: Pool;
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
}
