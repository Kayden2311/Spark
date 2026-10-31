import { describe, expect, it } from "vitest";

import { internalLink } from "../src/app/_lib/notifications";

describe("internalLink", () => {
  it("accepts in-app paths", () => {
    expect(internalLink("/w/a?issue=1#x")).toBe("/w/a?issue=1#x");
  });

  it.each(["//x.com", "http://x", "/\\x", "/\t/x.com", "/\n/x.com", "/\u0000x", "", null])("rejects %j", (link) => {
    expect(internalLink(link)).toBeNull();
  });
});
