import type { FastifyInstance } from "fastify";

export function registerHealthRoute(app: FastifyInstance): void {
  app.get(
    "/health",
    {
      config: { rateLimit: false },
      schema: {
        tags: ["system"],
        summary: "Process health",
        response: {
          200: {
            type: "object",
            headers: {
              "Cache-Control": { type: "string" },
              "X-Request-Id": { type: "string" },
            },
            additionalProperties: false,
            required: ["status"],
            properties: { status: { const: "ok", type: "string" } },
          },
        },
      },
    },
    async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
      return { status: "ok" };
    },
  );
}
