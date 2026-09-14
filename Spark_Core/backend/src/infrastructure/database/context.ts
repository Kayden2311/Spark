import type { Pool, PoolClient } from "pg";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// Only call with an actor verified by the server's future opaque-session adapter.
export async function withDatabaseContext<T>(
  pool: Pool,
  actor: { userId: string; tenantId: string },
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!uuidPattern.test(actor.userId) || !uuidPattern.test(actor.tenantId)) throw new Error("Invalid database context");
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('spark.user_id',$1,true), set_config('spark.tenant_id',$2,true)", [actor.userId, actor.tenantId]);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { discard = true; }
    throw error;
  } finally {
    client.release(discard);
  }
}
