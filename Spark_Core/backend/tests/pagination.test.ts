import { describe, expect, it } from "vitest";

import { decodeCursor, encodeCursor, pageSize, toPage } from "../src/routes/pagination.js";

const id = "1d4f5e2a-3b6c-4d7e-8f90-a1b2c3d4e5f6";

describe("keyset cursors", () => {
  it("round-trips microsecond timestamps exactly", () => {
    const cursor = { createdAt: "2026-10-17 10:00:00.123456+07", id };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("treats an absent cursor as the first page", () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });

  it.each([
    ["non base64url text", "not a cursor!"],
    ["non-JSON payload", Buffer.from("hello").toString("base64url")],
    ["missing id", Buffer.from(JSON.stringify({ t: "2026-10-17 10:00:00+00" })).toString("base64url")],
    ["bad timestamp", Buffer.from(JSON.stringify({ t: "yesterday", id })).toString("base64url")],
    ["SQL in the timestamp", Buffer.from(JSON.stringify({ t: "2026-10-17 10:00:00+00'); DROP TABLE x;--", id })).toString("base64url")],
    ["bad uuid", Buffer.from(JSON.stringify({ t: "2026-10-17 10:00:00+00", id: "abc" })).toString("base64url")],
    ["oversized input", "a".repeat(201)],
    ["impossible date", Buffer.from(JSON.stringify({ t: "2026-19-45 99:00:00+00", id })).toString("base64url")],
  ])("rejects %s", (_name, value) => {
    expect(decodeCursor(value)).toBe("invalid");
  });

  it("clamps page sizes", () => {
    expect(pageSize(undefined)).toBe(25);
    expect(pageSize(0)).toBe(1);
    expect(pageSize(1000)).toBe(100);
  });

  it("emits a next cursor only when an extra row exists, and strips the internal field", () => {
    const rows = [1, 2, 3].map((n) => ({ id: `${id.slice(0, -1)}${n}`, cursorTs: `2026-10-17 10:00:0${n}+00`, name: `Row ${n}` }));
    const page = toPage(rows, 2);
    expect(page.items).toEqual([{ id: rows[0]!.id, name: "Row 1" }, { id: rows[1]!.id, name: "Row 2" }]);
    expect(decodeCursor(page.nextCursor!)).toEqual({ createdAt: rows[1]!.cursorTs, id: rows[1]!.id });
    expect(toPage(rows.slice(0, 2), 2).nextCursor).toBeNull();
  });
});
