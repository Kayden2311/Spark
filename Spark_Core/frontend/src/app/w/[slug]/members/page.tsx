"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { useAuth } from "../../../auth-context";
import { PageTitle, initials } from "../../../components";
import { Modal } from "../../_components/modal";
import { ApiError, canManage, messageOf, roleLabel, workspaceApi, type WorkspaceInvitation, type WorkspaceMember, type WorkspaceRole } from "../../_lib/api";
import { forgetWorkspace } from "../../_lib/last-workspace";
import { useWorkspaceData } from "../../_lib/use-workspace-data";
import { useWorkspace } from "../workspace-context";
import { InviteDialog } from "./invite-dialog";

const LAST_OWNER = "A workspace needs at least one owner.";
const ROLES: WorkspaceRole[] = ["owner", "admin", "member"];
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const joinedFormat = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" });

function joined(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : joinedFormat.format(date);
}

function expiresIn(iso: string): string {
  const left = Date.parse(iso) - Date.now();
  if (Number.isNaN(left) || left <= 0) return "Expired";
  if (left < DAY) {
    const hours = Math.ceil(left / HOUR);
    return `Expires in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const days = Math.round(left / DAY);
  return `Expires in ${days} ${days === 1 ? "day" : "days"}`;
}

function errorFor(error: unknown): string {
  return error instanceof ApiError && error.code === "last_owner" ? LAST_OWNER : messageOf(error);
}

type Confirm =
  | { kind: "remove"; member: WorkspaceMember }
  | { kind: "leave"; member: WorkspaceMember }
  | { kind: "demote-self"; member: WorkspaceMember; role: WorkspaceRole };
type Toast = { id: number; text: string; tone: "success" | "error" };

export default function MembersPage() {
  const { workspace, reload: reloadWorkspace } = useWorkspace();
  const { user, refreshSession } = useAuth();
  const router = useRouter();
  const manager = canManage(workspace.role);
  const isOwner = workspace.role === "owner";
  const members = useWorkspaceData<{ items: WorkspaceMember[] }>(`/workspaces/${workspace.id}/members`);
  const invitations = useWorkspaceData<{ items: WorkspaceInvitation[] }>(manager ? `/workspaces/${workspace.id}/invitations?status=pending` : null);

  // Optimistic role while a change is in flight; it belongs to one copy of the list and is dropped on reload.
  const [override, setOverride] = useState<{ list: unknown; roles: Record<string, WorkspaceRole> }>({ list: null, roles: {} });
  const [rowError, setRowError] = useState<{ userId: string; text: string } | null>(null);
  const [savingRole, setSavingRole] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [busyInvite, setBusyInvite] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast((current) => (current?.id === toast.id ? null : current)), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // A 404 here means access was removed after the workspace loaded: let the layout re-check and show its not-found state.
  useEffect(() => {
    if (members.errorStatus === 404) reloadWorkspace();
  }, [members.errorStatus, reloadWorkspace]);

  const notify = (text: string, tone: Toast["tone"] = "success") => setToast((current) => ({ id: (current?.id ?? 0) + 1, text, tone }));
  const list = members.data?.items ?? [];
  const roles = override.list === members.data ? override.roles : {};
  const me = user?.id;

  const changeRole = async (member: WorkspaceMember, role: WorkspaceRole, confirmed = false) => {
    if (role === member.role) return;
    // An owner giving up their own owner role cannot take it back alone: confirm first.
    if (!confirmed && member.userId === me && member.role === "owner") {
      setConfirm({ kind: "demote-self", member, role });
      return;
    }
    setRowError(null);
    setSavingRole(member.userId);
    setOverride({ list: members.data, roles: { ...roles, [member.userId]: role } });
    try {
      await workspaceApi<WorkspaceMember>(`/workspaces/${workspace.id}/members/${member.userId}`, { method: "PATCH", body: { role } });
      members.reload();
      notify(`${member.displayName} is now ${role === "admin" ? "an" : "a"} ${roleLabel(role).toLowerCase()}.`);
      if (member.userId === me) {
        reloadWorkspace();
        void refreshSession();
      }
    } catch (error) {
      setOverride((current) => {
        const next = { ...current.roles };
        delete next[member.userId];
        return { list: current.list, roles: next };
      });
      setRowError({ userId: member.userId, text: errorFor(error) });
    } finally {
      setSavingRole(null);
    }
  };

  const closeConfirm = () => {
    setConfirm(null);
    setConfirmError(null);
  };

  const runConfirm = async () => {
    if (!confirm || confirmBusy) return;
    if (confirm.kind === "demote-self") {
      closeConfirm();
      void changeRole(confirm.member, confirm.role, true);
      return;
    }
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      await workspaceApi<void>(`/workspaces/${workspace.id}/members/${confirm.member.userId}`, { method: "DELETE" });
      if (confirm.kind === "leave") {
        forgetWorkspace(workspace.slug);
        await refreshSession();
        router.push("/workspace");
        return;
      }
      setConfirmBusy(false);
      closeConfirm();
      notify(`${confirm.member.displayName} was removed from ${workspace.name}.`);
      members.reload();
      reloadWorkspace();
    } catch (error) {
      setConfirmBusy(false);
      setConfirmError(errorFor(error));
    }
  };

  const settleInvitation = async (invitation: WorkspaceInvitation, action: "resend" | "revoke") => {
    setBusyInvite(invitation.id);
    try {
      if (action === "resend") {
        await workspaceApi(`/workspaces/${workspace.id}/invitations/${invitation.id}/resend`, { method: "POST" });
        notify("New link sent; the previous link no longer works.");
      } else {
        await workspaceApi<void>(`/workspaces/${workspace.id}/invitations/${invitation.id}`, { method: "DELETE" });
        notify(`Invitation to ${invitation.email} revoked.`);
      }
    } catch (error) {
      notify(error instanceof ApiError && error.code === "not_pending" ? "That invitation is no longer pending." : messageOf(error), "error");
    } finally {
      setBusyInvite(null);
      invitations.reload();
    }
  };

  const canRemove = (member: WorkspaceMember) => member.userId !== me && (isOwner || (workspace.role === "admin" && member.role === "member"));
  const pending = invitations.data?.items ?? [];
  const count = list.length || workspace.memberCount;

  return (
    <div className="wsMembers">
      <div aria-hidden="true" className="wsGlow" />
      <PageTitle eyebrow={workspace.name} title="Members">
        {manager && (
          <button className="sparkPrimary" onClick={() => setInviting(true)} type="button">
            <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="10" cy="8.5" r="3.5" /><path d="M3.5 19.5c.7-3.4 3.3-5.2 6.5-5.2 1.4 0 2.7.3 3.8 1M18 13v6M15 16h6" /></svg>
            Invite people
          </button>
        )}
      </PageTitle>
      <p className="wsPageLead">
        {count} {count === 1 ? "person" : "people"} in {workspace.name}.{" "}
        {isOwner ? "As an owner you decide who can manage the workspace." : manager ? "Admins invite people and manage members." : "Owners and admins manage who belongs here."}
      </p>

      <section aria-labelledby="members-title" className="wsCard wsMembersCard">
        <header className="wsCardHeader">
          <div>
            <h2 id="members-title">People</h2>
            <p>Everyone with access to this workspace.</p>
          </div>
          <span className="wsCount">{count}</span>
        </header>

        {members.error && !members.data && (
          <div className="wsAlert wsInlineAlert" role="alert">
            {members.error}
            <button className="textButton" onClick={members.reload} type="button">Try again</button>
          </div>
        )}

        {!members.data && !members.error && (
          <div aria-busy="true" className="wsRowsSkeleton" role="status">
            <span className="wsSrOnly">Loading members…</span>
            <span /><span /><span />
          </div>
        )}

        {members.data && (
          <table aria-label="Members" className="wsTable">
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col">Role</th>
                <th scope="col">Joined</th>
                <th scope="col"><span className="wsSrOnly">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {list.map((member) => {
                const self = member.userId === me;
                const role = roles[member.userId] ?? member.role;
                const problem = rowError?.userId === member.userId ? rowError.text : null;
                return (
                  <tr data-self={self || undefined} key={member.userId}>
                    <td className="wsMemberTd">
                      <div className="wsMemberCell">
                        <span aria-hidden="true" className="avatar" data-role={member.role}>{initials(member.displayName, "?")}</span>
                        <span className="wsMemberName">
                          <strong>{member.displayName}{self && <span className="wsYou">You</span>}</strong>
                          {member.email && <small>{member.email}</small>}
                        </span>
                      </div>
                    </td>
                    <td className="wsRoleCell" data-label="Role">
                      {isOwner ? (
                        <select
                          aria-describedby={problem ? `role-error-${member.userId}` : undefined}
                          aria-invalid={problem ? true : undefined}
                          aria-label={`Role for ${member.displayName}`}
                          className="wsSelect wsRoleSelect"
                          data-role={role}
                          disabled={savingRole === member.userId}
                          onChange={(event) => void changeRole(member, event.target.value as WorkspaceRole)}
                          value={role}
                        >
                          {ROLES.map((option) => <option key={option} value={option}>{roleLabel(option)}</option>)}
                        </select>
                      ) : (
                        <span className="wsRole" data-role={member.role}>{roleLabel(member.role)}</span>
                      )}
                      {problem && <p className="wsFieldError" id={`role-error-${member.userId}`} role="alert">{problem}</p>}
                    </td>
                    <td className="wsJoinedCell" data-label="Joined">{joined(member.joinedAt)}</td>
                    <td className="wsActionsCell">
                      {self ? (
                        <button className="wsGhostButton" onClick={() => setConfirm({ kind: "leave", member })} type="button">Leave workspace</button>
                      ) : canRemove(member) ? (
                        <button aria-label={`Remove ${member.displayName}`} className="wsGhostButton danger" onClick={() => setConfirm({ kind: "remove", member })} type="button">Remove</button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {manager && (
        <section aria-labelledby="pending-title" className="wsCard wsPendingCard">
          <header className="wsCardHeader">
            <div>
              <h2 id="pending-title">Pending invitations</h2>
              <p>Each link works once and expires after 7 days. Resending sends a fresh link.</p>
            </div>
            <span className="wsCount">{invitations.data ? pending.length : "—"}</span>
          </header>
          {invitations.error && !invitations.data && <div className="wsAlert wsInlineAlert" role="alert">{invitations.error}</div>}
          {invitations.data && pending.length === 0 && (
            <div className="wsPendingEmpty">
              <span aria-hidden="true" className="wsPendingIcon"><svg viewBox="0 0 24 24"><rect height="13" rx="2.5" width="16" x="4" y="5.5" /><path d="M4 7.5 12 13l8-5.5" /></svg></span>
              <p>No invitations waiting. Invite teammates by email and they&apos;ll show up here until they join.</p>
            </div>
          )}
          {pending.length > 0 && (
            <ul className="wsPendingList">
              {pending.map((invitation) => (
                <li key={invitation.id}>
                  <span aria-hidden="true" className="wsPendingIcon"><svg viewBox="0 0 24 24"><rect height="13" rx="2.5" width="16" x="4" y="5.5" /><path d="M4 7.5 12 13l8-5.5" /></svg></span>
                  <span className="wsPendingText">
                    <strong>{invitation.email}</strong>
                    <small>Invited by {invitation.invitedBy.displayName}<span aria-hidden="true" className="wsDot">·</span><span className="wsExpiry">{expiresIn(invitation.expiresAt)}</span></small>
                  </span>
                  <span className="wsRole" data-role={invitation.role}>{roleLabel(invitation.role)}</span>
                  {/* Only owners may resend or revoke an admin invitation; the API refuses it for admins. */}
                  {(isOwner || invitation.role !== "admin") && (
                    <span className="wsPendingActions">
                      <button aria-label={`Resend invitation to ${invitation.email}`} className="wsGhostButton" disabled={busyInvite === invitation.id} onClick={() => void settleInvitation(invitation, "resend")} type="button">Resend</button>
                      <button aria-label={`Revoke invitation to ${invitation.email}`} className="wsGhostButton danger" disabled={busyInvite === invitation.id} onClick={() => void settleInvitation(invitation, "revoke")} type="button">Revoke</button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {inviting && (
        <InviteDialog
          onClose={() => setInviting(false)}
          onSent={invitations.reload}
          workspace={workspace}
        />
      )}

      {confirm?.kind === "demote-self" && (
        <Modal
          description={<p>You&apos;ll lose owner rights in {workspace.name} and become {confirm.role === "admin" ? "an admin" : "a member"}. Only another owner can make you an owner again.</p>}
          onClose={closeConfirm}
          title="Change your own role?"
          tone="danger"
        >
          <div className="wsModalActions">
            <button className="sparkSecondary" data-autofocus onClick={closeConfirm} type="button">Cancel</button>
            <button className="wsDangerButton" onClick={() => void runConfirm()} type="button">Change my role</button>
          </div>
        </Modal>
      )}

      {confirm && confirm.kind !== "demote-self" && (
        <Modal
          busy={confirmBusy}
          description={confirm.kind === "leave"
            ? <p>You&apos;ll lose access to {workspace.name} and its projects. An owner or admin can invite you back later.</p>
            : <p>{confirm.member.displayName} will lose access to {workspace.name} right away. You can invite them again later.</p>}
          onClose={closeConfirm}
          title={confirm.kind === "leave" ? `Leave ${workspace.name}?` : `Remove ${confirm.member.displayName}?`}
          tone="danger"
        >
          {confirmError && <p className="wsAlert" role="alert">{confirmError}</p>}
          <div className="wsModalActions">
            <button className="sparkSecondary" data-autofocus disabled={confirmBusy} onClick={closeConfirm} type="button">Cancel</button>
            <button className="wsDangerButton" disabled={confirmBusy} onClick={() => void runConfirm()} type="button">
              {confirmBusy ? "Working…" : confirm.kind === "leave" ? "Leave workspace" : "Remove"}
            </button>
          </div>
        </Modal>
      )}

      {/* One live region stays mounted so screen readers announce each new message. */}
      <div aria-live="polite" className="wsToastRegion" role="status">
        {toast && (
          <div className="wsToast" data-tone={toast.tone} key={toast.id}>
            <svg aria-hidden="true" viewBox="0 0 24 24">{toast.tone === "success" ? <path d="m5 12.5 4.5 4.5L19 7.5" /> : <path d="M12 7v6M12 16.5v.5" />}</svg>
            {toast.text}
            <button aria-label="Dismiss" onClick={() => setToast(null)} type="button"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" /></svg></button>
          </div>
        )}
      </div>
    </div>
  );
}
