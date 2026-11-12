"use client";

import { useCallback, useEffect, useState } from "react";

import { useAuth } from "../../../auth-context";
import { initials } from "../../../components";
import { Modal } from "../../../w/_components/modal";
import { ApiError, communitiesApi, LAST_OWNER_MESSAGE, membershipErrorMessage } from "../../_lib/api";
import type { CommunityMember, CommunityRole, MemberCandidate } from "../../types";
import type { ManageContext } from "./manage-view";
import { useList } from "./use-list";

export const LAST_OWNER = LAST_OWNER_MESSAGE;

const ROLES: Array<[CommunityRole, string]> = [["owner", "Owner"], ["moderator", "Moderator"], ["member", "Member"]];
const ROLE_LABELS: Record<string, string> = Object.fromEntries(ROLES);
const joinedFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

function joined(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : joinedFormat.format(date);
}


function AddFromWorkspace({ context, onAdded, onClose }: { context: ManageContext; onAdded(member: CommunityMember): void; onClose(): void }) {
  const { community, handleAccess } = context;
  const communityId = community.id;
  const load = useCallback((signal: AbortSignal) => communitiesApi.candidates(communityId, signal), [communityId]);
  const candidates = useList<MemberCandidate>(load);
  const [adding, setAdding] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (candidates.error) handleAccess(candidates.error);
  }, [candidates.error, handleAccess]);

  const add = async (candidate: MemberCandidate) => {
    if (adding) return;
    setAdding(candidate.userId);
    setProblem(null);
    try {
      const member = await communitiesApi.addMember(communityId, candidate.userId);
      candidates.setItems((items) => items.filter((item) => item.userId !== candidate.userId));
      onAdded(member);
    } catch (error) {
      if (error instanceof ApiError && error.code === "already_member") {
        candidates.setItems((items) => items.filter((item) => item.userId !== candidate.userId));
      } else if (!handleAccess(error)) {
        setProblem(error instanceof ApiError && error.code === "not_in_workspace" ? `${candidate.displayName} is no longer in ${community.host.name}.` : membershipErrorMessage(error));
      }
    } finally {
      setAdding(null);
    }
  };

  const items = candidates.items ?? [];
  return (
    <Modal
      busy={adding !== null}
      description={<p>People in {community.host.name} who are not in {community.name} yet. They join as members right away{community.visibility === "hidden" ? ", which is the only way into a hidden community" : ""}.</p>}
      onClose={onClose}
      title={`Add from ${community.host.name}`}
    >
      {problem && <p className="spAlert spAlertDanger" role="alert">{problem}</p>}
      {candidates.error && !candidates.items ? (
        <p className="spAlert spAlertDanger" role="alert">{membershipErrorMessage(candidates.error)}</p>
      ) : !candidates.items ? (
        <div aria-busy="true" className="spRowsSkeleton" role="status"><span className="spSrOnly">Loading people…</span><span className="spSkeleton" /><span className="spSkeleton" /></div>
      ) : items.length === 0 ? (
        <p className="spHint">Everyone in {community.host.name} is already in this community.</p>
      ) : (
        <ul aria-label="Workspace members" className="spPickList">
          {items.map((candidate) => (
            <li key={candidate.userId}>
              <span aria-hidden="true" className="avatar">{initials(candidate.displayName, "?")}</span>
              <span className="spPickName">{candidate.displayName}</span>
              <button aria-label={`Add ${candidate.displayName}`} className="spBtn spBtnSecondary spBtnSm" disabled={adding !== null || community.frozen} onClick={() => void add(candidate)} type="button">
                {adding === candidate.userId ? "Adding…" : "Add"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="wsModalActions">
        <button className="spBtn spBtnPrimary" data-autofocus disabled={adding !== null} onClick={onClose} type="button">Done</button>
      </div>
    </Modal>
  );
}

export function MembersTab({ context }: { context: ManageContext }) {
  const { community, canGovern, notify, handleAccess, update, refresh } = context;
  const { user } = useAuth();
  const me = user?.id ?? null;
  const communityId = community.id;
  const load = useCallback((signal: AbortSignal) => communitiesApi.members(communityId, signal), [communityId]);
  const list = useList<CommunityMember>(load);
  const [pendingRole, setPendingRole] = useState<{ userId: string; role: CommunityRole } | null>(null);
  const [rowError, setRowError] = useState<{ userId: string; text: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const [confirm, setConfirm] = useState<CommunityMember | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  useEffect(() => {
    if (list.error) handleAccess(list.error);
  }, [handleAccess, list.error]);

  const changeRole = async (member: CommunityMember, role: CommunityRole) => {
    if (role === member.role || pendingRole) return;
    setRowError(null);
    setPendingRole({ userId: member.userId, role });
    try {
      const updated = await communitiesApi.setRole(communityId, member.userId, role);
      list.setItems((items) => items.map((item) => (item.userId === member.userId ? updated : item)));
      notify(`${member.displayName} is now ${role === "owner" ? "an owner" : role === "moderator" ? "a moderator" : "a member"}.`);
      // Your own role changed: the server decides again what you may do (a host admin keeps governing).
      if (member.userId === me) void refresh();
    } catch (error) {
      if (!handleAccess(error)) setRowError({ userId: member.userId, text: membershipErrorMessage(error) });
    } finally {
      setPendingRole(null);
    }
  };

  const remove = async () => {
    if (!confirm || confirmBusy) return;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      await communitiesApi.removeMember(communityId, confirm.userId);
      list.setItems((items) => items.filter((item) => item.userId !== confirm.userId));
      update((current) => ({ ...current, memberCount: Math.max(0, current.memberCount - 1) }));
      notify(`${confirm.displayName} was removed from ${community.name}.`);
      setConfirm(null);
    } catch (error) {
      if (handleAccess(error)) setConfirm(null);
      else setConfirmError(membershipErrorMessage(error));
    } finally {
      setConfirmBusy(false);
    }
  };

  const added = (member: CommunityMember) => {
    list.setItems((items) => (items.some((item) => item.userId === member.userId) ? items : [...items, member]));
    update((current) => ({ ...current, memberCount: current.memberCount + 1 }));
    notify(`${member.displayName} was added to ${community.name}.`);
  };

  // Owners (and host admins) remove anyone else; moderators remove plain members only.
  const canRemove = (member: CommunityMember) => member.userId !== me && (canGovern || member.role === "member");
  const members = list.items ?? [];

  return (
    <section aria-labelledby="members-title" className="spPanel">
      <header className="spPanelHead">
        <div className="spPanelHeadText">
          <h2 id="members-title">Members</h2>
          <p>{canGovern ? "Owners change roles and settings; moderators review requests and manage members." : "Moderators review requests and add or remove members."}</p>
        </div>
        <button className="spBtn spBtnSecondary spBtnSm" disabled={community.frozen} onClick={() => setPicking(true)} type="button">
          <svg aria-hidden="true" className="spIcon" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>
          Add from workspace
        </button>
      </header>

      {Boolean(list.error) && !list.items && !(list.error instanceof ApiError && list.error.status === 401) && (
        <div className="spAlert spAlertDanger spPanelAlert" role="alert">
          {membershipErrorMessage(list.error)}
          <button className="spBtn spBtnSecondary spBtnSm" onClick={list.reload} type="button">Try again</button>
        </div>
      )}

      {!list.items && !list.error && (
        <div aria-busy="true" className="spRowsSkeleton" role="status">
          <span className="spSrOnly">Loading members…</span>
          <span className="spSkeleton" /><span className="spSkeleton" /><span className="spSkeleton" />
        </div>
      )}

      {list.items && (
        <div className="spTableWrap">
          <table aria-label="Community members" className="spTable spMemberTable">
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col">Role</th>
                <th scope="col">Joined</th>
                <th scope="col"><span className="spSrOnly">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => {
                const role = pendingRole?.userId === member.userId ? pendingRole.role : member.role;
                const problem = rowError?.userId === member.userId ? rowError.text : null;
                return (
                  <tr key={member.userId}>
                    <td>
                      <span className="spMemberCell">
                        <span aria-hidden="true" className="avatar">{initials(member.displayName, "?")}</span>
                        <span className="spMemberName">{member.displayName}{member.userId === me && <span className="spBadge spBadgeAccent spYou">You</span>}</span>
                      </span>
                    </td>
                    <td data-label="Role">
                      {canGovern ? (
                        <select
                          aria-describedby={problem ? `member-role-error-${member.userId}` : undefined}
                          aria-invalid={problem ? true : undefined}
                          aria-label={`Role for ${member.displayName}`}
                          className="spSelect spSelectSm"
                          disabled={pendingRole !== null}
                          onChange={(event) => void changeRole(member, event.target.value as CommunityRole)}
                          value={role}
                        >
                          {ROLES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                      ) : (
                        <span className="spBadge spBadgeDot" data-role={member.role}>{ROLE_LABELS[member.role] ?? "Member"}</span>
                      )}
                      {problem && <p className="spError" id={`member-role-error-${member.userId}`} role="alert">{problem}</p>}
                    </td>
                    <td className="spNum" data-label="Joined">{joined(member.joinedAt)}</td>
                    <td className="spCellActions">
                      {canRemove(member) && (
                        <button aria-label={`Remove ${member.displayName}`} className="spBtn spBtnDangerGhost spBtnSm" onClick={() => { setConfirmError(null); setConfirm(member); }} type="button">Remove</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {picking && <AddFromWorkspace context={context} onAdded={added} onClose={() => setPicking(false)} />}

      {confirm && (
        <Modal
          busy={confirmBusy}
          description={<p>{confirm.displayName} will lose access to {community.name} right away{community.visibility === "public" ? ", but can join again" : ""}.</p>}
          onClose={() => setConfirm(null)}
          title={`Remove ${confirm.displayName}?`}
          tone="danger"
        >
          {confirmError && <p className="spAlert spAlertDanger" role="alert">{confirmError}</p>}
          <div className="wsModalActions">
            <button className="spBtn spBtnSecondary" data-autofocus disabled={confirmBusy} onClick={() => setConfirm(null)} type="button">Cancel</button>
            <button className="spBtn spBtnDanger" disabled={confirmBusy} onClick={() => void remove()} type="button">{confirmBusy ? "Removing…" : "Remove"}</button>
          </div>
        </Modal>
      )}
    </section>
  );
}
