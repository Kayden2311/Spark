import { describe, expect, it } from "vitest";

import { shellCrumbs } from "../src/app/_ui/crumbs";

const workspace = { slug: "acme", name: "Acme", role: "owner" };
const projects = [{ key: "WEB", name: "Website", methodology: "scrum" }];

describe("shellCrumbs", () => {
  it("starts inside a workspace with the workspace, then the section", () => {
    expect(shellCrumbs({ pathname: "/w/acme/members", current: "Members", workspace, projects })).toEqual([
      { label: "Acme", href: "/w/acme" },
      { label: "Members" },
    ]);
  });

  it("names a project page by the project's name under Projects", () => {
    expect(shellCrumbs({ pathname: "/w/acme/p/WEB/backlog", current: "", workspace, projects })).toEqual([
      { label: "Acme", href: "/w/acme" },
      { label: "Projects", href: "/w/acme#projects" },
      { label: "Website" },
    ]);
  });

  it("falls back to the key while the project list is unknown", () => {
    expect(shellCrumbs({ pathname: "/w/acme/p/OPS", current: "", workspace, projects: null })).toEqual([
      { label: "Acme", href: "/w/acme" },
      { label: "Projects", href: "/w/acme#projects" },
      { label: "OPS" },
    ]);
  });

  it("shows only the workspace on its home", () => {
    expect(shellCrumbs({ pathname: "/w/acme", current: "Home", workspace, projects })).toEqual([{ label: "Acme" }]);
  });

  it("labels the new project page", () => {
    expect(shellCrumbs({ pathname: "/w/acme/projects/new", current: "", workspace, projects })).toEqual([
      { label: "Acme", href: "/w/acme" },
      { label: "Projects", href: "/w/acme#projects" },
      { label: "New project" },
    ]);
  });

  it("uses the section name outside a workspace", () => {
    expect(shellCrumbs({ pathname: "/notifications", current: "Notifications", workspace: null, projects: null })).toEqual([{ label: "Notifications" }]);
    expect(shellCrumbs({ pathname: "/billing", current: "Billing", workspace, projects: null })).toEqual([{ label: "Billing" }]);
  });

  it("calls every settings page Settings", () => {
    expect(shellCrumbs({ pathname: "/settings/notifications", current: "", workspace: null, projects: null })).toEqual([{ label: "Settings" }]);
  });
});
