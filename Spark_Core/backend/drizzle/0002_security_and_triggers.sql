-- Runtime is deliberately read-only until each authenticated write use case exists.
REVOKE ALL ON SCHEMA spark FROM PUBLIC;
GRANT USAGE ON SCHEMA spark TO spark_app;
REVOKE ALL ON ALL TABLES IN SCHEMA spark FROM PUBLIC, spark_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA spark FROM PUBLIC, spark_app;
ALTER DEFAULT PRIVILEGES FOR ROLE spark_owner IN SCHEMA spark REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION spark.is_workspace_member(target uuid, allowed_roles text[] DEFAULT ARRAY['owner','admin','member']) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT target = nullif(current_setting('spark.tenant_id',true),'')::uuid
    AND EXISTS (SELECT 1 FROM spark.workspace_memberships m
      JOIN spark.users u ON u.id = m.user_id JOIN spark.workspaces w ON w.id = m.tenant_id
      WHERE m.tenant_id = target AND m.user_id = nullif(current_setting('spark.user_id',true),'')::uuid
      AND m.status = 'active' AND m.role = ANY(allowed_roles) AND u.status = 'active' AND w.status = 'active');
$$;
--> statement-breakpoint
CREATE FUNCTION spark.is_community_member(target_tenant uuid, target_community uuid, allowed_roles text[] DEFAULT ARRAY['owner','moderator','member']) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT target_tenant = nullif(current_setting('spark.tenant_id',true),'')::uuid
    AND EXISTS (SELECT 1 FROM spark.community_memberships m JOIN spark.users u ON u.id=m.user_id
      JOIN spark.workspaces w ON w.id=m.tenant_id JOIN spark.communities c ON c.id=m.community_id AND c.tenant_id=m.tenant_id
      WHERE m.tenant_id=target_tenant AND m.community_id=target_community
      AND m.user_id=nullif(current_setting('spark.user_id',true),'')::uuid
      AND m.status='active' AND m.role=ANY(allowed_roles) AND u.status='active' AND w.status='active' AND c.archived_at IS NULL);
$$;
--> statement-breakpoint
CREATE FUNCTION spark.can_read_community(target_tenant uuid, target_community uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM spark.communities c JOIN spark.workspaces w ON w.id=c.tenant_id
    WHERE c.id=target_community AND c.tenant_id=target_tenant AND c.archived_at IS NULL AND w.status='active'
    AND (c.visibility='public' OR spark.is_community_member(target_tenant,target_community)));
$$;
--> statement-breakpoint
CREATE FUNCTION spark.can_read_post(target_tenant uuid, target_post uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM spark.posts p JOIN spark.communities c ON c.id=p.community_id AND c.tenant_id=p.tenant_id
    WHERE p.id=target_post AND p.tenant_id=target_tenant AND p.deleted_at IS NULL
    AND spark.can_read_community(p.tenant_id,p.community_id)
    AND ((p.moderation_status='visible' AND ((p.visibility='public' AND c.visibility='public')
      OR (p.visibility IN ('public','members') AND spark.is_community_member(p.tenant_id,p.community_id))))
      OR spark.is_community_member(p.tenant_id,p.community_id,ARRAY['owner','moderator'])));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION spark.is_workspace_member(uuid,text[]), spark.is_community_member(uuid,uuid,text[]), spark.can_read_community(uuid,uuid), spark.can_read_post(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION spark.is_workspace_member(uuid,text[]), spark.is_community_member(uuid,uuid,text[]), spark.can_read_community(uuid,uuid), spark.can_read_post(uuid,uuid) TO spark_app;
--> statement-breakpoint
CREATE POLICY own_user_read ON spark.users FOR SELECT TO spark_app USING (id=nullif(current_setting('spark.user_id',true),'')::uuid AND status='active');
CREATE POLICY workspace_read ON spark.workspaces FOR SELECT TO spark_app USING (spark.is_workspace_member(id));
CREATE POLICY workspace_members_read ON spark.workspace_memberships FOR SELECT TO spark_app USING (spark.is_workspace_member(tenant_id));
CREATE POLICY community_read ON spark.communities FOR SELECT TO spark_app USING (spark.can_read_community(tenant_id,id));
CREATE POLICY community_members_read ON spark.community_memberships FOR SELECT TO spark_app USING (spark.is_community_member(tenant_id,community_id));
CREATE POLICY post_read ON spark.posts FOR SELECT TO spark_app USING (spark.can_read_post(tenant_id,id));
CREATE POLICY comment_read ON spark.post_comments FOR SELECT TO spark_app USING (deleted_at IS NULL AND spark.can_read_post(tenant_id,post_id) AND (moderation_status='visible' OR spark.is_community_member(tenant_id,community_id,ARRAY['owner','moderator'])));
GRANT SELECT ON spark.users,spark.workspaces,spark.workspace_memberships,spark.communities,spark.community_memberships,spark.posts,spark.post_comments TO spark_app;
--> statement-breakpoint
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['startup_profiles','teams','team_memberships','projects','boards','issue_statuses','workflow_transitions','sprints','issues','issue_labels','issue_label_links','issue_comments','issue_links','issue_events','calendar_events','event_attendees'] LOOP
    EXECUTE format('CREATE POLICY workspace_read ON spark.%I FOR SELECT TO spark_app USING (spark.is_workspace_member(tenant_id))',name);
    EXECUTE format('GRANT SELECT ON spark.%I TO spark_app',name);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION spark.maintain_record() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE old_data jsonb := to_jsonb(OLD); new_data jsonb := to_jsonb(NEW); field text;
BEGIN
  FOREACH field IN ARRAY ARRAY['id','tenant_id','project_id','community_id','created_at'] LOOP
    IF old_data ? field AND old_data->field IS DISTINCT FROM new_data->field THEN RAISE EXCEPTION 'Record identity is immutable' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF old_data ? 'version' AND (new_data->>'version')::integer <> (old_data->>'version')::integer+1 THEN
    RAISE EXCEPTION 'Version must advance by exactly one' USING ERRCODE='23514';
  END IF;
  NEW.updated_at := statement_timestamp(); RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ DECLARE name text; BEGIN
  FOR name IN SELECT table_name FROM information_schema.columns WHERE table_schema='spark' AND column_name='updated_at' LOOP
    EXECUTE format('CREATE TRIGGER maintain_record BEFORE UPDATE ON spark.%I FOR EACH ROW EXECUTE FUNCTION spark.maintain_record()',name);
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION spark.reject_history_change() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'History is append-only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON spark.issue_events FOR EACH ROW EXECUTE FUNCTION spark.reject_history_change();
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON spark.moderation_actions FOR EACH ROW EXECUTE FUNCTION spark.reject_history_change();
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON spark.audit_events FOR EACH ROW EXECUTE FUNCTION spark.reject_history_change();
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON spark.promotion_reviews FOR EACH ROW EXECUTE FUNCTION spark.reject_history_change();
--> statement-breakpoint
CREATE FUNCTION spark.check_workspace_owner() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE target uuid;
BEGIN
  IF TG_TABLE_NAME='workspaces' THEN target := COALESCE(NEW.id,OLD.id); ELSE target := COALESCE(NEW.tenant_id,OLD.tenant_id); END IF;
  PERFORM 1 FROM spark.workspaces WHERE id=target FOR UPDATE;
  IF EXISTS (SELECT 1 FROM spark.workspaces WHERE id=target AND status='active') AND NOT EXISTS
    (SELECT 1 FROM spark.workspace_memberships WHERE tenant_id=target AND role='owner' AND status='active') THEN
    RAISE EXCEPTION 'Active workspace requires an active owner' USING ERRCODE='23514';
  END IF; RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER workspace_owner AFTER INSERT OR UPDATE ON spark.workspaces DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION spark.check_workspace_owner();
CREATE CONSTRAINT TRIGGER workspace_owner AFTER INSERT OR UPDATE OR DELETE ON spark.workspace_memberships DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION spark.check_workspace_owner();
--> statement-breakpoint
CREATE FUNCTION spark.lock_membership_parent() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_TABLE_NAME='workspace_memberships' THEN PERFORM 1 FROM spark.workspaces WHERE id=COALESCE(NEW.tenant_id,OLD.tenant_id) FOR UPDATE;
  ELSE PERFORM 1 FROM spark.communities WHERE id=COALESCE(NEW.community_id,OLD.community_id) FOR UPDATE; END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER serialize_members BEFORE INSERT OR UPDATE OR DELETE ON spark.workspace_memberships FOR EACH ROW EXECUTE FUNCTION spark.lock_membership_parent();
CREATE TRIGGER serialize_members BEFORE INSERT OR UPDATE OR DELETE ON spark.community_memberships FOR EACH ROW EXECUTE FUNCTION spark.lock_membership_parent();
--> statement-breakpoint
CREATE FUNCTION spark.check_community_owner() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE target uuid;
BEGIN
  IF TG_TABLE_NAME='communities' THEN target:=COALESCE(NEW.id,OLD.id); ELSE target:=COALESCE(NEW.community_id,OLD.community_id); END IF;
  PERFORM 1 FROM spark.communities WHERE id=target FOR UPDATE;
  IF EXISTS (SELECT 1 FROM spark.communities WHERE id=target AND archived_at IS NULL) AND NOT EXISTS
    (SELECT 1 FROM spark.community_memberships WHERE community_id=target AND role='owner' AND status='active') THEN
    RAISE EXCEPTION 'Community requires an active owner' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER community_owner AFTER INSERT OR UPDATE ON spark.communities DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION spark.check_community_owner();
CREATE CONSTRAINT TRIGGER community_owner AFTER INSERT OR UPDATE OR DELETE ON spark.community_memberships DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION spark.check_community_owner();
--> statement-breakpoint
CREATE FUNCTION spark.guard_issue() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE parent_type text; category text; capacity integer; occupied bigint;
BEGIN
  IF TG_OP='UPDATE' AND NEW.version <> OLD.version + 1 THEN RAISE EXCEPTION 'Issue version must advance by exactly one' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM spark.projects WHERE id=NEW.project_id AND tenant_id=NEW.tenant_id FOR UPDATE;
  PERFORM 1 FROM spark.boards WHERE project_id=NEW.project_id AND tenant_id=NEW.tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Issue requires a project board' USING ERRCODE='23514'; END IF;
  IF NEW.parent_issue_id IS NOT NULL THEN
    SELECT type INTO parent_type FROM spark.issues WHERE id=NEW.parent_issue_id AND tenant_id=NEW.tenant_id AND project_id=NEW.project_id;
    IF parent_type IS NULL OR NOT ((NEW.type='subtask' AND parent_type IN ('story','task','bug')) OR (NEW.type IN ('story','task','bug') AND parent_type='epic')) THEN
      RAISE EXCEPTION 'Invalid issue hierarchy' USING ERRCODE='23514'; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM spark.issues c WHERE c.parent_issue_id=NEW.id AND NOT ((c.type='subtask' AND NEW.type IN ('story','task','bug')) OR (c.type IN ('story','task','bug') AND NEW.type='epic'))) THEN
    RAISE EXCEPTION 'Issue type would invalidate children' USING ERRCODE='23514'; END IF;
  SELECT s.category,s.wip_limit INTO category,capacity FROM spark.issue_statuses s WHERE s.id=NEW.status_id AND s.project_id=NEW.project_id AND s.tenant_id=NEW.tenant_id;
  IF capacity IS NOT NULL AND NEW.archived_at IS NULL THEN
    SELECT count(*) INTO occupied FROM spark.issues WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND status_id=NEW.status_id AND archived_at IS NULL AND id<>NEW.id;
    IF occupied >= capacity THEN RAISE EXCEPTION 'Status WIP limit reached' USING ERRCODE='23514'; END IF;
  END IF;
  IF category='done' THEN NEW.completed_at:=COALESCE(NEW.completed_at,statement_timestamp()); ELSE NEW.completed_at:=NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_issue BEFORE INSERT OR UPDATE ON spark.issues FOR EACH ROW EXECUTE FUNCTION spark.guard_issue();
--> statement-breakpoint
CREATE FUNCTION spark.guard_status() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM spark.projects WHERE id=NEW.project_id AND tenant_id=NEW.tenant_id FOR UPDATE;
  PERFORM 1 FROM spark.boards WHERE project_id=NEW.project_id AND tenant_id=NEW.tenant_id FOR UPDATE;
  IF TG_OP='UPDATE' AND NEW.category IS DISTINCT FROM OLD.category AND EXISTS (SELECT 1 FROM spark.issues WHERE status_id=NEW.id) THEN
    RAISE EXCEPTION 'Cannot change category of a referenced status' USING ERRCODE='23514'; END IF;
  IF NEW.wip_limit IS NOT NULL AND (SELECT count(*) FROM spark.issues WHERE status_id=NEW.id AND tenant_id=NEW.tenant_id AND archived_at IS NULL)>NEW.wip_limit THEN
    RAISE EXCEPTION 'WIP limit is below current occupancy' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_status BEFORE INSERT OR UPDATE ON spark.issue_statuses FOR EACH ROW EXECUTE FUNCTION spark.guard_status();
--> statement-breakpoint
CREATE FUNCTION spark.check_report_target() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.report_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM spark.content_reports r WHERE r.id=NEW.report_id AND r.tenant_id=NEW.tenant_id AND r.community_id=NEW.community_id AND r.post_id IS NOT DISTINCT FROM NEW.post_id AND r.comment_id IS NOT DISTINCT FROM NEW.comment_id) THEN
    RAISE EXCEPTION 'Moderation target must match report' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER report_target BEFORE INSERT ON spark.moderation_actions FOR EACH ROW EXECUTE FUNCTION spark.check_report_target();
--> statement-breakpoint
CREATE FUNCTION spark.immutable_price_terms() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (to_jsonb(OLD)-'updated_at'-'is_active') IS DISTINCT FROM (to_jsonb(NEW)-'updated_at'-'is_active') THEN
    RAISE EXCEPTION 'Create a new price or plan version for changed terms' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER immutable_terms BEFORE UPDATE ON spark.plan_prices FOR EACH ROW EXECUTE FUNCTION spark.immutable_price_terms();
CREATE TRIGGER immutable_terms BEFORE UPDATE ON spark.promotion_plans FOR EACH ROW EXECUTE FUNCTION spark.immutable_price_terms();
--> statement-breakpoint
-- No runtime grants for auth secrets, notifications, billing, advertising or workers.
-- Their command APIs and narrower adapter grants are separate reviewed migrations.
REVOKE EXECUTE ON FUNCTION spark.maintain_record(),spark.reject_history_change(),spark.check_workspace_owner(),spark.lock_membership_parent(),spark.check_community_owner(),spark.guard_issue(),spark.guard_status(),spark.check_report_target(),spark.immutable_price_terms() FROM PUBLIC,spark_app;
