import { describe, expect, it } from "vitest";

import { escapeHtml, renderEmail } from "../src/modules/email/layout.js";
import { dueReminderEmail } from "../src/modules/email/templates/due-reminder.js";
import type { DueReminderTask } from "../src/modules/email/templates/due-reminder.js";
import { invitationEmail } from "../src/modules/email/templates/invitation.js";
import { taskAssignedEmail } from "../src/modules/email/templates/task-assigned.js";
import { weeklyDigestEmail } from "../src/modules/email/templates/weekly-digest.js";
import type { WeeklyDigestEmailInput } from "../src/modules/email/templates/weekly-digest.js";

const acceptUrl = `http://localhost:3000/invitations/accept#token=${"a".repeat(64)}`;
const input = {
  inviterName: "Ana Lima",
  workspaceName: "<script>alert(1)</script> & Co",
  role: "member",
  acceptUrl,
  expiresAt: new Date("2026-10-25T12:00:00Z"),
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
  });

  it("puts the accept link, role and expiry into the text part", () => {
    const { text } = invitationEmail({ ...input, role: "admin" });
    expect(text).toContain(acceptUrl);
    expect(text).toContain("as an admin");
    expect(text).toContain("October 25, 2026");
  });

  it("has a neutral footer without a settings link, since the recipient may have no account", () => {
    const { html, text } = invitationEmail(input);
    for (const part of [html, text]) {
      expect(part).toContain("You received this email because someone invited this address to a Spark workspace.");
      expect(part).not.toContain("Manage email settings");
      expect(part).not.toContain("/settings/notifications");
    }
  });
});

describe("email layout", () => {
  it("escapes every interpolated value", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    const { html } = renderEmail({
      preheader: "<pre>", heading: "<h>", paragraphs: ["<p1>", "<p2>"], footerNote: "<f>", settingsUrl: "http://localhost:3000/settings/<n>",
      action: { label: "<go>", url: "https://example.com/?a=1&b=<2>" },
    });
    for (const raw of ["<pre>", "<h>", "<p1>", "<p2>", "<f>", "<go>", "<2>", "<n>"]) expect(html).not.toContain(raw);
    expect(html).toContain("https://example.com/?a=1&amp;b=%3C2%3E");
  });

  it("adds the settings link to the footer only when one is given", () => {
    const base = { preheader: "", heading: "Hi", paragraphs: [], footerNote: "Note." };
    const withLink = renderEmail({ ...base, settingsUrl: "https://app.spark.example/settings/notifications" });
    expect(withLink.html).toContain('href="https://app.spark.example/settings/notifications"');
    expect(withLink.text).toContain("Manage email settings: https://app.spark.example/settings/notifications");
    const without = renderEmail(base);
    expect(without.html).not.toContain("Manage email settings");
    expect(without.text).toBe("Hi\n\n--\nNote.\n");
  });

  it("rejects non-http action links", () => {
    expect(() => renderEmail({ preheader: "", heading: "", paragraphs: [], footerNote: "", action: { label: "x", url: "javascript:alert(1)" } })).toThrow();
  });
});

describe("task-assigned email", () => {
  const issueUrl = "http://localhost:3000/w/acme/p/WEB?issue=WEB-42";
  const preferencesUrl = "http://localhost:3000/settings/notifications";
  const task = {
    actorName: "Ana Lima",
    recipientName: "Bob Stone",
    issueKey: "WEB-42",
    issueTitle: "Fix <script>alert(1)</script> & login",
    projectName: "Website",
    workspaceName: "Acme & Co",
    issueUrl,
    preferencesUrl,
  };

  it("uses the exact subject and truncates long titles to 80 characters", () => {
    expect(taskAssignedEmail(task).subject).toBe("Ana Lima assigned you WEB-42: Fix <script>alert(1)</script> & login");
    const long = taskAssignedEmail({ ...task, issueTitle: "x".repeat(200) }).subject;
    expect(long).toBe(`Ana Lima assigned you WEB-42: ${"x".repeat(79)}…`);
    expect(taskAssignedEmail({ ...task, issueTitle: "y".repeat(80) }).subject).toBe(`Ana Lima assigned you WEB-42: ${"y".repeat(80)}`);
    expect(taskAssignedEmail({ ...task, actorName: "Ana\r\nBcc: x@example.com" }).subject.startsWith("Ana Bcc: x@example.com assigned you")).toBe(true);
  });

  it("escapes every value in the HTML part and links the task and the email preferences", () => {
    const { html } = taskAssignedEmail(task);
    expect(html).not.toContain("<script>");
    expect(html).toContain("Fix &lt;script&gt;alert(1)&lt;/script&gt; &amp; login");
    expect(html).toContain("Acme &amp; Co");
    expect(html).toContain(`href="${issueUrl}"`);
    expect(html).toContain(">Open task</a>");
    expect(html).toContain(`href="${preferencesUrl}"`);
    expect(html).toContain("Email preferences");
    expect(html).toContain("#09265a");
  });

  it("puts the task link and the preferences link into the text part", () => {
    const { text } = taskAssignedEmail(task);
    expect(text).toContain(`Open task: ${issueUrl}`);
    expect(text).toContain(`Email preferences: ${preferencesUrl}`);
    expect(text).toContain("Fix <script>alert(1)</script> & login");
    expect(text).toContain("Website");
  });
});

describe("due reminder email", () => {
  const task = (overrides: Partial<DueReminderTask> = {}): DueReminderTask => ({
    workspace: "Acme", key: "WEB-42", title: "Fix <b>login</b> & more", due: "2026-10-31", overdue: false,
    url: "http://localhost:3000/w/acme/p/WEB?issue=WEB-42", ...overrides,
  });
  const base = { recipientName: "Bob <i>Stone</i>", total: 1, tasks: [task()], preferencesUrl: "http://localhost:3000/settings/notifications" };

  it("uses singular and plural subjects and mentions overdue tasks", () => {
    expect(dueReminderEmail(base).subject).toBe("You have 1 task due soon");
    expect(dueReminderEmail({ ...base, total: 2, tasks: [task(), task({ key: "WEB-43" })] }).subject).toBe("You have 2 tasks due soon");
    expect(dueReminderEmail({ ...base, total: 3, tasks: [task({ overdue: true }), task(), task({ overdue: true })] }).subject)
      .toBe("You have 3 tasks due soon (2 overdue)");
  });

  it("escapes titles and names, links every task and keeps a text alternative with the preferences link", () => {
    const { html, text } = dueReminderEmail(base);
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<i>");
    expect(html).toContain("Fix &lt;b&gt;login&lt;/b&gt; &amp; more");
    expect(html).toContain('href="http://localhost:3000/w/acme/p/WEB?issue=WEB-42"');
    expect(html).toContain("http://localhost:3000/settings/notifications");
    expect(text).toContain("WEB-42 Fix <b>login</b> & more (Acme) - due Oct 31 (http://localhost:3000/w/acme/p/WEB?issue=WEB-42)");
    expect(text).toContain("Email preferences: http://localhost:3000/settings/notifications");
  });

  it("marks overdue tasks and says how many more were cut", () => {
    const { text } = dueReminderEmail({ ...base, total: 25, tasks: [task({ overdue: true, due: "2026-10-28" })] });
    expect(text).toContain("overdue since Oct 28");
    expect(text).toContain("and 24 more");
  });

  it("rejects non-http links", () => {
    expect(() => dueReminderEmail({ ...base, tasks: [task({ url: "javascript:alert(1)" })] })).toThrow();
  });
});

describe("weekly digest email", () => {
  const base: WeeklyDigestEmailInput = {
    recipientName: "Bob",
    workspaceName: "Acme <Co>",
    workspaceUrl: "http://localhost:3000/w/acme",
    weekOf: "2026-10-26",
    projects: [{ key: "WEB", name: "Web & Mobile", methodology: "scrum", donePercent: 25, planPercent: 50, status: "behind", label: "Sprint 4" }],
    members: [{ name: "Ana <script>", completed: 3 }],
    atRisk: [{ key: "WEB-1", title: "Ship <it>", due: "2026-10-27", url: "http://localhost:3000/w/acme/p/WEB?issue=WEB-1" }],
    overdue: [],
    atRiskTotal: 12,
    overdueTotal: 0,
    preferencesUrl: "http://localhost:3000/settings/notifications",
  };

  it("builds the subject from the workspace and the Monday", () => {
    expect(weeklyDigestEmail(base).subject).toBe("Acme <Co> weekly digest — week of Oct 26");
  });

  it("escapes names, shows plan status and the preferences link, and has a text part", () => {
    const { html, text } = weeklyDigestEmail(base);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<it>");
    expect(html).toContain("Web &amp; Mobile");
    expect(html).toContain("Ana &lt;script&gt;");
    expect(html).toContain("http://localhost:3000/settings/notifications");
    expect(text).toContain("WEB Web & Mobile - 25% done, 50% of the plan elapsed (Sprint 4): Behind");
    expect(text).toContain("Ana <script> - 3");
    expect(text).toContain("and 11 more");
    expect(text).toContain("Open workspace: http://localhost:3000/w/acme");
    expect(text).toContain("Email preferences: http://localhost:3000/settings/notifications");
    expect(text).not.toContain("Overdue\n");
  });

  it("states an empty week and a project without a plan", () => {
    const { text } = weeklyDigestEmail({
      ...base, members: [], atRisk: [], atRiskTotal: 0,
      projects: [{ ...base.projects[0]!, planPercent: null, status: "no_plan", label: null }],
    });
    expect(text).toContain("Nothing was completed.");
    expect(text).toContain("no plan window");
    expect(text).not.toContain("No plan");
  });
});
