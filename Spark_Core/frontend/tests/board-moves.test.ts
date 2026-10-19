import { describe, expect, it } from "vitest";

import { columnIssues, keyboardTarget, moveCard, wipBlocked } from "../src/app/w/_lib/board-moves";
import type { BoardState } from "../src/app/w/_lib/issues";
import { KANBAN_BOARD } from "./project-fixtures";

const board = KANBAN_BOARD as BoardState;
const keys = (state: BoardState, statusId: string) => columnIssues(state, statusId).map((issue) => issue.key);
const count = (state: BoardState, statusId: string) => state.statuses.find((status) => status.id === statusId)?.count;

describe("moveCard", () => {
  it("moves a card across columns, updating counts and order", () => {
    const next = moveCard(board, "i1", "s4", "i4");
    expect(keys(next, "s2")).toEqual(["OPS-2"]);
    expect(keys(next, "s4")).toEqual(["OPS-4", "OPS-1", "OPS-5", "OPS-6"]);
    expect(count(next, "s2")).toBe(1);
    expect(count(next, "s4")).toBe(4);
    expect(next.issues.find((issue) => issue.id === "i1")?.statusId).toBe("s4");
    // The input is left untouched.
    expect(keys(board, "s2")).toEqual(["OPS-1", "OPS-2"]);
    expect(count(board, "s4")).toBe(3);
  });

  it("puts the card first when afterIssueId is null, also in an empty column", () => {
    expect(keys(moveCard(board, "i6", "s4", null), "s4")).toEqual(["OPS-6", "OPS-4", "OPS-5"]);
    const next = moveCard(board, "i2", "s3", null);
    expect(keys(next, "s3")).toEqual(["OPS-2"]);
    expect(count(next, "s3")).toBe(1);
  });

  it("reorders inside a column without changing counts", () => {
    const next = moveCard(board, "i4", "s4", "i6");
    expect(keys(next, "s4")).toEqual(["OPS-5", "OPS-6", "OPS-4"]);
    expect(count(next, "s4")).toBe(3);
  });

  it("keeps the flat list ordered by column", () => {
    const next = moveCard(board, "i0", "s5", "i7");
    expect(next.issues.map((issue) => issue.key)).toEqual(["OPS-1", "OPS-2", "OPS-4", "OPS-5", "OPS-6", "OPS-7", "OPS-9"]);
  });
});

describe("wipBlocked", () => {
  it("blocks entering a column at its limit but never a reorder inside it", () => {
    expect(wipBlocked(board, "i1", "s4")).toBe(true);
    expect(wipBlocked(board, "i4", "s4")).toBe(false);
    expect(wipBlocked(board, "i1", "s3")).toBe(false);
    expect(wipBlocked(board, "i1", "s5")).toBe(false);
  });
});

describe("keyboardTarget", () => {
  it("moves between columns, keeping the position where it can", () => {
    expect(keyboardTarget(board, "i1", "ArrowRight")).toEqual({ statusId: "s3", afterIssueId: null });
    expect(keyboardTarget(board, "i2", "ArrowRight")).toEqual({ statusId: "s3", afterIssueId: null });
    expect(keyboardTarget(board, "i2", "ArrowLeft")).toEqual({ statusId: "s1", afterIssueId: "i0" });
    expect(keyboardTarget(board, "i5", "ArrowRight")).toEqual({ statusId: "s5", afterIssueId: "i7" });
  });

  it("moves up and down inside a column", () => {
    expect(keyboardTarget(board, "i5", "ArrowUp")).toEqual({ statusId: "s4", afterIssueId: null });
    expect(keyboardTarget(board, "i6", "ArrowUp")).toEqual({ statusId: "s4", afterIssueId: "i4" });
    expect(keyboardTarget(board, "i4", "ArrowDown")).toEqual({ statusId: "s4", afterIssueId: "i5" });
  });

  it("returns null at the edges", () => {
    expect(keyboardTarget(board, "i7", "ArrowRight")).toBeNull();
    expect(keyboardTarget(board, "i0", "ArrowLeft")).toBeNull();
    expect(keyboardTarget(board, "i4", "ArrowUp")).toBeNull();
    expect(keyboardTarget(board, "i6", "ArrowDown")).toBeNull();
    expect(keyboardTarget(board, "missing", "ArrowDown")).toBeNull();
  });
});
