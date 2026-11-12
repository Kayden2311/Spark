"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { initials } from "../../../components";
import { ApiError, communitiesApi, membershipErrorMessage } from "../../_lib/api";
import type { ManagedRequest } from "../../types";
import type { ManageContext } from "./manage-view";
import { useList } from "./use-list";

export const ALREADY_DECIDED = "Someone already decided this request";
export const REQUEST_GONE = "This request no longer exists. It may have been withdrawn.";

const shortDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

export function requestDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : shortDate.format(date);
}

export function RequestsTab({ context }: { context: ManageContext }) {
  const { community, notify, handleAccess, update, refresh } = context;
  const communityId = community.id;
  const load = useCallback((signal: AbortSignal) => communitiesApi.requests(communityId, signal), [communityId]);
  const list = useList<ManagedRequest>(load);
  // Rows being decided disappear at once; a failure other than "already decided" or "gone" brings them back.
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<{ tone: "info" | "danger"; text: string } | null>(null);
  const busy = useRef(new Set<string>());

  useEffect(() => {
    if (list.error) handleAccess(list.error);
  }, [handleAccess, list.error]);

  const decide = async (request: ManagedRequest, decision: "approve" | "reject") => {
    if (busy.current.has(request.id)) return;
    busy.current.add(request.id);
    setNotice(null);
    setRemoved((current) => new Set(current).add(request.id));
    try {
      await communitiesApi.decide(request.id, decision);
      list.setItems((items) => items.filter((item) => item.id !== request.id));
      if (decision === "approve") {
        update((current) => ({ ...current, memberCount: current.memberCount + 1 }));
        notify(`${request.requester.displayName} is now a member.`);
      } else {
        notify(`Declined ${request.requester.displayName}'s request.`);
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === "already_decided") {
        setNotice({ tone: "info", text: ALREADY_DECIDED });
        list.reload();
        // The other decision may have added a member: reload the header count too.
        void refresh();
      } else if (error instanceof ApiError && error.code === "request_not_found") {
        list.setItems((items) => items.filter((item) => item.id !== request.id));
        setNotice({ tone: "info", text: REQUEST_GONE });
      } else if (!handleAccess(error)) {
        setRemoved((current) => {
          const next = new Set(current);
          next.delete(request.id);
          return next;
        });
        setNotice({ tone: "danger", text: membershipErrorMessage(error) });
      }
    } finally {
      busy.current.delete(request.id);
    }
  };

  const items = (list.items ?? []).filter((item) => !removed.has(item.id));
  const failed = Boolean(list.error) && !list.items;

  return (
    <section aria-labelledby="requests-title" className="spPanel">
      <header className="spPanelHead">
        <div className="spPanelHeadText">
          <h2 id="requests-title">Join requests</h2>
          <p>{community.visibility === "private" ? "People who asked to join. Approving makes them members right away." : "Requests left over from when the community was private."}</p>
        </div>
        <span className="spPanelCount">{list.items ? items.length : "—"}</span>
      </header>

      {notice && <p className={notice.tone === "danger" ? "spAlert spAlertDanger spPanelAlert" : "spAlert spPanelAlert"} role={notice.tone === "danger" ? "alert" : "status"}>{notice.text}</p>}

      {failed && !(list.error instanceof ApiError && list.error.status === 401) && (
        <div className="spAlert spAlertDanger spPanelAlert" role="alert">
          {membershipErrorMessage(list.error)}
          <button className="spBtn spBtnSecondary spBtnSm" onClick={list.reload} type="button">Try again</button>
        </div>
      )}

      {!list.items && !failed && (
        <div aria-busy="true" className="spRowsSkeleton" role="status">
          <span className="spSrOnly">Loading requests…</span>
          <span className="spSkeleton" /><span className="spSkeleton" /><span className="spSkeleton" />
        </div>
      )}

      {list.items && items.length === 0 && (
        <div className="spEmpty">
          <span aria-hidden="true" className="spEmptyIcon"><svg viewBox="0 0 24 24"><path d="M4 13.5h4.5l1.5 2.5h4l1.5-2.5H20" /><path d="M5.5 6h13L20 13.5V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18v-4.5z" /></svg></span>
          <h3 className="spEmptyTitle">No pending requests</h3>
          <p className="spEmptyText">{community.visibility === "private" ? "When someone asks to join, their request shows up here." : community.visibility === "public" ? "Public communities don't need approval: people join right away." : "Hidden communities don't take requests. Add people from the Members tab."}</p>
        </div>
      )}

      {items.length > 0 && (
        <ul aria-label="Pending requests" className="spRequestList">
          {items.map((request) => (
            <li className="spRequest" key={request.id}>
              <span aria-hidden="true" className="avatar">{initials(request.requester.displayName, "?")}</span>
              <div className="spRequestBody">
                <p className="spRequestWho">
                  <strong>{request.requester.displayName}</strong>
                  <time className="spRequestDate" dateTime={request.createdAt}>{requestDate(request.createdAt)}</time>
                </p>
                {request.message?.trim() ? <p className="spRequestMessage">{request.message}</p> : <p className="spRequestMessage spRequestMessageEmpty">No message</p>}
              </div>
              <div className="spRequestActions">
                <button aria-label={`Decline ${request.requester.displayName}`} className="spBtn spBtnSecondary spBtnSm" disabled={community.frozen} onClick={() => void decide(request, "reject")} type="button">Decline</button>
                <button aria-label={`Approve ${request.requester.displayName}`} className="spBtn spBtnPrimary spBtnSm" disabled={community.frozen} onClick={() => void decide(request, "approve")} type="button">Approve</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
