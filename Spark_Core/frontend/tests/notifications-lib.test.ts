import { describe, expect, it } from "vitest";

import { communityKindLabel, internalLink } from "../src/app/_lib/notifications";

describe("communityKindLabel", () => {
  it.each([
    ["community_request_received", "Join request"],
    ["community_request_approved", "Request approved"],
    ["community_request_rejected", "Request declined"],
    ["post_commented", "New comment"],
  ])("labels %s", (kind, label) => {
    expect(communityKindLabel(kind)).toBe(label);
  });

  it("has no community label for other kinds", () => {
    expect(communityKindLabel("issue_assigned")).toBeNull();
  });
});

describe("internalLink", () => {
  it("accepts in-app paths", () => {
    expect(internalLink("/w/a?issue=1#x")).toBe("/w/a?issue=1#x");
  });

  it.each(["//x.com", "http://x", "/\\x", "/\t/x.com", "/\n/x.com", "/\u0000x", "", null])("rejects %j", (link) => {
    expect(internalLink(link)).toBeNull();
  });
});
