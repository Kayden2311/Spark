import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { createMemberGuard } from "../workspace/guard.js";
import { registerCommentRoutes } from "./comments.js";
import { registerDiscoveryRoutes } from "./discovery.js";
import { registerManagementRoutes } from "./management.js";
import { registerMembershipRoutes } from "./membership.js";
import { registerPostRoutes } from "./posts.js";

export interface CommunityPluginOptions {
  readonly pool: Pool;
}

/**
 * Community API (`/api/v1/communities/*`, `/api/v1/me/communities`, `/api/v1/me/community-requests`,
 * `/api/v1/community-requests/*`, `/api/v1/workspaces/{id}/communities`). Discovery works without a
 * session; membership and management need one, and the database re-checks every standing.
 */
export function registerCommunityRoutes(app: FastifyInstance, options: CommunityPluginOptions): void {
  const guard = createMemberGuard(options.pool);
  registerDiscoveryRoutes(app, options.pool);
  registerMembershipRoutes(app, guard);
  registerManagementRoutes(app, guard);
  registerPostRoutes(app, options.pool, guard);
  registerCommentRoutes(app, options.pool, guard);
}
