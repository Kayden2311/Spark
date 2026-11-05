import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { card, filterOptions, json, stubFetch } from "./community-fixtures";

// A tiny URL store: router.replace changes the query and useSearchParams re-renders with it,
// the way Next.js navigation does.
const nav = vi.hoisted(() => {
  let search = "";
  const listeners = new Set<() => void>();
  return {
    get search() {
      return search;
    },
    set(next: string) {
      search = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    replace: vi.fn(),
  };
});

vi.mock("next/navigation", async () => {
  const React = await import("react");
  return {
    usePathname: () => "/communities",
    useSearchParams: () => {
      const search = React.useSyncExternalStore(nav.subscribe, () => nav.search, () => nav.search);
      return React.useMemo(() => new URLSearchParams(search), [search]);
    },
    useRouter: () => ({
      replace: (url: string, options?: unknown) => {
        nav.replace(url, options);
        nav.set(url.split("?")[1] ?? "");
      },
      push: vi.fn(),
    }),
  };
});

const auth = { isAuthenticated: false, isLoading: false, user: null as null | { id: string } };
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));
// Canvas particle backgrounds are decorative and need APIs jsdom lacks.
vi.mock("../src/app/signal-particles", () => ({ SignalParticles: () => null }));

import CommunitiesPage from "../src/app/communities/page";

const alpha = card({ id: "c-alpha", slug: "alpha-circle", name: "Alpha Circle" });
const beta = card({ id: "c-beta", slug: "beta-circle", name: "Beta Circle", featured: true });
const gamma = card({ id: "c-gamma", slug: "gamma-circle", name: "Gamma Circle", frozen: true, topics: [{ slug: "fintech", name: "FinTech" }] });

function directoryRoutes(pages: Record<string, { items: unknown[]; nextCursor: string | null }>, mine: unknown[] | null = null) {
  return stubFetch((url) => {
    if (url.pathname === "/api/v1/communities/filters") return json(filterOptions);
    if (url.pathname === "/api/v1/me/communities") return mine ? json({ items: mine }) : json({ code: "unauthenticated" }, 401);
    if (url.pathname === "/api/v1/communities") {
      const key = url.searchParams.get("cursor") ?? "first";
      return json(pages[key] ?? { items: [], nextCursor: null });
    }
    return undefined;
  });
}

const articleNames = () => screen.getAllByRole("article").map((article) => within(article).getByRole("heading", { level: 3 }).textContent);

describe("communities directory page", () => {
  beforeEach(() => {
    nav.set("");
    nav.replace.mockClear();
    auth.isAuthenticated = false;
    auth.user = null;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("loads the first page with the filters from the URL and restores the controls", async () => {
    nav.set("q=pricing&topic=fintech&country=VN&stage=seed");
    const { calls } = directoryRoutes({ first: { items: [gamma], nextCursor: null } });
    render(<CommunitiesPage />);

    expect(await screen.findByRole("heading", { level: 3, name: "Gamma Circle" })).toBeInTheDocument();
    const list = calls.find((call) => call.path === "/api/v1/communities")!;
    expect(Object.fromEntries(list.search)).toEqual({ q: "pricing", topic: "fintech", country: "VN", stage: "seed" });
    expect(screen.getByRole("searchbox", { name: /search communities/i })).toHaveValue("pricing");
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Location" })).toHaveValue("VN"));
    expect(screen.getByRole("combobox", { name: "Stage" })).toHaveValue("seed");
    const chips = screen.getByRole("group", { name: /filter by topic/i });
    expect(within(chips).getByRole("button", { name: /fintech/i })).toHaveAttribute("aria-pressed", "true");
    // Option labels come from the API; country codes render as names.
    expect(within(screen.getByRole("combobox", { name: "Location" })).getByRole("option", { name: "Vietnam" })).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
  });

  it("writes filter changes to the URL and refetches with them", async () => {
    const { calls } = directoryRoutes({ first: { items: [alpha], nextCursor: null } });
    render(<CommunitiesPage />);
    await screen.findByRole("heading", { level: 3, name: "Alpha Circle" });

    const chips = screen.getByRole("group", { name: /filter by topic/i });
    await waitFor(() => expect(within(chips).getByRole("button", { name: /fintech/i })).toHaveTextContent("FinTech1"));
    await userEvent.click(within(chips).getByRole("button", { name: /fintech/i }));
    expect(nav.replace).toHaveBeenLastCalledWith("/communities?topic=fintech", { scroll: false });

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Stage" }), "growth");
    expect(nav.replace).toHaveBeenLastCalledWith("/communities?topic=fintech&stage=growth", { scroll: false });

    await userEvent.type(screen.getByRole("searchbox", { name: /search communities/i }), "ai");
    await waitFor(() => expect(nav.replace).toHaveBeenLastCalledWith("/communities?q=ai&topic=fintech&stage=growth", { scroll: false }));
    await waitFor(() => {
      const last = calls.filter((call) => call.path === "/api/v1/communities").at(-1)!;
      expect(Object.fromEntries(last.search)).toEqual({ q: "ai", topic: "fintech", stage: "growth" });
    });
  });

  it("appends the next page on Show more without duplicating communities", async () => {
    const { calls } = directoryRoutes({
      first: { items: [alpha, beta], nextCursor: "cur-2" },
      "cur-2": { items: [beta, gamma], nextCursor: null },
    });
    render(<CommunitiesPage />);
    await screen.findByRole("heading", { level: 3, name: "Beta Circle" });
    expect(screen.getByText("Featured")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    await screen.findByRole("heading", { level: 3, name: "Gamma Circle" });
    expect(articleNames()).toEqual(["Alpha Circle", "Beta Circle", "Gamma Circle"]);
    expect(calls.filter((call) => call.path === "/api/v1/communities").at(-1)!.search.get("cursor")).toBe("cur-2");
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  });

  it("shows the empty state and clears every filter", async () => {
    nav.set("q=zzz&stage=growth");
    directoryRoutes({ first: { items: [], nextCursor: null } });
    render(<CommunitiesPage />);

    const empty = await screen.findByText("No communities match — clear filters");
    const box = empty.closest(".communityEmptyState") as HTMLElement;
    await userEvent.click(within(box).getByRole("button", { name: "Clear filters" }));
    expect(nav.replace).toHaveBeenLastCalledWith("/communities", { scroll: false });
    await waitFor(() => expect(screen.getByRole("searchbox", { name: /search communities/i })).toHaveValue(""));
  });

  it("shows the signed-in viewer's communities in a strip", async () => {
    auth.isAuthenticated = true;
    auth.user = { id: "u-1" };
    directoryRoutes({ first: { items: [alpha], nextCursor: null } }, [card({ id: "c-mine", slug: "my-circle", name: "My Circle", viewerStatus: "owner" })]);
    render(<CommunitiesPage />);

    const strip = await screen.findByRole("region", { name: "Your communities" });
    expect(within(strip).getByRole("link", { name: /my circle/i })).toHaveAttribute("href", "/communities/my-circle");
    expect(within(strip).getByText("Owner")).toBeInTheDocument();
  });

  it("hides the strip for signed-out visitors and does not ask for it", async () => {
    const { calls } = directoryRoutes({ first: { items: [alpha], nextCursor: null } });
    render(<CommunitiesPage />);
    await screen.findByRole("heading", { level: 3, name: "Alpha Circle" });
    await act(async () => {});
    expect(screen.queryByRole("region", { name: "Your communities" })).not.toBeInTheDocument();
    expect(calls.some((call) => call.path === "/api/v1/me/communities")).toBe(false);
  });

  it("shows an error with a retry when the directory cannot load", async () => {
    let fail = true;
    stubFetch((url) => {
      if (url.pathname === "/api/v1/communities/filters") return json(filterOptions);
      if (url.pathname === "/api/v1/communities") return fail ? json({ code: "database_unavailable", detail: "Spark is temporarily unavailable." }, 503) : json({ items: [alpha], nextCursor: null });
      return undefined;
    });
    render(<CommunitiesPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Spark is temporarily unavailable.");
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 3, name: "Alpha Circle" })).toBeInTheDocument();
  });
});
