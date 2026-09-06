-- OSIN initial schema — relational Postgres only.
-- No graph database: graph shape is derived on demand via recursive CTEs (Task 6).

-- One OSINT investigation/job; created by POST /investigations (Task 4).
CREATE TABLE IF NOT EXISTS investigations (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    input_type    TEXT NOT NULL CHECK (input_type IN ('username', 'name', 'phone', 'email', 'domain')),
    input_value   TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    error         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE investigations IS 'Job-tracking record for one investigation; input + lifecycle status.';

-- A resolved identity node (person / domain / organization). Graph nodes are entities.
CREATE TABLE IF NOT EXISTS entities (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    investigation_id UUID REFERENCES investigations(id) ON DELETE CASCADE,
    entity_type      TEXT NOT NULL DEFAULT 'person'
                     CHECK (entity_type IN ('person', 'domain', 'organization', 'unknown')),
    label            TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entities_investigation ON entities (investigation_id);

-- A concrete observable tied to an entity (username on a platform, email, phone, ...).
CREATE TABLE IF NOT EXISTS identifiers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id       UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    identifier_type TEXT NOT NULL
                    CHECK (identifier_type IN ('username', 'name', 'email', 'phone', 'domain')),
    value           TEXT NOT NULL,
    platform        TEXT NOT NULL DEFAULT 'canonical',
    url             TEXT,
    is_primary      BOOLEAN NOT NULL DEFAULT false,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    first_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_identifiers UNIQUE (identifier_type, value, platform)
);

CREATE INDEX IF NOT EXISTS idx_identifiers_entity ON identifiers (entity_id);
CREATE INDEX IF NOT EXISTS idx_identifiers_value ON identifiers (value);

-- Scored + explained output of the scoring engine for one candidate identity.
CREATE TABLE IF NOT EXISTS match_clusters (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    investigation_id  UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    primary_entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
    score             NUMERIC(5,2) NOT NULL CHECK (score >= 0 AND score <= 100),
    explanation       JSONB NOT NULL DEFAULT '[]'::jsonb,
    status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'finalized', 'rejected')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clusters_investigation ON match_clusters (investigation_id);

COMMENT ON COLUMN match_clusters.explanation IS
  'explanation_json: ordered [{signal_type, points, human_readable_reason}] produced by the scoring engine.';

-- Normalized collector output. Raw/normalized evidence is stored here but NEVER
-- reaches the UI without being attached to a scored match_clusters row.
CREATE TABLE IF NOT EXISTS evidence_signals (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    investigation_id     UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
    cluster_id           UUID REFERENCES match_clusters(id) ON DELETE SET NULL,
    entity_id            UUID REFERENCES entities(id) ON DELETE SET NULL,
    source_identifier_id UUID REFERENCES identifiers(id) ON DELETE SET NULL,
    signal_type          TEXT NOT NULL,
    source_platform      TEXT NOT NULL,
    collector            TEXT NOT NULL,
    raw_data             JSONB NOT NULL DEFAULT '{}'::jsonb,
    status               TEXT NOT NULL DEFAULT 'collected'
                         CHECK (status IN ('collected', 'scored', 'discarded')),
    collected_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evidence_investigation ON evidence_signals (investigation_id);
CREATE INDEX IF NOT EXISTS idx_evidence_cluster ON evidence_signals (cluster_id);

-- Historical snapshots of public profile URLs (Wayback) / GitHub history (Task 10).
CREATE TABLE IF NOT EXISTS snapshots (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id   UUID REFERENCES entities(id) ON DELETE CASCADE,
    url         TEXT NOT NULL,
    source      TEXT NOT NULL CHECK (source IN ('wayback', 'github', 'manual')),
    captured_at TIMESTAMPTZ NOT NULL,
    data        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_snapshots_entity ON snapshots (entity_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_url ON snapshots (url);

-- Append-only audit trail: every collector HTTP call, job transition, scoring run.
CREATE TABLE IF NOT EXISTS audit_log (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    investigation_id UUID REFERENCES investigations(id) ON DELETE SET NULL,
    actor            TEXT NOT NULL DEFAULT 'system',
    action           TEXT NOT NULL,
    subject          TEXT,
    status_code      INTEGER,
    details          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_investigation ON audit_log (investigation_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at);
