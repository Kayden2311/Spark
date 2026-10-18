-- Email delivery foundation. The background worker logs in as spark_worker, which has no table
-- privileges at all: it claims, completes and fails outbox events and reads or re-tokenizes
-- invitations only through the spark.worker_* definer functions below. spark_app and spark_auth get
-- nothing new. Also tightens the invitation write functions from 0015: invitations are created with an
-- unknowable placeholder hash, only the worker issues real tokens, and token lookups re-check the hash
-- under the row lock. Lock order everywhere stays: workspace row, then invitation row, then membership.
GRANT USAGE ON SCHEMA spark TO spark_worker;
--> statement-breakpoint
-- Delivery bookkeeping (lease, attempts, errors) on an old issue event must not be mistaken for an
-- issue change set: only identity columns are checked on update.
DROP TRIGGER issue_change_set ON spark.outbox_events;
CREATE CONSTRAINT TRIGGER issue_change_set
  AFTER INSERT OR DELETE OR UPDATE OF tenant_id, aggregate_type, aggregate_id, aggregate_version ON spark.outbox_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION spark.check_issue_change_set();
--> statement-breakpoint
-- Claims up to p_limit due events for one lease. SKIP LOCKED lets concurrent workers claim disjoint rows.
CREATE FUNCTION spark.worker_claim_outbox(p_lock_token uuid, p_limit integer, p_lease_seconds integer)
RETURNS TABLE(id uuid, tenant_id uuid, event_type text, aggregate_type text, aggregate_id uuid, payload jsonb, attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
BEGIN
  IF p_lock_token IS NULL THEN RAISE EXCEPTION 'Invalid lock token' USING ERRCODE = '22023'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid claim limit' USING ERRCODE = '22023'; END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 10 AND 600 THEN
    RAISE EXCEPTION 'Invalid lease duration' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH due AS (
    SELECT o.id FROM spark.outbox_events o
    WHERE o.processed_at IS NULL AND o.available_at <= now() AND (o.locked_until IS NULL OR o.locked_until < now())
    ORDER BY o.available_at, o.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE spark.outbox_events o
    SET locked_until = now() + make_interval(secs => p_lease_seconds), lock_token = p_lock_token, attempts = o.attempts + 1
    FROM due WHERE o.id = due.id
    RETURNING o.id, o.tenant_id, o.event_type, o.aggregate_type, o.aggregate_id, o.payload, o.attempts, o.available_at
  )
  SELECT c.id, c.tenant_id, c.event_type, c.aggregate_type, c.aggregate_id, c.payload, c.attempts
  FROM claimed c ORDER BY c.available_at, c.id;
END $$;
--> statement-breakpoint
-- Marks a claimed event done. False when the lease was lost (expired and re-claimed, or already settled).
CREATE FUNCTION spark.worker_complete_outbox(p_id uuid, p_lock_token uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE spark.outbox_events o SET processed_at = now(), locked_until = NULL, lock_token = NULL
    WHERE o.id = p_id AND o.lock_token = p_lock_token AND o.processed_at IS NULL;
  RETURN FOUND;
END $$;
--> statement-breakpoint
-- Records a failed attempt and schedules the retry. After eight attempts the event is dead-lettered:
-- processed_at is set and last_error_code keeps the reason. Error codes are short identifiers only.
CREATE FUNCTION spark.worker_fail_outbox(p_id uuid, p_lock_token uuid, p_error_code text, p_retry_at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_error_code IS NULL OR p_error_code !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'Invalid error code' USING ERRCODE = '22023';
  END IF;
  IF p_retry_at IS NULL THEN RAISE EXCEPTION 'Invalid retry time' USING ERRCODE = '22023'; END IF;
  UPDATE spark.outbox_events o
    SET last_error_code = p_error_code, locked_until = NULL, lock_token = NULL, available_at = p_retry_at,
      processed_at = CASE WHEN o.attempts >= 8 THEN now() END
    WHERE o.id = p_id AND o.lock_token = p_lock_token AND o.processed_at IS NULL;
  RETURN FOUND;
END $$;
--> statement-breakpoint
-- What the invitation email needs, nothing more. status is 'unavailable' when the workspace is no longer
-- active and 'expired' for a pending invitation past its expiry. Zero rows for an unknown invitation.
CREATE FUNCTION spark.worker_invitation_email(p_invitation uuid)
RETURNS TABLE(status text, email text, workspace_name text, inviter_name text, role text, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN w.status <> 'active' OR w.archived_at IS NOT NULL THEN 'unavailable'
      WHEN i.status = 'pending' AND i.expires_at <= now() THEN 'expired' ELSE i.status END,
    i.email_normalized, w.name, u.display_name, i.role, i.expires_at
  FROM spark.workspace_invitations i
  JOIN spark.workspaces w ON w.id = i.tenant_id
  JOIN spark.users u ON u.id = i.invited_by_user_id
  WHERE i.id = p_invitation;
$$;
--> statement-breakpoint
-- Stores the hash of a freshly generated token, invalidating any earlier link. Only for a pending,
-- unexpired invitation of an active workspace. The raw token never reaches the database.
CREATE FUNCTION spark.worker_issue_invitation_token(p_invitation uuid, p_token_hash bytea) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE target_tenant uuid; workspace spark.workspaces%ROWTYPE; invitation spark.workspace_invitations%ROWTYPE;
BEGIN
  IF p_token_hash IS NULL OR octet_length(p_token_hash) <> 32 THEN
    RAISE EXCEPTION 'Invalid invitation token' USING ERRCODE = '22023';
  END IF;
  SELECT i.tenant_id INTO target_tenant FROM spark.workspace_invitations i WHERE i.id = p_invitation;
  IF target_tenant IS NULL THEN RETURN false; END IF;
  SELECT * INTO workspace FROM spark.workspaces w WHERE w.id = target_tenant FOR UPDATE;
  SELECT * INTO invitation FROM spark.workspace_invitations i WHERE i.id = p_invitation FOR UPDATE;
  IF workspace.id IS NULL OR workspace.status <> 'active' OR workspace.archived_at IS NOT NULL
      OR invitation.id IS NULL OR invitation.status <> 'pending' OR invitation.expires_at <= now() THEN
    RETURN false;
  END IF;
  UPDATE spark.workspace_invitations i SET token_hash = p_token_hash WHERE i.id = invitation.id;
  RETURN true;
END $$;
--> statement-breakpoint
-- Archived workspaces no longer count toward the owned-workspace cap.
CREATE OR REPLACE FUNCTION spark.ws_create_workspace(p_name text, p_slug text) RETURNS TABLE(outcome text, workspace_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); clean_name text := btrim(p_name); new_workspace uuid;
BEGIN
  IF clean_name IS NULL OR length(clean_name) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'Invalid workspace name' USING ERRCODE = '22023';
  END IF;
  IF p_slug IS NULL OR p_slug !~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$' THEN
    RAISE EXCEPTION 'Invalid workspace slug' USING ERRCODE = '22023';
  END IF;
  -- Serializes one user's creations so two parallel requests cannot pass the cap together.
  PERFORM 1 FROM spark.users u WHERE u.id = actor FOR NO KEY UPDATE;
  IF (SELECT count(*) FROM spark.workspace_memberships m JOIN spark.workspaces w ON w.id = m.tenant_id
      WHERE m.user_id = actor AND m.role = 'owner' AND m.status = 'active' AND w.status = 'active' AND w.archived_at IS NULL) >= 20 THEN
    RETURN QUERY SELECT 'too_many_workspaces'::text, NULL::uuid; RETURN;
  END IF;
  INSERT INTO spark.workspaces (slug, name, created_by_user_id) VALUES (p_slug, clean_name, actor)
    ON CONFLICT (slug) DO NOTHING RETURNING id INTO new_workspace;
  IF new_workspace IS NULL THEN
    RETURN QUERY SELECT 'slug_taken'::text, NULL::uuid; RETURN;
  END IF;
  INSERT INTO spark.workspace_memberships (tenant_id, user_id, role, status) VALUES (new_workspace, actor, 'owner', 'active');
  PERFORM spark.record_workspace_audit(new_workspace, actor, 'workspace.created', 'workspace', new_workspace,
    jsonb_build_object('slug', p_slug, 'name', clean_name));
  RETURN QUERY SELECT 'ok'::text, new_workspace;
END $$;
--> statement-breakpoint
-- The caller no longer supplies a token hash: the invitation gets an unknowable random placeholder and
-- the worker issues the real token when it sends the email. At most 100 unexpired pending invitations
-- per workspace (abuse guard).
DROP FUNCTION spark.ws_create_invitation(uuid, text, text, bytea, timestamptz);
CREATE FUNCTION spark.ws_create_invitation(p_workspace uuid, p_email text, p_role text, p_expires_at timestamptz)
RETURNS TABLE(outcome text, invitation_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); clean_email text := lower(btrim(p_email)); actor_role text; new_invitation uuid;
BEGIN
  IF clean_email IS NULL OR length(clean_email) > 254 OR clean_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'Invalid invitation email' USING ERRCODE = '22023';
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('admin','member') THEN
    RAISE EXCEPTION 'Invalid invitation role' USING ERRCODE = '22023';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now() OR p_expires_at > now() + interval '8 days' THEN
    RAISE EXCEPTION 'Invalid invitation expiry' USING ERRCODE = '22023';
  END IF;
  actor_role := spark.lock_workspace_role(p_workspace, actor);
  IF actor_role IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid; RETURN; END IF;
  IF actor_role = 'member' OR (actor_role = 'admin' AND p_role <> 'member') THEN
    RETURN QUERY SELECT 'forbidden'::text, NULL::uuid; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM spark.user_emails e JOIN spark.workspace_memberships m ON m.user_id = e.user_id
      WHERE e.normalized_email = clean_email AND m.tenant_id = p_workspace AND m.status = 'active') THEN
    RETURN QUERY SELECT 'already_member'::text, NULL::uuid; RETURN;
  END IF;
  UPDATE spark.workspace_invitations i SET status = 'expired'
    WHERE i.tenant_id = p_workspace AND i.email_normalized = clean_email AND i.status = 'pending' AND i.expires_at <= now();
  IF EXISTS (SELECT 1 FROM spark.workspace_invitations i WHERE i.tenant_id = p_workspace AND i.email_normalized = clean_email AND i.status = 'pending') THEN
    RETURN QUERY SELECT 'invitation_pending'::text, NULL::uuid; RETURN;
  END IF;
  IF (SELECT count(*) FROM spark.workspace_invitations i
      WHERE i.tenant_id = p_workspace AND i.status = 'pending' AND i.expires_at > now()) >= 100 THEN
    RETURN QUERY SELECT 'too_many_invitations'::text, NULL::uuid; RETURN;
  END IF;
  INSERT INTO spark.workspace_invitations (tenant_id, email_normalized, role, token_hash, invited_by_user_id, expires_at)
    VALUES (p_workspace, clean_email, p_role, sha256(convert_to(gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')), actor, p_expires_at)
    RETURNING id INTO new_invitation;
  INSERT INTO spark.outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload)
    VALUES (p_workspace, 'invitation.created', 'workspace_invitation', new_invitation, 1, jsonb_build_object('invitationId', new_invitation));
  PERFORM spark.record_workspace_audit(p_workspace, actor, 'invitation.created', 'invitation', new_invitation, jsonb_build_object('role', p_role));
  RETURN QUERY SELECT 'ok'::text, new_invitation;
END $$;
--> statement-breakpoint
-- An expired invitation (by status, or pending past its expiry) is revived for another 7 days unless a
-- newer invitation for the same address is already pending. Accepted and revoked stay not_pending.
CREATE OR REPLACE FUNCTION spark.ws_resend_invitation(p_invitation uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_session_actor(); target_tenant uuid; actor_role text;
  invitation spark.workspace_invitations%ROWTYPE; next_version integer;
BEGIN
  SELECT i.tenant_id INTO target_tenant FROM spark.workspace_invitations i WHERE i.id = p_invitation;
  IF target_tenant IS NULL THEN RETURN 'not_found'; END IF;
  actor_role := spark.lock_workspace_role(target_tenant, actor);
  IF actor_role IS NULL THEN RETURN 'not_found'; END IF;
  IF actor_role = 'member' THEN RETURN 'forbidden'; END IF;
  SELECT * INTO invitation FROM spark.workspace_invitations i WHERE i.id = p_invitation FOR UPDATE;
  IF actor_role = 'admin' AND invitation.role <> 'member' THEN RETURN 'forbidden'; END IF;
  IF invitation.status NOT IN ('pending','expired') THEN RETURN 'not_pending'; END IF;
  IF invitation.status = 'expired' THEN
    UPDATE spark.workspace_invitations i SET status = 'expired'
      WHERE i.tenant_id = invitation.tenant_id AND i.email_normalized = invitation.email_normalized
        AND i.status = 'pending' AND i.expires_at <= now();
    IF EXISTS (SELECT 1 FROM spark.workspace_invitations i WHERE i.tenant_id = invitation.tenant_id
        AND i.email_normalized = invitation.email_normalized AND i.status = 'pending') THEN
      RETURN 'not_pending';
    END IF;
  END IF;
  UPDATE spark.workspace_invitations i SET status = 'pending', expires_at = now() + interval '7 days' WHERE i.id = invitation.id;
  SELECT COALESCE(max(o.aggregate_version), 0) + 1 INTO next_version FROM spark.outbox_events o
    WHERE o.tenant_id = invitation.tenant_id AND o.aggregate_type = 'workspace_invitation' AND o.aggregate_id = invitation.id;
  INSERT INTO spark.outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload)
    VALUES (invitation.tenant_id, 'invitation.resent', 'workspace_invitation', invitation.id, next_version, jsonb_build_object('invitationId', invitation.id));
  PERFORM spark.record_workspace_audit(invitation.tenant_id, actor, 'invitation.resent', 'invitation', invitation.id, jsonb_build_object('role', invitation.role));
  RETURN 'ok';
END $$;
--> statement-breakpoint
-- A settled (non-pending) invitation previews its status only, without workspace or inviter details.
CREATE OR REPLACE FUNCTION spark.ws_invitation_preview(p_token_hash bytea)
RETURNS TABLE(status text, workspace_name text, inviter_name text, role text, email_hint text, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p.status,
    CASE WHEN p.status = 'pending' THEN p.workspace_name END,
    CASE WHEN p.status = 'pending' THEN p.inviter_name END,
    CASE WHEN p.status = 'pending' THEN p.role END,
    CASE WHEN p.status = 'pending' THEN p.email_hint END,
    CASE WHEN p.status = 'pending' THEN p.expires_at END
  FROM (
    SELECT CASE WHEN i.status = 'pending' AND i.expires_at <= now() THEN 'expired' ELSE i.status END AS status,
      w.name AS workspace_name, u.display_name AS inviter_name, i.role,
      left(i.email_normalized, 1) || '***@' || split_part(i.email_normalized, '@', 2) AS email_hint,
      i.expires_at
    FROM spark.workspace_invitations i
    JOIN spark.workspaces w ON w.id = i.tenant_id
    JOIN spark.users u ON u.id = i.invited_by_user_id
    WHERE i.token_hash = p_token_hash AND w.status = 'active' AND w.archived_at IS NULL
  ) p;
$$;
--> statement-breakpoint
-- The token lookup is repeated under the invitation row lock: a token the worker rotated in between is
-- invalid. The inviter is only notified while still an active member of the workspace.
CREATE OR REPLACE FUNCTION spark.ws_accept_invitation(p_token_hash bytea)
RETURNS TABLE(outcome text, workspace_id uuid, workspace_slug text, role text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); target_invitation uuid; target_tenant uuid; recipient text; accepter_name text; event_id uuid;
  invitation spark.workspace_invitations%ROWTYPE; workspace spark.workspaces%ROWTYPE; membership spark.workspace_memberships%ROWTYPE;
BEGIN
  SELECT i.id, i.tenant_id INTO target_invitation, target_tenant FROM spark.workspace_invitations i WHERE i.token_hash = p_token_hash;
  IF target_invitation IS NULL THEN
    RETURN QUERY SELECT 'invalid_invitation'::text, NULL::uuid, NULL::text, NULL::text; RETURN;
  END IF;
  SELECT * INTO workspace FROM spark.workspaces w WHERE w.id = target_tenant FOR UPDATE;
  SELECT * INTO invitation FROM spark.workspace_invitations i WHERE i.id = target_invitation FOR UPDATE;
  IF NOT FOUND OR invitation.token_hash IS DISTINCT FROM p_token_hash THEN
    RETURN QUERY SELECT 'invalid_invitation'::text, NULL::uuid, NULL::text, NULL::text; RETURN;
  END IF;
  IF workspace.status <> 'active' OR workspace.archived_at IS NOT NULL THEN
    RETURN QUERY SELECT 'invalid_invitation'::text, NULL::uuid, NULL::text, NULL::text; RETURN;
  END IF;
  SELECT * INTO membership FROM spark.workspace_memberships m WHERE m.tenant_id = target_tenant AND m.user_id = actor FOR UPDATE;
  IF invitation.status = 'accepted' THEN
    IF invitation.accepted_by_user_id = actor AND membership.status = 'active' THEN
      RETURN QUERY SELECT 'already_member'::text, workspace.id, workspace.slug, membership.role; RETURN;
    END IF;
    RETURN QUERY SELECT 'invitation_used'::text, NULL::uuid, NULL::text, NULL::text; RETURN;
  END IF;
  IF invitation.status = 'revoked' THEN
    RETURN QUERY SELECT 'invitation_revoked'::text, NULL::uuid, NULL::text, NULL::text; RETURN;
  END IF;
  IF invitation.status = 'expired' OR invitation.expires_at <= now() THEN
    RETURN QUERY SELECT 'invitation_expired'::text, NULL::uuid, NULL::text, NULL::text; RETURN;
  END IF;
  SELECT e.normalized_email INTO recipient FROM spark.user_emails e WHERE e.user_id = actor AND e.is_primary;
  IF recipient IS DISTINCT FROM invitation.email_normalized THEN
    RETURN QUERY SELECT 'recipient_mismatch'::text, NULL::uuid, NULL::text, NULL::text; RETURN;
  END IF;
  IF membership.status = 'active' THEN
    RETURN QUERY SELECT 'already_member'::text, workspace.id, workspace.slug, membership.role; RETURN;
  END IF;
  IF membership.status = 'suspended' THEN
    RETURN QUERY SELECT 'membership_suspended'::text, NULL::uuid, NULL::text, NULL::text; RETURN;
  END IF;
  IF membership.id IS NOT NULL THEN
    UPDATE spark.workspace_memberships m SET role = invitation.role, status = 'active', left_at = NULL, joined_at = now() WHERE m.id = membership.id;
  ELSE
    INSERT INTO spark.workspace_memberships (tenant_id, user_id, role, status) VALUES (target_tenant, actor, invitation.role, 'active');
  END IF;
  UPDATE spark.workspace_invitations i SET status = 'accepted', accepted_by_user_id = actor, accepted_at = now() WHERE i.id = invitation.id;
  PERFORM spark.record_workspace_audit(target_tenant, actor, 'invitation.accepted', 'invitation', invitation.id, jsonb_build_object('role', invitation.role));
  -- aggregate_version stays 1 even after resends: consumers must never order or dedupe by version alone.
  INSERT INTO spark.outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, processed_at)
    VALUES (target_tenant, 'invitation.accepted', 'workspace_invitation', invitation.id, 1, jsonb_build_object('workspaceId', target_tenant, 'userId', actor), now())
    RETURNING id INTO event_id;
  IF EXISTS (SELECT 1 FROM spark.workspace_memberships m
      WHERE m.tenant_id = target_tenant AND m.user_id = invitation.invited_by_user_id AND m.status = 'active') THEN
    SELECT u.display_name INTO accepter_name FROM spark.users u WHERE u.id = actor;
    INSERT INTO spark.notifications (tenant_id, recipient_user_id, outbox_event_id, kind, title, resource_type, resource_id)
      VALUES (target_tenant, invitation.invited_by_user_id, event_id, 'invitation_accepted',
        left(btrim(accepter_name) || ' joined ' || workspace.name, 500), 'workspace', target_tenant);
  END IF;
  RETURN QUERY SELECT 'ok'::text, workspace.id, workspace.slug, invitation.role;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION spark.worker_claim_outbox(uuid,integer,integer), spark.worker_complete_outbox(uuid,uuid),
  spark.worker_fail_outbox(uuid,uuid,text,timestamptz), spark.worker_invitation_email(uuid),
  spark.worker_issue_invitation_token(uuid,bytea), spark.ws_create_invitation(uuid,text,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION spark.worker_claim_outbox(uuid,integer,integer), spark.worker_complete_outbox(uuid,uuid),
  spark.worker_fail_outbox(uuid,uuid,text,timestamptz), spark.worker_invitation_email(uuid),
  spark.worker_issue_invitation_token(uuid,bytea) TO spark_worker;
GRANT EXECUTE ON FUNCTION spark.ws_create_invitation(uuid,text,text,timestamptz) TO spark_app;
