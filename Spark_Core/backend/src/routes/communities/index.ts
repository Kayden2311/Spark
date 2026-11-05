import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { registerDiscoveryRoutes } from "./discovery.js";

export interface CommunityPluginOptions {
  readonly pool: Pool;
}

/** Community API (`/api/v1/communities/*`, `/api/v1/me/communities`). */
export function registerCommunityRoutes(app: FastifyInstance, options: CommunityPluginOptions): void {
  registerDiscoveryRoutes(app, options.pool);
}
