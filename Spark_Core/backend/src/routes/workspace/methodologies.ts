import type { FastifyInstance } from "fastify";

import { METHODOLOGIES } from "../../modules/work/domain/methodology.js";

const stringArray = { type: "array", items: { type: "string" } } as const;

const methodologyResponse = {
  type: "object",
  properties: {
    id: { type: "string", enum: ["scrum", "kanban", "waterfall"] },
    name: { type: "string" },
    tagline: { type: "string" },
    bestFor: { type: "string" },
    planningObject: { type: "string" },
    practices: stringArray,
    metrics: stringArray,
    statuses: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          category: { type: "string", enum: ["backlog", "todo", "in_progress", "done"] },
          wipLimit: { type: ["integer", "null"] },
        },
      },
    },
    defaults: {
      type: "object",
      properties: { sprintLengthDays: { type: ["integer", "null"] }, phaseNames: stringArray },
    },
  },
} as const;

/** Public static catalog of methodology templates: no session, cacheable by shared caches. */
export function registerMethodologyRoutes(app: FastifyInstance): void {
  app.get(
    "/api/v1/methodologies",
    { schema: { response: { 200: { type: "object", properties: { items: { type: "array", items: methodologyResponse } } } } } },
    async (_request, reply) => {
      reply.header("Cache-Control", "public, max-age=3600");
      return { items: METHODOLOGIES };
    },
  );
}
