-- Workspace, membership and invitation writes. The runtime role still has no INSERT, UPDATE or DELETE
-- grant: every change goes through one of the spark.ws_* definer functions below, which derive the
-- actor from the live session, return a closed set of outcomes and record one audit row in the same
-- transaction. Non-members always get not_found; members without the role get forbidden.
-- Lock order in every function: workspace row, then invitation row, then membership row. The deferred
-- workspace_owner trigger only fires at commit, so last-owner checks are explicit here.
ALTER TABLE spark.notifications ADD CONSTRAINT notifications_kind_allowed CHECK (kind IN ('invitation_accepted'));
--> statement-breakpoint
-- A platform-suspended or soft-deleted coworker is no longer readable. The self row needs no extra
-- check: session_actor() already requires an active, undeleted user.
CREATE OR REPLACE FUNCTION spark.is_coworker(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT COALESCE(p_user = spark.session_actor(), false)
    OR EXISTS (SELECT 1 FROM spark.workspace_memberships m JOIN spark.users u ON u.id = m.user_id
      WHERE m.user_id = p_user AND m.status = 'active' AND u.status = 'active' AND u.deleted_at IS NULL
        AND m.tenant_id = ANY(spark.session_workspace_ids()));
$$;
--> statement-breakpoint
-- Internal: the actor's active role in an active workspace, read again after locking the workspace
-- row so concurrent membership changes serialize. NULL when the actor is not a member; a non-member
-- never takes the lock.
CREATE FUNCTION spark.lock_workspace_role(p_workspace uuid, p_actor uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor_role text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM spark.workspace_memberships m JOIN spark.workspaces w ON w.id = m.tenant_id
      WHERE m.tenant_id = p_workspace AND m.user_id = p_actor AND m.status = 'active' AND w.status = 'active' AND w.archived_at IS NULL) THEN
    RETURN NULL;
  END IF;
  PERFORM 1 FROM spark.workspaces w WHERE w.id = p_workspace FOR UPDATE;
  SELECT m.role INTO actor_role FROM spark.workspace_memberships m JOIN spark.workspaces w ON w.id = m.tenant_id
    WHERE m.tenant_id = p_workspace AND m.user_id = p_actor AND m.status = 'active' AND w.status = 'active' AND w.archived_at IS NULL;
  RETURN actor_role;
END $$;
--> statement-breakpoint
-- Internal: one workspace audit row. Callers have already authorized the actor.
CREATE FUNCTION spark.record_workspace_audit(p_tenant uuid, p_actor uuid, p_action text, p_resource_type text, p_resource uuid, p_metadata jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO spark.audit_events (tenant_id, actor_user_id, actor_kind, action, resource_type, resource_id, metadata)
    VALUES (p_tenant, p_actor, 'user', p_action, p_resource_type, p_resource, p_metadata);
$$;
--> statement-breakpoint
CREATE FUNCTION spark.ws_create_workspace(p_name text, p_slug text) RETURNS TABLE(outcome text, workspace_id uuid)
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
      WHERE m.user_id = actor AND m.role = 'owner' AND m.status = 'active' AND w.status = 'active') >= 20 THEN
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
CREATE FUNCTION spark.ws_update_workspace(p_workspace uuid, p_expected_version integer, p_name text) RETURNS TABLE(outcome text, version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); clean_name text := btrim(p_name); actor_role text;
  current_version integer; previous_name text;
BEGIN
  IF clean_name IS NULL OR length(clean_name) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'Invalid workspace name' USING ERRCODE = '22023';
  END IF;
  actor_role := spark.lock_workspace_role(p_workspace, actor);
  IF actor_role IS NULL THEN RETURN QUERY SELECT 'not_found'::text, NULL::integer; RETURN; END IF;
  IF actor_role NOT IN ('owner','admin') THEN RETURN QUERY SELECT 'forbidden'::text, NULL::integer; RETURN; END IF;
  SELECT w.version, w.name INTO current_version, previous_name FROM spark.workspaces w WHERE w.id = p_workspace;
  IF p_expected_version IS DISTINCT FROM current_version THEN
    RETURN QUERY SELECT 'version_mismatch'::text, current_version; RETURN;
  END IF;
  UPDATE spark.workspaces w SET name = clean_name, version = w.version + 1 WHERE w.id = p_workspace;
  PERFORM spark.record_workspace_audit(p_workspace, actor, 'workspace.renamed', 'workspace', p_workspace,
    jsonb_build_object('from', previous_name, 'to', clean_name));
  RETURN QUERY SELECT 'ok'::text, current_version + 1;
END $$;
--> statement-breakpoint
-- Active members of a workspace the caller actively belongs to; zero rows otherwise. The email column
-- is filled only for owners and admins. Explicit columns only, never users.*.
CREATE FUNCTION spark.ws_list_members(p_workspace uuid)
RETURNS TABLE(user_id uuid, display_name text, avatar_url text, email text, role text, status text, joined_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); actor_role text;
BEGIN
  SELECT m.role INTO actor_role FROM spark.workspace_memberships m JOIN spark.workspaces w ON w.id = m.tenant_id
    WHERE m.tenant_id = p_workspace AND m.user_id = actor AND m.status = 'active' AND w.status = 'active' AND w.archived_at IS NULL;
  IF actor_role IS NULL THEN RETURN; END IF;
  RETURN QUERY SELECT u.id, u.display_name, u.avatar_url,
      CASE WHEN actor_role IN ('owner','admin') THEN e.email END, m.role, m.status, m.joined_at
    FROM spark.workspace_memberships m JOIN spark.users u ON u.id = m.user_id
    LEFT JOIN spark.user_emails e ON e.user_id = u.id AND e.is_primary
    WHERE m.tenant_id = p_workspace AND m.status = 'active' AND u.status = 'active' AND u.deleted_at IS NULL
    ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.joined_at, u.id;
END $$;
--> statement-breakpoint
-- p_token_hash is an unusable random placeholder; the outbox worker issues the real token when it
-- sends the email. Neither the hash nor any token is written to the outbox payload or the audit log.
CREATE FUNCTION spark.ws_create_invitation(p_workspace uuid, p_email text, p_role text, p_token_hash bytea, p_expires_at timestamptz)
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
  INSERT INTO spark.workspace_invitations (tenant_id, email_normalized, role, token_hash, invited_by_user_id, expires_at)
    VALUES (p_workspace, clean_email, p_role, p_token_hash, actor, p_expires_at) RETURNING id INTO new_invitation;
  INSERT INTO spark.outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload)
    VALUES (p_workspace, 'invitation.created', 'workspace_invitation', new_invitation, 1, jsonb_build_object('invitationId', new_invitation));
  PERFORM spark.record_workspace_audit(p_workspace, actor, 'invitation.created', 'invitation', new_invitation, jsonb_build_object('role', p_role));
  RETURN QUERY SELECT 'ok'::text, new_invitation;
END $$;
--> statement-breakpoint
-- Owners manage every invitation; admins only invitations for the member role.
CREATE FUNCTION spark.ws_resend_invitation(p_invitation uuid) RETURNS text
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
  IF invitation.status <> 'pending' THEN RETURN 'not_pending'; END IF;
  UPDATE spark.workspace_invitations i SET expires_at = now() + interval '7 days' WHERE i.id = invitation.id;
  SELECT COALESCE(max(o.aggregate_version), 0) + 1 INTO next_version FROM spark.outbox_events o
    WHERE o.tenant_id = invitation.tenant_id AND o.aggregate_type = 'workspace_invitation' AND o.aggregate_id = invitation.id;
  INSERT INTO spark.outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload)
    VALUES (invitation.tenant_id, 'invitation.resent', 'workspace_invitation', invitation.id, next_version, jsonb_build_object('invitationId', invitation.id));
  PERFORM spark.record_workspace_audit(invitation.tenant_id, actor, 'invitation.resent', 'invitation', invitation.id, jsonb_build_object('role', invitation.role));
  RETURN 'ok';
END $$;
--> statement-breakpoint
CREATE FUNCTION spark.ws_revoke_invitation(p_invitation uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_session_actor(); target_tenant uuid; actor_role text;
  invitation spark.workspace_invitations%ROWTYPE;
BEGIN
  SELECT i.tenant_id INTO target_tenant FROM spark.workspace_invitations i WHERE i.id = p_invitation;
  IF target_tenant IS NULL THEN RETURN 'not_found'; END IF;
  actor_role := spark.lock_workspace_role(target_tenant, actor);
  IF actor_role IS NULL THEN RETURN 'not_found'; END IF;
  IF actor_role = 'member' THEN RETURN 'forbidden'; END IF;
  SELECT * INTO invitation FROM spark.workspace_invitations i WHERE i.id = p_invitation FOR UPDATE;
  IF actor_role = 'admin' AND invitation.role <> 'member' THEN RETURN 'forbidden'; END IF;
  IF invitation.status <> 'pending' THEN RETURN 'not_pending'; END IF;
  UPDATE spark.workspace_invitations i SET status = 'revoked', revoked_at = now() WHERE i.id = invitation.id;
  PERFORM spark.record_workspace_audit(invitation.tenant_id, actor, 'invitation.revoked', 'invitation', invitation.id, jsonb_build_object('role', invitation.role));
  RETURN 'ok';
END $$;
--> statement-breakpoint
-- Public preview for the accept page; needs no session. Unknown tokens and inactive workspaces give
-- zero rows. Only a masked email hint is returned.
CREATE FUNCTION spark.ws_invitation_preview(p_token_hash bytea)
RETURNS TABLE(status text, workspace_name text, inviter_name text, role text, email_hint text, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN i.status = 'pending' AND i.expires_at <= now() THEN 'expired' ELSE i.status END,
    w.name, u.display_name, i.role,
    left(i.email_normalized, 1) || '***@' || split_part(i.email_normalized, '@', 2),
    i.expires_at
  FROM spark.workspace_invitations i
  JOIN spark.workspaces w ON w.id = i.tenant_id
  JOIN spark.users u ON u.id = i.invited_by_user_id
  WHERE i.token_hash = p_token_hash AND w.status = 'active' AND w.archived_at IS NULL;
$$;
--> statement-breakpoint
-- Accepts for the signed-in account whose primary email matches the invitation. Two parallel calls
-- serialize on the workspace and invitation row locks: the second sees the accepted invitation and
-- returns already_member.
CREATE FUNCTION spark.ws_accept_invitation(p_token_hash bytea)
RETURNS TABLE(outcome text, workspace_id uuid, workspace_slug text, role text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
#variable_conflict use_column
DECLARE actor uuid := spark.require_session_actor(); target_tenant uuid; recipient text; accepter_name text; event_id uuid;
  invitation spark.workspace_invitations%ROWTYPE; workspace spark.workspaces%ROWTYPE; membership spark.workspace_memberships%ROWTYPE;
BEGIN
  SELECT i.tenant_id INTO target_tenant FROM spark.workspace_invitations i WHERE i.token_hash = p_token_hash;
  IF target_tenant IS NULL THEN
    RETURN QUERY SELECT 'invalid_invitation'::text, NULL::uuid, NULL::text, NULL::text; RETURN;
  END IF;
  SELECT * INTO workspace FROM spark.workspaces w WHERE w.id = target_tenant FOR UPDATE;
  SELECT * INTO invitation FROM spark.workspace_invitations i WHERE i.token_hash = p_token_hash FOR UPDATE;
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
  INSERT INTO spark.outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version, payload, processed_at)
    VALUES (target_tenant, 'invitation.accepted', 'workspace_invitation', invitation.id, 1, jsonb_build_object('workspaceId', target_tenant, 'userId', actor), now())
    RETURNING id INTO event_id;
  SELECT u.display_name INTO accepter_name FROM spark.users u WHERE u.id = actor;
  INSERT INTO spark.notifications (tenant_id, recipient_user_id, outbox_event_id, kind, title, resource_type, resource_id)
    VALUES (target_tenant, invitation.invited_by_user_id, event_id, 'invitation_accepted',
      left(btrim(accepter_name) || ' joined ' || workspace.name, 500), 'workspace', target_tenant);
  RETURN QUERY SELECT 'ok'::text, workspace.id, workspace.slug, invitation.role;
END $$;
--> statement-breakpoint
-- Owners change roles. The last active owner cannot be demoted.
CREATE FUNCTION spark.ws_set_member_role(p_workspace uuid, p_user uuid, p_role text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_session_actor(); actor_role text; target spark.workspace_memberships%ROWTYPE;
BEGIN
  IF p_role IS NULL OR p_role NOT IN ('owner','admin','member') THEN
    RAISE EXCEPTION 'Invalid member role' USING ERRCODE = '22023';
  END IF;
  actor_role := spark.lock_workspace_role(p_workspace, actor);
  IF actor_role IS NULL THEN RETURN 'not_found'; END IF;
  IF actor_role <> 'owner' THEN RETURN 'forbidden'; END IF;
  SELECT * INTO target FROM spark.workspace_memberships m
    WHERE m.tenant_id = p_workspace AND m.user_id = p_user AND m.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF target.role = p_role THEN RETURN 'ok'; END IF;
  IF target.role = 'owner' AND (SELECT count(*) FROM spark.workspace_memberships m
      WHERE m.tenant_id = p_workspace AND m.role = 'owner' AND m.status = 'active') <= 1 THEN
    RETURN 'last_owner';
  END IF;
  UPDATE spark.workspace_memberships m SET role = p_role WHERE m.id = target.id;
  PERFORM spark.record_workspace_audit(p_workspace, actor, 'member.role_changed', 'membership', target.id,
    jsonb_build_object('userId', target.user_id, 'from', target.role, 'to', p_role));
  RETURN 'ok';
END $$;
--> statement-breakpoint
-- Anyone may leave; owners remove anyone; admins remove members only. The last active owner can
-- neither leave nor be removed.
CREATE FUNCTION spark.ws_remove_member(p_workspace uuid, p_user uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor uuid := spark.require_session_actor(); actor_role text; target spark.workspace_memberships%ROWTYPE;
  is_self boolean := p_user IS NOT DISTINCT FROM actor;
BEGIN
  actor_role := spark.lock_workspace_role(p_workspace, actor);
  IF actor_role IS NULL THEN RETURN 'not_found'; END IF;
  IF NOT is_self AND actor_role = 'member' THEN RETURN 'forbidden'; END IF;
  SELECT * INTO target FROM spark.workspace_memberships m
    WHERE m.tenant_id = p_workspace AND m.user_id = p_user AND m.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF NOT is_self AND actor_role = 'admin' AND target.role <> 'member' THEN RETURN 'forbidden'; END IF;
  IF target.role = 'owner' AND (SELECT count(*) FROM spark.workspace_memberships m
      WHERE m.tenant_id = p_workspace AND m.role = 'owner' AND m.status = 'active') <= 1 THEN
    RETURN 'last_owner';
  END IF;
  UPDATE spark.workspace_memberships m SET status = 'left', left_at = now() WHERE m.id = target.id;
  PERFORM spark.record_workspace_audit(p_workspace, actor, CASE WHEN is_self THEN 'member.left' ELSE 'member.removed' END,
    'membership', target.id, jsonb_build_object('userId', target.user_id, 'role', target.role));
  RETURN 'ok';
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION spark.lock_workspace_role(uuid,uuid), spark.record_workspace_audit(uuid,uuid,text,text,uuid,jsonb),
  spark.ws_create_workspace(text,text), spark.ws_update_workspace(uuid,integer,text), spark.ws_list_members(uuid),
  spark.ws_create_invitation(uuid,text,text,bytea,timestamptz), spark.ws_resend_invitation(uuid), spark.ws_revoke_invitation(uuid),
  spark.ws_invitation_preview(bytea), spark.ws_accept_invitation(bytea), spark.ws_set_member_role(uuid,uuid,text),
  spark.ws_remove_member(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION spark.lock_workspace_role(uuid,uuid), spark.record_workspace_audit(uuid,uuid,text,text,uuid,jsonb) FROM spark_app;
GRANT EXECUTE ON FUNCTION spark.ws_create_workspace(text,text), spark.ws_update_workspace(uuid,integer,text), spark.ws_list_members(uuid),
  spark.ws_create_invitation(uuid,text,text,bytea,timestamptz), spark.ws_resend_invitation(uuid), spark.ws_revoke_invitation(uuid),
  spark.ws_invitation_preview(bytea), spark.ws_accept_invitation(bytea), spark.ws_set_member_role(uuid,uuid,text),
  spark.ws_remove_member(uuid,uuid) TO spark_app;
--> statement-breakpoint
-- Owners and admins read their workspaces' invitations. token_hash and accepted_by_user_id are not
-- granted, so they cannot be selected even by those readers.
GRANT SELECT (id, created_at, tenant_id, email_normalized, role, invited_by_user_id, expires_at, status, accepted_at, revoked_at)
  ON spark.workspace_invitations TO spark_app;
CREATE POLICY invitation_admin_read ON spark.workspace_invitations FOR SELECT TO spark_app
  USING (tenant_id = ANY ((SELECT spark.session_workspace_ids(ARRAY['owner','admin']))::uuid[]));
