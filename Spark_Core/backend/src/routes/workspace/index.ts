import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import { createMemberGuard } from "./guard.js";
import { registerMemberRoutes } from "./members.js";
import { registerWorkspaceCrudRoutes } from "./workspaces.js";

export interface WorkspacePluginOptions {
  readonly pool: Pool;
}

/** Workspace API (`/api/v1/workspaces/*`): every route needs a live session; the database re-checks membership and role. */
export function registerWorkspaceRoutes(app: FastifyInstance, options: WorkspacePluginOptions): void {
  const guard = createMemberGuard(options.pool);
  registerWorkspaceCrudRoutes(app, guard);
  registerMemberRoutes(app, guard);
}
