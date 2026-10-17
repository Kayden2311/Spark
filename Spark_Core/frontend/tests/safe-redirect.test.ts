import { describe, expect, it } from "vitest";

import { safeRedirect } from "../src/app/safe-redirect";

describe("safeRedirect", () => {
  it.each(["/admin", "/admin/users?status=suspended", "/communities/hyperdrive/request#form"])("keeps the on-site path %s", (path) => {
    expect(safeRedirect(path)).toBe(path);
  });

  it.each([null, "", "https://evil.example/admin", "//evil.example/admin", String.raw`/\evil.example`, "javascript:alert(1)", "admin", "/.//evil.com", "/%2e//evil.com", "/a/..//evil.com", String.raw`/.\/evil.com`])("rejects %s", (value) => {
    expect(safeRedirect(value)).toBeNull();
  });
});
