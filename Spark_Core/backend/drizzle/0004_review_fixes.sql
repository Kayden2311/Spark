-- Corrections from the first independent correctness and security reviews.
-- Public discovery is intentionally deferred to a narrow projection migration.
CREATE OR REPLACE FUNCTION spark.can_read_community(target_tenant uuid, target_community uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT spark.is_community_member(target_tenant,target_community);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION spark.can_read_post(target_tenant uuid, target_post uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM spark.posts p
    WHERE p.id=target_post AND p.tenant_id=target_tenant AND p.deleted_at IS NULL
    AND spark.is_community_member(p.tenant_id,p.community_id)
    AND (p.moderation_status='visible' OR spark.is_community_member(p.tenant_id,p.community_id,ARRAY['owner','moderator']))
    AND p.visibility IN ('public','members'));
$$;
--> statement-breakpoint
ALTER TABLE spark.subscription_plans ADD CONSTRAINT subscription_plans_id_billing_kind_key UNIQUE (id,billing_kind);
ALTER TABLE spark.subscriptions ADD CONSTRAINT subscriptions_plan_billing_kind_fk FOREIGN KEY (plan_id,billing_kind) REFERENCES spark.subscription_plans(id,billing_kind) ON DELETE RESTRICT;
CREATE INDEX subscriptions_plan_billing_kind_idx ON spark.subscriptions(plan_id,billing_kind);
ALTER TABLE spark.subscriptions DROP CONSTRAINT subscriptions_provider_fields;
ALTER TABLE spark.subscriptions ADD CONSTRAINT subscriptions_provider_fields CHECK (
  (billing_kind='free' AND num_nonnulls(billing_customer_id,price_id,provider,provider_subscription_id)=0)
  OR (billing_kind='paid' AND num_nonnulls(billing_customer_id,price_id,provider,provider_subscription_id)=4)
);
--> statement-breakpoint
CREATE FUNCTION spark.check_issue_change_set() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE target_tenant uuid:=COALESCE(NEW.tenant_id,OLD.tenant_id); target_issue uuid; target_version integer;
BEGIN
  IF TG_TABLE_NAME='issues' THEN target_issue:=COALESCE(NEW.id,OLD.id); target_version:=COALESCE(NEW.version,OLD.version);
  ELSIF TG_TABLE_NAME='issue_events' THEN target_issue:=COALESCE(NEW.issue_id,OLD.issue_id); target_version:=COALESCE(NEW.to_version,OLD.to_version);
  ELSE target_issue:=COALESCE(NEW.aggregate_id,OLD.aggregate_id); target_version:=COALESCE(NEW.aggregate_version,OLD.aggregate_version); END IF;
  IF TG_TABLE_NAME='outbox_events' THEN
    IF COALESCE(NEW.aggregate_type,OLD.aggregate_type)<>'issue' THEN RETURN NULL; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM spark.issues i WHERE i.id=target_issue AND i.tenant_id=target_tenant AND i.version=target_version) THEN
    IF NOT EXISTS (SELECT 1 FROM spark.issue_events e WHERE e.issue_id=target_issue AND e.tenant_id=target_tenant AND e.to_version=target_version)
      OR NOT EXISTS (SELECT 1 FROM spark.outbox_events o WHERE o.aggregate_type='issue' AND o.aggregate_id=target_issue AND o.tenant_id=target_tenant AND o.aggregate_version=target_version) THEN
      RAISE EXCEPTION 'Issue version requires matching history and outbox records' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='issue_events' OR (TG_TABLE_NAME='outbox_events' AND COALESCE(NEW.aggregate_type,OLD.aggregate_type)='issue') THEN
    RAISE EXCEPTION 'Issue event version must match current issue version' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER issue_change_set AFTER INSERT OR UPDATE OR DELETE ON spark.issues DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION spark.check_issue_change_set();
CREATE CONSTRAINT TRIGGER issue_change_set AFTER INSERT OR UPDATE OR DELETE ON spark.issue_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION spark.check_issue_change_set();
CREATE CONSTRAINT TRIGGER issue_change_set AFTER INSERT OR UPDATE OR DELETE ON spark.outbox_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION spark.check_issue_change_set();
--> statement-breakpoint
CREATE FUNCTION spark.check_campaign_lifecycle() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE target_tenant uuid; target_campaign uuid; campaign spark.promotion_campaigns%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='promotion_campaigns' THEN target_tenant:=COALESCE(NEW.tenant_id,OLD.tenant_id); target_campaign:=COALESCE(NEW.id,OLD.id);
  ELSE target_tenant:=COALESCE(NEW.tenant_id,OLD.tenant_id); target_campaign:=COALESCE(NEW.campaign_id,OLD.campaign_id); END IF;
  SELECT * INTO campaign FROM spark.promotion_campaigns WHERE id=target_campaign AND tenant_id=target_tenant;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF campaign.review_status='approved' AND NOT EXISTS (SELECT 1 FROM spark.promotion_reviews r WHERE r.tenant_id=target_tenant AND r.campaign_id=target_campaign AND r.campaign_version=campaign.version AND r.decision='approve') THEN
    RAISE EXCEPTION 'Approved campaign requires matching review' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM spark.promotion_orders o WHERE o.tenant_id=target_tenant AND o.campaign_id=target_campaign AND o.status IN ('pending','paid')) AND campaign.review_status<>'approved' THEN
    RAISE EXCEPTION 'Checkout and payment require current campaign approval' USING ERRCODE='23514';
  END IF;
  IF campaign.delivery_status IN ('scheduled','active','completed') AND (campaign.review_status<>'approved' OR NOT EXISTS (SELECT 1 FROM spark.promotion_orders o WHERE o.tenant_id=target_tenant AND o.campaign_id=target_campaign AND o.status='paid')) THEN
    RAISE EXCEPTION 'Campaign delivery requires current approval and paid order' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM spark.promotion_orders o WHERE o.tenant_id=target_tenant AND o.campaign_id=target_campaign AND o.status='refunded') AND campaign.delivery_status<>'cancelled' THEN
    RAISE EXCEPTION 'Refunded campaign must be cancelled' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM spark.promotion_orders o WHERE o.tenant_id=target_tenant AND o.campaign_id=target_campaign AND o.status='refunded') AND
     EXISTS (SELECT 1 FROM spark.promotion_orders o WHERE o.tenant_id=target_tenant AND o.campaign_id=target_campaign AND o.status IN ('pending','paid','refund_pending')) THEN
    RAISE EXCEPTION 'Refunded campaign is terminal' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER campaign_lifecycle AFTER INSERT OR UPDATE OR DELETE ON spark.promotion_campaigns DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION spark.check_campaign_lifecycle();
CREATE CONSTRAINT TRIGGER campaign_lifecycle AFTER INSERT OR UPDATE OR DELETE ON spark.promotion_reviews DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION spark.check_campaign_lifecycle();
CREATE CONSTRAINT TRIGGER campaign_lifecycle AFTER INSERT OR UPDATE OR DELETE ON spark.promotion_orders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION spark.check_campaign_lifecycle();
--> statement-breakpoint
CREATE FUNCTION spark.validate_timezone() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=NEW.timezone) THEN RAISE EXCEPTION 'Invalid IANA timezone' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER valid_timezone BEFORE INSERT OR UPDATE OF timezone ON spark.users FOR EACH ROW EXECUTE FUNCTION spark.validate_timezone();
CREATE TRIGGER valid_timezone BEFORE INSERT OR UPDATE OF timezone ON spark.calendar_events FOR EACH ROW EXECUTE FUNCTION spark.validate_timezone();
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION spark.check_issue_change_set(),spark.check_campaign_lifecycle(),spark.validate_timezone() FROM PUBLIC,spark_app;
