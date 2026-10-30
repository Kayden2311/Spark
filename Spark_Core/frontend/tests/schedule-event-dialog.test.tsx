import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = { replace: vi.fn(), push: vi.fn() };
const auth = {
  isAuthenticated: true,
  isLoading: false,
  platformRoles: [] as string[],
  user: { id: "u-casey", displayName: "Casey Member", email: "casey@example.com", avatarUrl: null },
  workspaces: [{ workspaceId: "w1", workspaceName: "Northstar Labs", workspaceSlug: "northstar-labs", role: "member" }],
  logout: vi.fn(),
  refreshSession: vi.fn(async () => {}),
};

vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/w/northstar-labs/schedule",
  useSearchParams: () => new URLSearchParams(window.location.search),
  useParams: () => ({ slug: "northstar-labs" }),
}));
vi.mock("../src/app/auth-context", () => ({ useAuth: () => auth }));

import WorkspaceLayout from "../src/app/w/[slug]/layout";
import WorkspaceSchedulePage from "../src/app/w/[slug]/schedule/page";
import { overlapCount, validateEventForm, wallClockInstant, wallClockOf, type CalendarEvent, type EventFormValues } from "../src/app/w/_lib/schedule";

const base = { id: "w1", slug: "northstar-labs", name: "Northstar Labs", role: "member", memberCount: 3, version: 2, createdAt: "2026-10-18T10:00:00.000Z" };
const avery = { id: "u-avery", displayName: "Avery Founder" };
const casey = { id: "u-casey", displayName: "Casey Member" };
const blake = { id: "u-blake", displayName: "Blake Builder" };
const gone = { id: "u-gone", displayName: "Former member" };
const projectRow = { id: "p1", key: "ATLAS", name: "Atlas app", description: null, methodology: "scrum", lead: null, startDate: null, targetDate: null, sprintLengthDays: 14, baselinedAt: null, version: 1, createdAt: "2026-10-18T10:00:00.000Z", progress: { total: 0, done: 0, open: 0 } };
const MEMBERS = {
  items: [avery, casey, blake].map((user) => ({ userId: user.id, displayName: user.displayName, avatarUrl: null, email: null, role: "member", joinedAt: "2026-10-18T10:00:00.000Z" })),
};
const BOARD = {
  project: { id: "p1", key: "ATLAS", name: "Atlas app", methodology: "scrum" },
  statuses: [{ id: "s1", name: "To do", category: "todo", position: 1, wipLimit: null, count: 1 }, { id: "s2", name: "Done", category: "done", position: 2, wipLimit: null, count: 1 }],
  issues: [
    { id: "i1", number: 1, key: "ATLAS-1", title: "Fix login", statusId: "s1" },
    { id: "i2", number: 2, key: "ATLAS-2", title: "Shipped thing", statusId: "s2" },
  ],
  truncated: false,
};

const standup: CalendarEvent = {
  id: "e1", title: "Founder stand-up", description: "Daily sync", location: "Team room", startsAt: "2026-10-28T12:00:00.000Z", endsAt: "2026-10-28T13:00:00.000Z",
  timezone: "Europe/Berlin", status: "scheduled", organizer: avery, project: null, issue: null,
  attendees: [{ user: avery, response: "accepted" }, { user: casey, response: "pending" }], myResponse: "pending", canEdit: false, version: 1,
};
const mine: CalendarEvent = {
  ...standup, id: "e2", title: "Design review", description: null, location: null, startsAt: "2026-10-29T12:00:00.000Z", endsAt: "2026-10-29T13:00:00.000Z",
  organizer: casey, project: { id: "p1", key: "ATLAS", name: "Atlas app" }, issue: { id: "i1", key: "ATLAS-1", title: "Fix login" },
  attendees: [{ user: casey, response: "accepted" }, { user: avery, response: "pending" }, { user: gone, response: "pending" }], myResponse: "accepted", canEdit: true,
};

let calendarEvents: CalendarEvent[] = [];
let requests: Array<{ url: string; method: string; headers: Record<string, string>; body: string | undefined }> = [];
let handler: ((request: (typeof requests)[number]) => Response | Promise<Response> | undefined) | null = null;

const json = (body: unknown, status = 200, type = "application/json") => new Response(JSON.stringify(body), { status, headers: { "content-type": type } });
const problemResponse = (status: number, code: string, detail: string, extra: object = {}) => json({ status, code, detail, ...extra }, status, "application/problem+json");

function mockApi() {
  requests = [];
  handler = null;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const request = { url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string | undefined };
    requests.push(request);
    const custom = handler?.(request);
    if (custom) return custom;
    if (url === "/api/v1/workspaces/by-slug/northstar-labs") return json(base);
    if (url === "/api/v1/workspaces/w1/projects") return json({ items: [projectRow, { ...projectRow, id: "p2", key: "BETA", name: "Beta app" }] });
    if (url === "/api/v1/workspaces/w1/members") return json(MEMBERS);
    if (url === "/api/v1/workspaces/w1/calendar-events" && request.method === "POST") return json({ ...mine, id: "e-new" }, 201);
    if (url === "/api/v1/projects/p1/board") return json(BOARD);
    if (url.startsWith("/api/v1/workspaces/w1/calendar?")) return json({ range: { from: "", to: "", tz: "UTC" }, events: calendarEvents, deadlines: [], truncated: { events: false, deadlines: false } });
    return problemResponse(404, "not_found", "Not found");
  }));
}

const writes = () => requests.filter((request) => request.method !== "GET");
const calendarReads = () => requests.filter((request) => request.url.includes("/calendar?")).length;

function renderPage() {
  return render(<WorkspaceLayout><WorkspaceSchedulePage /></WorkspaceLayout>);
}

async function openNewEvent() {
  const trigger = await screen.findByRole("button", { name: "New event" });
  await userEvent.click(trigger);
  return { trigger, dialog: await screen.findByRole("dialog", { name: "New event" }) };
}

function setField(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function setZone(zone: string) {
  const input = screen.getByLabelText("Time zone");
  await userEvent.clear(input);
  await userEvent.type(input, zone);
}

async function fillBasics() {
  await userEvent.type(screen.getByLabelText("Title"), "  Planning  ");
  setField("Date", "2026-10-29");
  setField("Start time", "14:00");
  setField("End time", "15:00");
  await setZone("Europe/Berlin");
}

async function openEvent(title: string) {
  await userEvent.click(await screen.findByRole("button", { name: title }));
  return screen.findByRole("dialog", { name: title });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-28T10:00:00.000Z") });
  window.history.replaceState(null, "", "/w/northstar-labs/schedule");
  window.localStorage.clear();
  calendarEvents = [standup, mine];
  mockApi();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("wall-clock helpers", () => {
  it("turns a local date and time in a zone into the exact instant, across DST", () => {
    expect(wallClockInstant("2026-03-28", "12:00", "Europe/Berlin")).toBe("2026-03-28T11:00:00.000Z"); // CET, +01:00
    expect(wallClockInstant("2026-03-29", "12:00", "Europe/Berlin")).toBe("2026-03-29T10:00:00.000Z"); // CEST, +02:00
    expect(wallClockInstant("2026-11-01", "12:00", "America/New_York")).toBe("2026-11-01T17:00:00.000Z"); // EST after the fall-back
    expect(wallClockInstant("2026-10-29", "09:30", "Asia/Ho_Chi_Minh")).toBe("2026-10-29T02:30:00.000Z");
    expect(wallClockInstant("2026-10-29", "09:30", "UTC")).toBe("2026-10-29T09:30:00.000Z");
  });

  it("rejects a time that does not exist in that zone and unknown zones", () => {
    expect(wallClockInstant("2026-03-29", "02:30", "Europe/Berlin")).toBeNull(); // skipped by the spring-forward
    expect(wallClockInstant("2026-02-30", "10:00", "UTC")).toBeNull();
    expect(wallClockInstant("2026-10-29", "25:00", "UTC")).toBeNull();
    expect(wallClockInstant("2026-10-29", "10:00", "Mars/Olympus")).toBeNull();
  });

  it("handles zones west of UTC and clock times that cross midnight", () => {
    expect(wallClockInstant("2026-03-08", "02:30", "America/Los_Angeles")).toBeNull(); // skipped by the spring-forward
    expect(wallClockInstant("2026-03-08", "12:00", "America/Los_Angeles")).toBe("2026-03-08T19:00:00.000Z"); // PDT, -07:00
    expect(wallClockInstant("2026-11-01", "01:30", "America/Los_Angeles")).toBe("2026-11-01T08:30:00.000Z"); // happens twice: the first one
    expect(wallClockInstant("2026-10-29", "23:30", "Europe/Berlin")).toBe("2026-10-29T22:30:00.000Z");
    expect(wallClockOf("2026-10-29T23:30:00.000Z", "Europe/Berlin")).toEqual({ date: "2026-10-30", time: "00:30" });
    expect(wallClockOf("2026-10-30T03:00:00.000Z", "America/Los_Angeles")).toEqual({ date: "2026-10-29", time: "20:00" });
  });

  it("reads an instant back as the wall clock in a zone", () => {
    expect(wallClockOf("2026-03-29T10:00:00.000Z", "Europe/Berlin")).toEqual({ date: "2026-03-29", time: "12:00" });
    expect(wallClockOf("2026-10-29T02:30:00.000Z", "Asia/Ho_Chi_Minh")).toEqual({ date: "2026-10-29", time: "09:30" });
  });

  it("counts the viewer's other live events that overlap", () => {
    const events = [standup, mine, { ...standup, id: "e9", status: "cancelled" }, { ...standup, id: "e8", attendees: [{ user: avery, response: "accepted" }], myResponse: null }];
    const noon = Date.parse("2026-10-28T12:30:00.000Z");
    expect(overlapCount(events, "u-casey", noon, noon + 3_600_000, null)).toBe(1);
    expect(overlapCount(events, "u-casey", noon, noon + 3_600_000, "e1")).toBe(0);
    expect(overlapCount(events, "u-casey", Date.parse("2026-10-28T13:00:00.000Z"), noon + 7_200_000, null)).toBe(0);
  });
});

describe("new event", () => {
  it("posts the exact body with instants computed from the chosen zone, then reloads the week", async () => {
    renderPage();
    const { dialog } = await openNewEvent();
    await fillBasics();
    await userEvent.type(screen.getByLabelText("Location"), "Room 1");
    await userEvent.type(screen.getByLabelText("Description"), "Quarterly");
    await userEvent.click(await within(dialog).findByRole("checkbox", { name: /Avery Founder/ }));
    const reads = calendarReads();
    await userEvent.click(within(dialog).getByRole("button", { name: "Create event" }));

    await waitFor(() => expect(writes()).toHaveLength(1));
    const [post] = writes();
    expect(post.url).toBe("/api/v1/workspaces/w1/calendar-events");
    expect(post.method).toBe("POST");
    expect(JSON.parse(post.body ?? "{}")).toEqual({
      title: "Planning",
      description: "Quarterly",
      location: "Room 1",
      startsAt: "2026-10-29T13:00:00.000Z",
      endsAt: "2026-10-29T14:00:00.000Z",
      timezone: "Europe/Berlin",
      attendeeUserIds: ["u-avery"],
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(calendarReads()).toBeGreaterThan(reads));
  });

  it("includes the chosen project and open task, and omits empty optional fields", async () => {
    renderPage();
    const { dialog } = await openNewEvent();
    await fillBasics();
    await userEvent.selectOptions(within(dialog).getByLabelText("Project"), "p1");
    const task = within(dialog).getByLabelText("Task");
    await waitFor(() => expect(within(task).getByRole("option", { name: /ATLAS-1/ })).toBeInTheDocument());
    expect(within(task).queryByRole("option", { name: /ATLAS-2/ })).not.toBeInTheDocument();
    await userEvent.selectOptions(task, "i1");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create event" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0].body ?? "{}")).toEqual({
      title: "Planning", startsAt: "2026-10-29T13:00:00.000Z", endsAt: "2026-10-29T14:00:00.000Z", timezone: "Europe/Berlin", projectId: "p1", issueId: "i1", attendeeUserIds: [],
    });
  });

  it("blocks submit when the end is not after the start", async () => {
    renderPage();
    const { dialog } = await openNewEvent();
    await fillBasics();
    setField("End time", "14:00");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create event" }));
    expect(within(dialog).getByText("The event must end after it starts.")).toBeInTheDocument();
    expect(writes()).toHaveLength(0);
    setField("End time", "13:00");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create event" }));
    expect(writes()).toHaveLength(0);
  });

  it("requires a title and rejects over-long text", async () => {
    renderPage();
    const { dialog } = await openNewEvent();
    setField("Date", "2026-10-29");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create event" }));
    expect(within(dialog).getByText("Enter a title.")).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveAttribute("maxlength", "200");
    expect(screen.getByLabelText("Location")).toHaveAttribute("maxlength", "200");
    expect(screen.getByLabelText("Description")).toHaveAttribute("maxlength", "2000");
    expect(writes()).toHaveLength(0);
  });

  it("disables the button while the request is in flight, so a double click creates one event", async () => {
    let release: (response: Response) => void = () => {};
    handler = (request) => (request.method === "POST" ? new Promise<Response>((resolve) => { release = resolve; }) : undefined);
    renderPage();
    const { dialog } = await openNewEvent();
    await fillBasics();
    const submit = within(dialog).getByRole("button", { name: "Create event" });
    await userEvent.dblClick(submit);
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Creating…" })).toBeDisabled());
    expect(writes()).toHaveLength(1);
    release(json({ ...mine, id: "e7" }, 201));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(writes()).toHaveLength(1);
  });

  it("shows a 400 detail next to its field", async () => {
    handler = (request) => (request.method === "POST" ? problemResponse(400, "invalid_input", "Invalid event attendees") : undefined);
    renderPage();
    const { dialog } = await openNewEvent();
    await fillBasics();
    await userEvent.click(within(dialog).getByRole("button", { name: "Create event" }));
    expect(await within(dialog).findByText(/Invalid event attendees/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Create event" })).toBeEnabled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("notes overlaps with the viewer's own events without blocking", async () => {
    renderPage();
    const { dialog } = await openNewEvent();
    await screen.findByText("Founder stand-up");
    await fillBasics();
    setField("Date", "2026-10-28");
    setField("Start time", "13:30"); // 12:30Z in Berlin (CET after Oct 25), inside the 12:00-13:00Z stand-up
    setField("End time", "14:30");
    expect(await within(dialog).findByText("Overlaps with 1 of your events")).toBeInTheDocument();
    setField("Start time", "16:00");
    setField("End time", "17:00");
    expect(within(dialog).queryByText(/Overlaps with/)).not.toBeInTheDocument();
  });

  it("opens from an empty day with that date and closes on Escape, returning focus to the trigger", async () => {
    renderPage();
    const friday = await screen.findByRole("region", { name: "Friday, Oct 30" });
    await userEvent.click(friday);
    const dialog = await screen.findByRole("dialog", { name: "New event" });
    expect(within(dialog).getByLabelText("Date")).toHaveValue("2026-10-30");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    const trigger = screen.getByRole("button", { name: "New event" });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    await screen.findByRole("dialog", { name: "New event" });
    expect(within(screen.getByRole("dialog")).getByLabelText("Title")).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

describe("event details", () => {
  it("shows the event, its organizer and every attendee's answer", async () => {
    renderPage();
    const dialog = await openEvent("Founder stand-up");
    expect(within(dialog).getByText("Daily sync")).toBeInTheDocument();
    expect(within(dialog).getByText("Team room")).toBeInTheDocument();
    expect(within(dialog).getByText(/Organizer/)).toBeInTheDocument();
    const people = within(dialog).getByRole("list", { name: "Attendees" });
    expect(within(people).getByText("Avery Founder")).toBeInTheDocument();
    expect(within(people).getByText("Going")).toBeInTheDocument();
    expect(within(people).getByText("Awaiting reply")).toBeInTheDocument();
  });

  it("a plain member can answer an invitation but sees no Edit or Cancel", async () => {
    renderPage();
    const dialog = await openEvent("Founder stand-up");
    const group = within(dialog).getByRole("group", { name: "Your response" });
    expect(within(group).getAllByRole("button").map((button) => button.textContent)).toEqual(["Accept", "Maybe", "Decline"]);
    expect(within(dialog).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Cancel event" })).not.toBeInTheDocument();
  });

  it("shows no RSVP to someone who is not invited", async () => {
    calendarEvents = [{ ...standup, myResponse: null, attendees: [{ user: avery, response: "accepted" }] }];
    renderPage();
    const dialog = await openEvent("Founder stand-up");
    expect(within(dialog).queryByRole("group", { name: "Your response" })).not.toBeInTheDocument();
  });

  it("answers with PUT attendees/me, optimistically, and reloads the week", async () => {
    let release: (response: Response) => void = () => {};
    handler = (request) => (request.method === "PUT" ? new Promise<Response>((resolve) => { release = resolve; }) : undefined);
    renderPage();
    const dialog = await openEvent("Founder stand-up");
    const reads = calendarReads();
    const maybe = within(dialog).getByRole("button", { name: "Maybe" });
    await userEvent.click(maybe);
    expect(maybe).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByRole("button", { name: "Accept" })).toHaveAttribute("aria-pressed", "false");
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ url: "/api/v1/calendar-events/e1/attendees/me", method: "PUT" });
    expect(JSON.parse(writes()[0].body ?? "{}")).toEqual({ response: "tentative" });
    release(json({ ...standup, myResponse: "tentative", attendees: [{ user: avery, response: "accepted" }, { user: casey, response: "tentative" }] }));
    await waitFor(() => expect(calendarReads()).toBeGreaterThan(reads));
    expect(maybe).toHaveAttribute("aria-pressed", "true");
  });

  it("rolls the answer back and says why when the request fails", async () => {
    handler = (request) => (request.method === "PUT" ? problemResponse(403, "not_invited", "You are not invited to this event.") : undefined);
    renderPage();
    const dialog = await openEvent("Founder stand-up");
    const accept = within(dialog).getByRole("button", { name: "Accept" });
    await userEvent.click(accept);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("You are not invited to this event.");
    expect(accept).toHaveAttribute("aria-pressed", "false");
    expect(within(dialog).getByText("Awaiting reply")).toBeInTheDocument();
  });

  it("answers from the keyboard", async () => {
    renderPage();
    const dialog = await openEvent("Founder stand-up");
    const decline = within(dialog).getByRole("button", { name: "Decline" });
    decline.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0].body ?? "{}")).toEqual({ response: "declined" });
  });

  it("asks before cancelling, then POSTs cancel with If-Match and an empty JSON body", async () => {
    handler = (request) => (request.method === "POST" ? json({ ...mine, status: "cancelled", canEdit: false, version: 2 }) : undefined);
    renderPage();
    const dialog = await openEvent("Design review");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel event" }));
    expect(writes()).toHaveLength(0);
    expect(within(dialog).getByText(/Cancel this event\?/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Keep event" }));
    expect(writes()).toHaveLength(0);

    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel event" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Yes, cancel event" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const [post] = writes();
    expect(post).toMatchObject({ url: "/api/v1/calendar-events/e2/cancel", method: "POST" });
    expect(post.headers["If-Match"]).toBe('"v1"');
    expect(post.body).toBe("{}");
    expect(post.headers["Content-Type"]).toBe("application/json");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("says a cancelled event was cancelled on a 409", async () => {
    handler = (request) => (request.method === "POST" ? problemResponse(409, "event_already_cancelled", "The event is already cancelled.") : undefined);
    renderPage();
    const dialog = await openEvent("Design review");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel event" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Yes, cancel event" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("This event was cancelled");
  });
});

describe("edit event", () => {
  async function openEdit() {
    const details = await openEvent("Design review");
    await userEvent.click(within(details).getByRole("button", { name: "Edit" }));
    return screen.findByRole("dialog", { name: "Edit event" });
  }

  it("prefills from the event in its own zone and sends only the changed field with If-Match", async () => {
    handler = (request) => (request.method === "PATCH" ? json({ ...mine, title: "Design crit", version: 2 }) : undefined);
    renderPage();
    const dialog = await openEdit();
    expect(within(dialog).getByLabelText("Title")).toHaveValue("Design review");
    expect(within(dialog).getByLabelText("Date")).toHaveValue("2026-10-29");
    expect(within(dialog).getByLabelText("Start time")).toHaveValue("13:00"); // 12:00Z in Berlin
    expect(within(dialog).getByLabelText("Time zone")).toHaveValue("Europe/Berlin");
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Design crit" } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const [patch] = writes();
    expect(patch).toMatchObject({ url: "/api/v1/calendar-events/e2", method: "PATCH" });
    expect(patch.headers["If-Match"]).toBe('"v1"');
    expect(JSON.parse(patch.body ?? "{}")).toEqual({ title: "Design crit" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("does not submit when nothing changed", async () => {
    renderPage();
    const dialog = await openEdit();
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(writes()).toHaveLength(0);
    expect(within(dialog).getByText("Nothing has changed.")).toBeInTheDocument();
  });

  it("sends changed times as instants and sends both times when either field changed", async () => {
    handler = (request) => (request.method === "PATCH" ? json({ ...mine, version: 2 }) : undefined);
    renderPage();
    const dialog = await openEdit();
    fireEvent.change(within(dialog).getByLabelText("Start time"), { target: { value: "15:00" } });
    fireEvent.change(within(dialog).getByLabelText("End time"), { target: { value: "16:00" } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0].body ?? "{}")).toEqual({ startsAt: "2026-10-29T14:00:00.000Z", endsAt: "2026-10-29T15:00:00.000Z" });
  });

  it("clearing the project also sends issueId null", async () => {
    handler = (request) => (request.method === "PATCH" ? json({ ...mine, project: null, issue: null, version: 2 }) : undefined);
    renderPage();
    const dialog = await openEdit();
    await userEvent.selectOptions(within(dialog).getByLabelText("Project"), "");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0].body ?? "{}")).toEqual({ projectId: null, issueId: null });
  });

  it("drops attendees who left the workspace from the selection, without sending them", async () => {
    handler = (request) => (request.method === "PATCH" ? json({ ...mine, version: 2 }) : undefined);
    renderPage();
    const dialog = await openEdit();
    const avery = await within(dialog).findByRole("checkbox", { name: /Avery Founder/ });
    expect(avery).toBeChecked();
    expect(within(dialog).queryByRole("checkbox", { name: /Former member/ })).not.toBeInTheDocument();
    // A title edit leaves the attendees untouched, so they are not sent at all.
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Renamed" } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0].body ?? "{}")).toEqual({ title: "Renamed" });
  });

  it("sends the replacement attendee set without the former member", async () => {
    handler = (request) => (request.method === "PATCH" ? json({ ...mine, version: 2 }) : undefined);
    renderPage();
    const dialog = await openEdit();
    await userEvent.click(await within(dialog).findByRole("checkbox", { name: /Blake Builder/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0].body ?? "{}")).toEqual({ attendeeUserIds: ["u-avery", "u-blake"] });
  });

  it("on 412 says a teammate updated it, shows the current event and retries with the new version", async () => {
    const current = { ...mine, title: "Design review (moved)", version: 2 };
    let first = true;
    handler = (request) => {
      if (request.method !== "PATCH") return undefined;
      if (first) {
        first = false;
        return problemResponse(412, "version_mismatch", "The resource changed since you loaded it.", { current });
      }
      return json({ ...current, description: "Changed", version: 3 });
    };
    renderPage();
    const dialog = await openEdit();
    fireEvent.change(within(dialog).getByLabelText("Description"), { target: { value: "Changed" } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Updated by a teammate");
    expect(within(dialog).getByLabelText("Title")).toHaveValue("Design review (moved)");
    expect(within(dialog).getByLabelText("Description")).toHaveValue("");

    fireEvent.change(within(dialog).getByLabelText("Description"), { target: { value: "Changed" } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1].headers["If-Match"]).toBe('"v2"');
    expect(JSON.parse(writes()[1].body ?? "{}")).toEqual({ description: "Changed" });
  });

  it("says the event was cancelled on a 409 event_cancelled", async () => {
    handler = (request) => (request.method === "PATCH" ? problemResponse(409, "event_cancelled", "A cancelled event cannot change.") : undefined);
    renderPage();
    const dialog = await openEdit();
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Late edit" } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("This event was cancelled");
  });

  it("shows a 403 inline", async () => {
    handler = (request) => (request.method === "PATCH" ? problemResponse(403, "insufficient_role", "Only the organizer, owners and admins can change this event.") : undefined);
    renderPage();
    const dialog = await openEdit();
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Nope" } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Only the organizer, owners and admins can change this event.");
  });
});

describe("event dialog fixes", () => {
  async function openEdit(title = "Design review") {
    const details = await openEvent(title);
    await userEvent.click(within(details).getByRole("button", { name: "Edit" }));
    return screen.findByRole("dialog", { name: "Edit event" });
  }

  it("never offers the previous project tasks while the new project board loads", async () => {
    let release: (response: Response) => void = () => {};
    handler = (request) => (request.url === "/api/v1/projects/p2/board" ? new Promise<Response>((resolve) => { release = resolve; }) : undefined);
    renderPage();
    const { dialog } = await openNewEvent();
    await fillBasics();
    await userEvent.selectOptions(within(dialog).getByLabelText("Project"), "p1");
    const task = within(dialog).getByLabelText("Task");
    await waitFor(() => expect(within(task).getByRole("option", { name: /ATLAS-1/ })).toBeInTheDocument());
    await userEvent.selectOptions(task, "i1");

    await userEvent.selectOptions(within(dialog).getByLabelText("Project"), "p2");
    expect(within(task).queryByRole("option", { name: /ATLAS-1/ })).not.toBeInTheDocument();
    expect(task).toHaveValue("");
    release(json({ ...BOARD, project: { id: "p2", key: "BETA", name: "Beta app", methodology: "scrum" }, issues: [{ id: "i9", number: 1, key: "BETA-1", title: "Beta task", statusId: "s1" }] }));
    await waitFor(() => expect(within(task).getByRole("option", { name: /BETA-1/ })).toBeInTheDocument());
    await userEvent.selectOptions(task, "i9");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create event" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0].body ?? "{}")).toMatchObject({ projectId: "p2", issueId: "i9" });
  });

  it("an admin editing someone else's event is told the organizer attends, not 'you'", async () => {
    calendarEvents = [{ ...standup, canEdit: true }];
    renderPage();
    const dialog = await openEdit("Founder stand-up");
    expect(within(dialog).getByText("The organizer always attends.")).toBeInTheDocument();
    expect(within(dialog).queryByText("You are the organizer and always attend.")).not.toBeInTheDocument();
  });

  it("the organizer's own edit keeps the 'you' wording", async () => {
    renderPage();
    const dialog = await openEdit();
    expect(within(dialog).getByText("You are the organizer and always attend.")).toBeInTheDocument();
  });

  it("refuses more than 50 attendees before sending", () => {
    const values: EventFormValues = { title: "Big", description: "", location: "", date: "2026-10-29", startTime: "09:00", endDate: "2026-10-29", endTime: "10:00", timezone: "UTC", projectId: "", issueId: "", attendeeIds: [] };
    const ids = (count: number) => Array.from({ length: count }, (_, index) => `u-${index}`);
    expect(validateEventForm({ ...values, attendeeIds: ids(50) }).errors.attendees).toBeUndefined();
    expect(validateEventForm({ ...values, attendeeIds: ids(51) }).errors.attendees).toBe("Invite at most 50 people.");
  });

  it("a zone-only change keeps the clock time, says so, and sends the new instants", async () => {
    handler = (request) => (request.method === "PATCH" ? json({ ...mine, version: 2 }) : undefined);
    renderPage();
    const dialog = await openEdit();
    expect(within(dialog).getByText("Keeps the clock time; if the moment changes, responses reset.")).toBeInTheDocument();
    await setZone("Asia/Ho_Chi_Minh");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0].body ?? "{}")).toEqual({ timezone: "Asia/Ho_Chi_Minh", startsAt: "2026-10-29T06:00:00.000Z", endsAt: "2026-10-29T07:00:00.000Z" });
  });

  it("a 412 without a current event reloads it with a GET", async () => {
    handler = (request) => {
      if (request.method === "PATCH") return problemResponse(412, "version_mismatch", "The resource changed since you loaded it.");
      if (request.url === "/api/v1/calendar-events/e2") return json({ ...mine, title: "Fetched title", version: 5 });
      return undefined;
    };
    renderPage();
    const dialog = await openEdit();
    fireEvent.change(within(dialog).getByLabelText("Description"), { target: { value: "x" } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Updated by a teammate");
    expect(within(dialog).getByLabelText("Title")).toHaveValue("Fetched title");
  });

  it("leaves attendees out of the PATCH when the member list failed to load", async () => {
    handler = (request) => {
      if (request.url === "/api/v1/workspaces/w1/members") return problemResponse(500, "boom", "x");
      if (request.method === "PATCH") return json({ ...mine, version: 2 });
      return undefined;
    };
    renderPage();
    const dialog = await openEdit();
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Renamed" } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0].body ?? "{}")).toEqual({ title: "Renamed" });
  });

  it("a 412 on cancel says a teammate updated it and shows the current event", async () => {
    handler = (request) => (request.method === "POST" ? problemResponse(412, "version_mismatch", "changed", { current: { ...mine, title: "Design review v2", version: 2 } }) : undefined);
    renderPage();
    const dialog = await openEvent("Design review");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel event" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Yes, cancel event" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Updated by a teammate");
    expect(screen.getByRole("dialog", { name: "Design review v2" })).toBeInTheDocument();
  });

  it("a 409 on an answer says the event was cancelled and rolls back", async () => {
    handler = (request) => (request.method === "PUT" ? problemResponse(409, "event_cancelled", "A cancelled event cannot change.") : undefined);
    renderPage();
    const dialog = await openEvent("Founder stand-up");
    const accept = within(dialog).getByRole("button", { name: "Accept" });
    await userEvent.click(accept);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("This event was cancelled");
    expect(accept).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps focus inside the dialog when opening and leaving the cancel confirmation", async () => {
    renderPage();
    const dialog = await openEvent("Design review");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel event" }));
    expect(within(dialog).getByRole("button", { name: "Keep event" })).toHaveFocus();
    await userEvent.click(within(dialog).getByRole("button", { name: "Keep event" }));
    expect(within(dialog).getByRole("button", { name: "Cancel event" })).toHaveFocus();
  });

  it("marks the answer buttons busy without dropping keyboard focus while an answer is in flight", async () => {
    let release: (response: Response) => void = () => {};
    handler = (request) => (request.method === "PUT" ? new Promise<Response>((resolve) => { release = resolve; }) : undefined);
    renderPage();
    const dialog = await openEvent("Founder stand-up");
    const accept = within(dialog).getByRole("button", { name: "Accept" });
    accept.focus();
    await userEvent.keyboard("{Enter}");
    for (const name of ["Accept", "Maybe", "Decline"]) expect(within(dialog).getByRole("button", { name })).toHaveAttribute("aria-disabled", "true");
    expect(accept).toHaveFocus();
    release(json({ ...standup, myResponse: "accepted" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Maybe" })).not.toHaveAttribute("aria-disabled"));
    expect(accept).toHaveFocus();
  });
});
