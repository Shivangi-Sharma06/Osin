-- Task 6: correlation edges are derived from entities SHARING an identifier.
-- Relax uniqueness so the same observable (identifier_type, value, platform)
-- can be attached to several candidate entities — one row per entity that
-- observed it. Sharing is what creates evidence-graph edges.
ALTER TABLE identifiers DROP CONSTRAINT uq_identifiers;

ALTER TABLE identifiers
  ADD CONSTRAINT uq_identifiers UNIQUE (identifier_type, value, platform, entity_id);
