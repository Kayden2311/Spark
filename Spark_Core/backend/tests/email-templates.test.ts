import { describe, expect, it } from "vitest";

import { escapeHtml, renderEmail } from "../src/modules/email/layout.js";
import { invitationEmail } from "../src/modules/email/templates/invitation.js";

const acceptUrl = `http://localhost:3000/invitations/accept#token=${"a".repeat(64)}`;
const input = {
  inviterName: "Ana Lima",
  workspaceName: "<script>alert(1)</script> & Co",
  role: "member",
  acceptUrl,
  expiresAt: new Date("2026-10-25T12:00:00Z"),
  appBaseUrl: "http://localhost:3000",
};

describe("invitation email", () => {
  it("uses the exact subject with plain-text names", () => {
    expect(invitationEmail(input).subject).toBe("Ana Lima invited you to <script>alert(1)</script> & Co on Spark");
    expect(invitationEmail({ ...input, inviterName: "Ana\r\nBcc: x@example.com" }).subject).toBe("Ana Bcc: x@example.com invited you to <script>alert(1)</script> & Co on Spark");
  });

  it("escapes interpolated values in the HTML part", () => {
    const { html } = invitationEmail(input);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co");
    expect(html).toContain(`href="${acceptUrl}"`);
    expect(html).toContain("#09265a");
    expect(html).toContain("#2563eb");
    expect(html).toContain("http://localhost:3000/settings/notifications");
  });

  it("puts the accept link, role and expiry into the text part", () => {
    const { text } = invitationEmail({ ...input, role: "admin" });
    expect(text).toContain(acceptUrl);
    expect(text).toContain("as an admin");
    expect(text).toContain("October 25, 2026");
    expect(text).toContain("Manage email settings: http://localhost:3000/settings/notifications");
  });
});

describe("email layout", () => {
  it("escapes every interpolated value", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    const { html } = renderEmail({
      preheader: "<pre>", heading: "<h>", paragraphs: ["<p1>", "<p2>"], footerNote: "<f>", appBaseUrl: "http://localhost:3000",
      action: { label: "<go>", url: "https://example.com/?a=1&b=<2>" },
    });
    for (const raw of ["<pre>", "<h>", "<p1>", "<p2>", "<f>", "<go>", "<2>"]) expect(html).not.toContain(raw);
    expect(html).toContain("https://example.com/?a=1&amp;b=%3C2%3E");
  });

  it("rejects non-http action links", () => {
    expect(() => renderEmail({ preheader: "", heading: "", paragraphs: [], footerNote: "", appBaseUrl: "http://localhost:3000", action: { label: "x", url: "javascript:alert(1)" } })).toThrow();
  });
});
