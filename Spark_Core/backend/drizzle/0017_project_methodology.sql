-- Project methodology foundation (M2). Adds methodology settings to projects, the Waterfall phase and
-- milestone plan, sprint commitment snapshots and the methodology period history. Runtime access stays
-- read-only: every new table is session-bound through spark.session_workspace_ids() and written only by
-- the table owner (later through spark.ws_* definer functions). projects deliberately gets no version
-- column: maintain_record would then force every update (including issue number allocation) to bump it;
-- settings_version is advanced explicitly by the project settings write function instead.
ALTER TABLE spark.projects
  ADD COLUMN methodology text NOT NULL DEFAULT 'kanban',
  ADD COLUMN start_date date,
  ADD COLUMN target_date date,
  ADD COLUMN sprint_length_days integer,
  ADD COLUMN settings_version integer NOT NULL DEFAULT 1,
  ADD COLUMN baselined_at timestamptz;
ALTER TABLE spark.projects ADD CONSTRAINT projects_methodology_allowed CHECK (methodology IN ('scrum','kanban','waterfall'));
ALTER TABLE spark.projects ADD CONSTRAINT projects_dates_order CHECK (target_date >= start_date);
ALTER TABLE spark.projects ADD CONSTRAINT projects_sprint_length_range CHECK (sprint_length_days BETWEEN 7 AND 28);
ALTER TABLE spark.projects ADD CONSTRAINT projects_sprint_length_scrum_only CHECK (methodology = 'scrum' OR sprint_length_days IS NULL);
ALTER TABLE spark.projects ADD CONSTRAINT projects_settings_version_positive CHECK (settings_version > 0);
--> statement-breakpoint
ALTER TABLE spark.sprints
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN started_at timestamptz,
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN committed_points numeric(10,2),
  ADD COLUMN committed_count integer,
  ADD COLUMN completed_points numeric(10,2),
  ADD COLUMN completed_count integer;
-- maintain_record (0002) already guards sprints; with a version column every update must now advance it by one.
ALTER TABLE spark.sprints ADD CONSTRAINT sprints_version_positive CHECK (version > 0);
ALTER TABLE spark.sprints ADD CONSTRAINT sprints_committed_points_nonnegative CHECK (committed_points >= 0);
ALTER TABLE spark.sprints ADD CONSTRAINT sprints_committed_count_nonnegative CHECK (committed_count >= 0);
ALTER TABLE spark.sprints ADD CONSTRAINT sprints_completed_points_nonnegative CHECK (completed_points >= 0);
ALTER TABLE spark.sprints ADD CONSTRAINT sprints_completed_count_nonnegative CHECK (completed_count >= 0);
--> statement-breakpoint
CREATE TABLE spark.project_phases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  name text NOT NULL,
  position integer NOT NULL,
  planned_start date NOT NULL,
  planned_end date NOT NULL,
  baseline_start date,
  baseline_end date,
  status text DEFAULT 'planned' NOT NULL,
  completed_at timestamptz,
  version integer DEFAULT 1 NOT NULL,
  CONSTRAINT project_phases_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT project_phases_tenant_id_project_id_id_key UNIQUE (tenant_id, project_id, id),
  CONSTRAINT project_phases_tenant_id_project_id_position_key UNIQUE (tenant_id, project_id, position),
  CONSTRAINT project_phases_name_length CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 60),
  CONSTRAINT project_phases_position_positive CHECK (position >= 1),
  CONSTRAINT project_phases_planned_order CHECK (planned_end >= planned_start),
  CONSTRAINT project_phases_baseline_shape CHECK ((baseline_start IS NULL AND baseline_end IS NULL)
    OR (baseline_start IS NOT NULL AND baseline_end IS NOT NULL AND baseline_end >= baseline_start)),
  CONSTRAINT project_phases_status_allowed CHECK (status IN ('planned','active','completed')),
  CONSTRAINT project_phases_version_positive CHECK (version > 0),
  CONSTRAINT project_phases_project_fk FOREIGN KEY (tenant_id, project_id) REFERENCES spark.projects (tenant_id, id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE spark.project_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  phase_id uuid,
  name text NOT NULL,
  due_date date NOT NULL,
  baseline_due_date date,
  completed_at timestamptz,
  version integer DEFAULT 1 NOT NULL,
  CONSTRAINT project_milestones_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT project_milestones_tenant_id_project_id_id_key UNIQUE (tenant_id, project_id, id),
  CONSTRAINT project_milestones_name_length CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 80),
  CONSTRAINT project_milestones_version_positive CHECK (version > 0),
  CONSTRAINT project_milestones_project_fk FOREIGN KEY (tenant_id, project_id) REFERENCES spark.projects (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT project_milestones_phase_fk FOREIGN KEY (tenant_id, project_id, phase_id) REFERENCES spark.project_phases (tenant_id, project_id, id) ON DELETE RESTRICT
);
CREATE INDEX project_milestones_phase_fk_idx ON spark.project_milestones (tenant_id, project_id, phase_id);
--> statement-breakpoint
-- Snapshot of the issues committed when a sprint starts. Append-only.
CREATE TABLE spark.sprint_commitments (
  tenant_id uuid NOT NULL,
  sprint_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  story_points numeric(8,2),
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT sprint_commitments_pkey PRIMARY KEY (tenant_id, sprint_id, issue_id),
  CONSTRAINT sprint_commitments_story_points_nonnegative CHECK (story_points >= 0),
  CONSTRAINT sprint_commitments_sprint_fk FOREIGN KEY (tenant_id, sprint_id) REFERENCES spark.sprints (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT sprint_commitments_issue_fk FOREIGN KEY (tenant_id, issue_id) REFERENCES spark.issues (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX sprint_commitments_issue_fk_idx ON spark.sprint_commitments (tenant_id, issue_id);
--> statement-breakpoint
-- Which methodology a project used when. One open period (ended_at IS NULL) per project; a period can
-- only be closed once, never edited or deleted.
CREATE TABLE spark.project_methodology_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  methodology text NOT NULL,
  started_at timestamptz DEFAULT now() NOT NULL,
  ended_at timestamptz,
  changed_by_user_id uuid NOT NULL,
  reason text NOT NULL,
  CONSTRAINT project_methodology_periods_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT project_methodology_periods_methodology_allowed CHECK (methodology IN ('scrum','kanban','waterfall')),
  CONSTRAINT project_methodology_periods_interval CHECK (ended_at > started_at),
  CONSTRAINT project_methodology_periods_reason_length CHECK (length(btrim(reason)) BETWEEN 1 AND 200),
  CONSTRAINT project_methodology_periods_project_fk FOREIGN KEY (tenant_id, project_id) REFERENCES spark.projects (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT project_methodology_periods_user_fk FOREIGN KEY (changed_by_user_id) REFERENCES spark.users (id) ON DELETE RESTRICT
);
CREATE INDEX project_methodology_periods_project_fk_idx ON spark.project_methodology_periods (tenant_id, project_id);
CREATE INDEX project_methodology_periods_user_fk_idx ON spark.project_methodology_periods (changed_by_user_id);
CREATE UNIQUE INDEX project_methodology_periods_one_open ON spark.project_methodology_periods (tenant_id, project_id) WHERE ended_at IS NULL;
--> statement-breakpoint
ALTER TABLE spark.issues ADD COLUMN started_at timestamptz, ADD COLUMN phase_id uuid;
ALTER TABLE spark.issues ADD CONSTRAINT issues_phase_fk FOREIGN KEY (tenant_id, project_id, phase_id) REFERENCES spark.project_phases (tenant_id, project_id, id) ON DELETE RESTRICT;
CREATE INDEX issues_phase_fk_idx ON spark.issues (tenant_id, project_id, phase_id);
--> statement-breakpoint
-- The 0002 maintain_record loop only covered tables that existed then.
CREATE TRIGGER maintain_record BEFORE UPDATE ON spark.project_phases FOR EACH ROW EXECUTE FUNCTION spark.maintain_record();
CREATE TRIGGER maintain_record BEFORE UPDATE ON spark.project_milestones FOR EACH ROW EXECUTE FUNCTION spark.maintain_record();
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON spark.sprint_commitments FOR EACH ROW EXECUTE FUNCTION spark.reject_history_change();
--> statement-breakpoint
CREATE FUNCTION spark.close_methodology_period_only() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL
    OR (to_jsonb(NEW) - 'ended_at') IS DISTINCT FROM (to_jsonb(OLD) - 'ended_at') THEN
    RAISE EXCEPTION 'A methodology period can only be closed once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER period_close_only BEFORE UPDATE OR DELETE ON spark.project_methodology_periods FOR EACH ROW EXECUTE FUNCTION spark.close_methodology_period_only();
REVOKE EXECUTE ON FUNCTION spark.close_methodology_period_only() FROM PUBLIC, spark_app;
--> statement-breakpoint
-- Unchanged from 0002 except started_at: stamped the first time the issue enters an in_progress status
-- and kept afterwards, also when the issue moves back.
CREATE OR REPLACE FUNCTION spark.guard_issue() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
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
  IF TG_OP='UPDATE' AND OLD.started_at IS NOT NULL THEN NEW.started_at:=OLD.started_at;
  ELSIF category='in_progress' THEN NEW.started_at:=COALESCE(NEW.started_at,statement_timestamp()); END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION spark.guard_issue() FROM PUBLIC, spark_app;
--> statement-breakpoint
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['project_phases','project_milestones','sprint_commitments','project_methodology_periods'] LOOP
    EXECUTE format('ALTER TABLE spark.%I ENABLE ROW LEVEL SECURITY', name);
    EXECUTE format('ALTER TABLE spark.%I FORCE ROW LEVEL SECURITY', name);
    EXECUTE format('CREATE POLICY owner_maintenance ON spark.%I TO spark_owner USING (true) WITH CHECK (true)', name);
    EXECUTE format('CREATE POLICY workspace_read ON spark.%I FOR SELECT TO spark_app USING (tenant_id = ANY ((SELECT spark.session_workspace_ids())::uuid[]))', name);
    EXECUTE format('REVOKE ALL ON spark.%I FROM PUBLIC', name);
    EXECUTE format('GRANT SELECT ON spark.%I TO spark_app', name);
  END LOOP;
END $$;
--> statement-breakpoint
-- Every project created before M2 is a Kanban project since its creation, changed by the workspace creator.
INSERT INTO spark.project_methodology_periods (tenant_id, project_id, methodology, started_at, changed_by_user_id, reason)
SELECT p.tenant_id, p.id, 'kanban', p.created_at, w.created_by_user_id, 'Backfilled at migration 0017'
FROM spark.projects p JOIN spark.workspaces w ON w.id = p.tenant_id;
