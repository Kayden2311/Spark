import { describe, expect, it } from "vitest";

import { formatEtag, parseIfMatch } from "../src/modules/work/domain/etag.js";

describe("etag", () => {
  it("formats a quoted version", () => {
    expect(formatEtag(3)).toBe('"v3"');
  });

  it("parses a missing header as null and a strong tag as its version", () => {
    expect(parseIfMatch(undefined)).toBeNull();
    expect(parseIfMatch('"v12"')).toBe(12);
    expect(parseIfMatch('"v0"')).toBe(0);
  });

  it("rejects weak, wildcard and malformed values", () => {
    for (const value of ['W/"v1"', "*", '"x"', "v1", '"v-1"', '"v1.5"', '"v1", "v2"', "", '"v99999999999999999999"']) {
      expect(parseIfMatch(value)).toBe("invalid");
    }
  });
});
