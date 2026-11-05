import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { card, json, stubFetch, type Route } from "./community-fixtures";

const router = { replace: vi.fn(), push: vi.fn() };
const navigation = { pathname: "/w/northstar-labs/communities", params: { slug: "northstar-labs" } as Record<string, string> };
const auth = {
  isAuthenticated: true,
  isLoading: false,
  platformRoles: [] as string[],
  user: { id: "u-avery", displayName: "Avery Founder", email: "avery@example.com", avatarUrl: null },
  workspaces: [{ workspaceId: "w1", workspaceName: "Northstar Labs", workspaceSlug: "northstar-labs", role: "owner" }],
  logout: vi.fn(),
  refreshSession: vi.fn(async () => {}),
};

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(),
  useParams: () => navigation.params,
}));
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));

import WorkspaceLayout from "../src/app/w/[slug]/layout";
import WorkspaceCommunitiesPage from "../src/app/w/[slug]/communities/page";
import NewCommunityPage from "../src/app/w/[slug]/communities/new/page";

const workspace = (role: string) => ({ id: "w1", slug: "northstar-labs", name: "Northstar Labs", role, memberCount: 3, version: 1, createdAt: "2026-10-18T10:00:00.000Z" });

function serve(role: string, extra?: Route) {
  return stubFetch((url, init) => {
    const handled = extra?.(url, init);
    if (handled) return handled;
    if (url.pathname === "/api/v1/workspaces/by-slug/northstar-labs") return json(workspace(role));
    if (url.pathname === "/api/v1/workspaces/w1/projects") return json({ items: [] });
    if (url.pathname === "/api/v1/notifications/unread-count") return json({ count: 0 });
    return undefined;
  });
}

beforeEach(() => {
  router.push.mockClear();
  router.replace.mockClear();
  navigation.pathname = "/w/northstar-labs/communities";
});
afterEach(() => vi.unstubAllGlobals());

describe("workspace communities", () => {
  it("lists the communities this workspace hosts, with manage links for owners", async () => {
    serve("owner", (url) =>
      url.pathname === "/api/v1/workspaces/w1/communities"
        ? json({ items: [card({ viewerStatus: "owner" }), card({ id: "c-hidden", slug: "inner-circle", name: "Inner Circle", visibility: "hidden", stage: { code: "pre_seed", label: "Pre-seed" }, memberCount: 3 })] })
        : undefined,
    );
    render(<WorkspaceLayout><WorkspaceCommunitiesPage /></WorkspaceLayout>);

    const list = await screen.findByRole("list", { name: "Hosted communities" });
    const inner = within(list).getByRole("link", { name: "Inner Circle" });
    expect(inner).toHaveAttribute("href", "/communities/inner-circle");
    const innerCard = inner.closest("li") as HTMLElement;
    expect(within(innerCard).getByText("Hidden")).toBeInTheDocument();
    expect(within(innerCard).getByText("Pre-seed")).toBeInTheDocument();
    expect(within(innerCard).queryByText("pre_seed")).not.toBeInTheDocument();
    expect(within(innerCard).getByRole("link", { name: "Manage Inner Circle" })).toHaveAttribute("href", "/communities/inner-circle/manage");
    expect(screen.getByRole("link", { name: "Create community" })).toHaveAttribute("href", "/w/northstar-labs/communities/new");
    expect(screen.getAllByRole("link", { name: "Browse communities" }).some((link) => link.getAttribute("href") === "/communities")).toBe(true);
  });

  it("has no Create button for plain members and shows an empty state", async () => {
    serve("member", (url) => (url.pathname === "/api/v1/workspaces/w1/communities" ? json({ items: [] }) : undefined));
    render(<WorkspaceLayout><WorkspaceCommunitiesPage /></WorkspaceLayout>);
    expect(await screen.findByText("No communities yet")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Create community" })).not.toBeInTheDocument();
  });
});

describe("create community form", () => {
  beforeEach(() => {
    navigation.pathname = "/w/northstar-labs/communities/new";
  });

  it("refuses plain members", async () => {
    serve("member");
    render(<WorkspaceLayout><NewCommunityPage /></WorkspaceLayout>);
    expect(await screen.findByText("Only workspace owners and admins can create communities.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create community" })).not.toBeInTheDocument();
  });

  it("derives the address from the name and counts the tagline", async () => {
    serve("owner");
    render(<WorkspaceLayout><NewCommunityPage /></WorkspaceLayout>);
    await userEvent.type(await screen.findByRole("textbox", { name: "Name" }), "Climate Builders VN!");
    expect(screen.getByRole("textbox", { name: "Address" })).toHaveValue("climate-builders-vn");
    expect(screen.getByText("spark.app/communities/climate-builders-vn")).toBeInTheDocument();

    await userEvent.type(screen.getByRole("textbox", { name: "Tagline" }), "Hello");
    expect(screen.getByText("5/90")).toBeInTheDocument();
  });

  it("needs one to four topics", async () => {
    const { calls } = serve("owner");
    render(<WorkspaceLayout><NewCommunityPage /></WorkspaceLayout>);
    await userEvent.type(await screen.findByRole("textbox", { name: "Name" }), "Climate Builders");
    await userEvent.type(screen.getByRole("textbox", { name: "Tagline" }), "Builders of climate tech.");
    await userEvent.type(screen.getByRole("textbox", { name: "Description" }), "We meet monthly.");
    await userEvent.click(screen.getByRole("button", { name: "Create community" }));
    expect(await screen.findByText("Pick 1 to 4 topics.")).toBeInTheDocument();
    expect(calls.some((call) => call.method === "POST")).toBe(false);

    const topics = screen.getByRole("group", { name: "Topics" });
    for (const name of ["B2B SaaS", "Climate Tech", "AI & Data", "Product"]) await userEvent.click(within(topics).getByRole("button", { name }));
    expect(within(topics).getByRole("button", { name: "FinTech" })).toBeDisabled();
    expect(within(topics).getByRole("button", { name: "Product" })).toHaveAttribute("aria-pressed", "true");
  });

  it("posts the expected body and opens the new community", async () => {
    const { calls } = serve("owner", (url, init) =>
      url.pathname === "/api/v1/workspaces/w1/communities" && init.method === "POST"
        ? json({ ...card({ slug: "climate-builders" }), description: "x", createdAt: "2026-11-05T00:00:00.000Z", canManage: true, version: 1 }, 201)
        : undefined,
    );
    render(<WorkspaceLayout><NewCommunityPage /></WorkspaceLayout>);
    await userEvent.type(await screen.findByRole("textbox", { name: "Name" }), "  Climate Builders ");
    await userEvent.type(screen.getByRole("textbox", { name: "Tagline" }), "Builders of climate tech.");
    await userEvent.type(screen.getByRole("textbox", { name: "Description" }), "We meet monthly.");
    await userEvent.click(screen.getByRole("radio", { name: /Private/ }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Country" }), "VN");
    await userEvent.type(screen.getByRole("textbox", { name: "City" }), "Hanoi");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Stage" }), "pre_seed");
    await userEvent.click(within(screen.getByRole("group", { name: "Topics" })).getByRole("button", { name: "Climate Tech" }));
    await userEvent.click(screen.getByRole("button", { name: "Create community" }));

    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/communities/climate-builders"));
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      slug: "climate-builders",
      name: "Climate Builders",
      tagline: "Builders of climate tech.",
      description: "We meet monthly.",
      visibility: "private",
      countryCode: "VN",
      city: "Hanoi",
      stage: "pre_seed",
      topics: ["climate-tech"],
    });
  });

  it("shows a taken address next to the field", async () => {
    serve("owner", (url, init) =>
      url.pathname === "/api/v1/workspaces/w1/communities" && init.method === "POST"
        ? json({ code: "slug_taken", detail: "That community address is already taken." }, 409)
        : undefined,
    );
    render(<WorkspaceLayout><NewCommunityPage /></WorkspaceLayout>);
    await userEvent.type(await screen.findByRole("textbox", { name: "Name" }), "Climate Builders");
    await userEvent.type(screen.getByRole("textbox", { name: "Tagline" }), "Builders.");
    await userEvent.type(screen.getByRole("textbox", { name: "Description" }), "Monthly.");
    await userEvent.click(within(screen.getByRole("group", { name: "Topics" })).getByRole("button", { name: "Product" }));
    await userEvent.click(screen.getByRole("button", { name: "Create community" }));
    expect(await screen.findByText("That address is taken. Try another one.")).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
  });
});
