-- Entity IDs are UUIDs. Tenant/actor IDs are opaque authenticated identity-provider subjects.
CREATE TABLE projects (
  tenant_id text NOT NULL, project_id uuid NOT NULL,
  dependency_epoch integer NOT NULL DEFAULT 0 CHECK(dependency_epoch >= 0),
  PRIMARY KEY(tenant_id,project_id)
);
CREATE TABLE aggregates (
  tenant_id text NOT NULL, aggregate_id uuid NOT NULL, project_id uuid NOT NULL,
  machine_id text NOT NULL, contract_version text NOT NULL, scope jsonb NOT NULL,
  scope_hash text NOT NULL CHECK(length(scope_hash)=64), state text NOT NULL,
  version integer NOT NULL CHECK(version >= 0), dependency_epoch integer NOT NULL CHECK(dependency_epoch >= 0),
  PRIMARY KEY(tenant_id,aggregate_id), FOREIGN KEY(tenant_id,project_id) REFERENCES projects(tenant_id,project_id)
);
CREATE TABLE idempotency_records (
  tenant_id text NOT NULL, actor_id text NOT NULL, key text NOT NULL,
  semantic_hash text NOT NULL CHECK(length(semantic_hash)=64), result jsonb NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY(tenant_id,actor_id,key)
);
CREATE TABLE transition_commits (
  id uuid PRIMARY KEY, tenant_id text NOT NULL, aggregate_id uuid NOT NULL,
  version integer NOT NULL CHECK(version > 0), transition_id text NOT NULL, actor_id text NOT NULL, at timestamptz NOT NULL,
  UNIQUE(tenant_id,aggregate_id,version), FOREIGN KEY(tenant_id,aggregate_id) REFERENCES aggregates(tenant_id,aggregate_id)
);
CREATE TABLE command_events (
  id uuid PRIMARY KEY, tenant_id text NOT NULL, aggregate_id uuid NOT NULL,
  version integer NOT NULL, sequence integer NOT NULL CHECK(sequence > 0), body jsonb NOT NULL,
  UNIQUE(tenant_id,aggregate_id,version,sequence),
  FOREIGN KEY(tenant_id,aggregate_id,version) REFERENCES transition_commits(tenant_id,aggregate_id,version)
);
CREATE TABLE audit_ledger (
  id uuid PRIMARY KEY, tenant_id text NOT NULL, aggregate_id uuid NOT NULL, version integer NOT NULL,
  body jsonb NOT NULL, previous_hash text CHECK(previous_hash IS NULL OR length(previous_hash)=64),
  entry_hash text NOT NULL CHECK(length(entry_hash)=64), created_at timestamptz NOT NULL,
  UNIQUE(tenant_id,aggregate_id,version),
  FOREIGN KEY(tenant_id,aggregate_id,version) REFERENCES transition_commits(tenant_id,aggregate_id,version)
);
CREATE TABLE command_outbox (
  id uuid PRIMARY KEY, event_id uuid NOT NULL UNIQUE REFERENCES command_events(id), body jsonb NOT NULL, created_at timestamptz NOT NULL
);
CREATE TABLE handler_receipts (
  handler text NOT NULL, event_id uuid NOT NULL REFERENCES command_events(id), received_at timestamptz NOT NULL,
  PRIMARY KEY(handler,event_id)
);
CREATE FUNCTION reject_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable record'; END $$;
CREATE TRIGGER immutable_events BEFORE UPDATE OR DELETE ON command_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER immutable_ledger BEFORE UPDATE OR DELETE ON audit_ledger FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER immutable_outbox BEFORE UPDATE OR DELETE ON command_outbox FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER immutable_commits BEFORE UPDATE OR DELETE ON transition_commits FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
CREATE TRIGGER immutable_idempotency BEFORE UPDATE OR DELETE ON idempotency_records FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
