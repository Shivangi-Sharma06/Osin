-- Task 8: cached AI reasoning summary per finalized cluster.
ALTER TABLE match_clusters
  ADD COLUMN IF NOT EXISTS ai_summary TEXT,
  ADD COLUMN IF NOT EXISTS ai_summary_model TEXT,
  ADD COLUMN IF NOT EXISTS ai_summary_at TIMESTAMPTZ;
