"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import { Modal } from "../../_components/modal";
import { ApiError, messageOf, workspaceApi, type InvitationRole, type Workspace, type WorkspaceInvitation } from "../../_lib/api";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

const CONFLICTS: Record<string, string> = {
  already_member: "That person is already a member of this workspace.",
  invitation_pending: "That email already has a pending invitation. Resend it from the pending list instead.",
  too_many_invitations: "This workspace has too many pending invitations. Revoke a few before sending more.",
  invalid_input: "Enter a valid email address.",
  insufficient_role: "Your role does not allow inviting with that role.",
};

const ROLE_COPY: Record<InvitationRole, string> = {
  member: "Works on every project in the workspace.",
  admin: "Also invites and manages members.",
};

/**
 * Invites one person by email. The worker emails the link; the API never returns it, so the success
 * state only confirms where it went.
 */
export function InviteDialog({ workspace, onClose, onSent }: { workspace: Workspace; onClose(): void; onSent(invitation: WorkspaceInvitation): void }) {
  const roles: InvitationRole[] = workspace.role === "owner" ? ["member", "admin"] : ["member"];
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InvitationRole>("member");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const done = useRef<HTMLButtonElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);

  // The form unmounts on success (and comes back for "Invite another"): keep focus inside the dialog.
  useEffect(() => {
    if (sentTo) done.current?.focus();
    else if (document.activeElement === document.body) emailInput.current?.focus();
  }, [sentTo]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (sending) return;
    const address = email.trim();
    if (!EMAIL_PATTERN.test(address)) {
      setError("Enter a valid email address.");
      return;
    }
    setError(null);
    setSending(true);
    try {
      const { data } = await workspaceApi<{ invitation: WorkspaceInvitation }>(`/workspaces/${workspace.id}/invitations`, { method: "POST", body: { email: address, role } });
      setSentTo(address);
      onSent(data.invitation);
    } catch (problem) {
      setError(problem instanceof ApiError && CONFLICTS[problem.code] ? CONFLICTS[problem.code] : messageOf(problem));
    } finally {
      setSending(false);
    }
  };

  const another = () => {
    setSentTo(null);
    setEmail("");
    setRole("member");
  };

  return (
    <Modal busy={sending} onClose={onClose} title="Invite people">
      {sentTo ? (
        <div className="wsInviteSent" role="status">
          <span aria-hidden="true" className="wsInviteSentIcon">
            <svg viewBox="0 0 24 24"><path d="M4 7.5 12 13l8-5.5" /><rect height="13" rx="2.5" width="16" x="4" y="5.5" /><path d="m15.5 17.5 2 2 3.5-4" /></svg>
          </span>
          <p className="wsInviteSentTitle">Invitation on its way</p>
          <p>Invitation sent to {sentTo}. The link works once and expires in 7 days.</p>
          <div className="wsModalActions">
            <button className="sparkSecondary" onClick={another} type="button">Invite another</button>
            <button className="sparkPrimary" onClick={onClose} ref={done} type="button">Done</button>
          </div>
        </div>
      ) : (
        <form className="wsInviteForm" noValidate onSubmit={onSubmit}>
          <p className="wsModalText">They&apos;ll get an email with a private link to join <strong>{workspace.name}</strong>.</p>
          <div className="wsField">
            <label htmlFor="invite-email">Email address</label>
            <input
              aria-describedby={error ? "invite-error" : undefined}
              aria-invalid={error ? true : undefined}
              autoComplete="off"
              data-autofocus
              id="invite-email"
              inputMode="email"
              maxLength={254}
              onChange={(event) => { setEmail(event.target.value); setError(null); }}
              placeholder="teammate@company.com"
              ref={emailInput}
              type="email"
              value={email}
            />
          </div>
          <div className="wsField">
            <label htmlFor="invite-role">Role</label>
            <select className="wsSelect" disabled={roles.length === 1} id="invite-role" onChange={(event) => setRole(event.target.value as InvitationRole)} value={role}>
              {roles.map((option) => <option key={option} value={option}>{option === "admin" ? "Admin" : "Member"}</option>)}
            </select>
            <p className="wsFieldHint">{ROLE_COPY[role]}{roles.length === 1 ? " Only owners can invite admins." : ""}</p>
          </div>
          {error && <p className="wsAlert" id="invite-error" role="alert">{error}</p>}
          <div className="wsModalActions">
            <button className="sparkSecondary" disabled={sending} onClick={onClose} type="button">Cancel</button>
            <button className="sparkPrimary" disabled={sending} type="submit">{sending ? "Sending…" : "Send invitation"}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}
