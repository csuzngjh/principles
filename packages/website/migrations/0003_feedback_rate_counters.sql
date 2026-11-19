-- Feedback relay abuse counters (code-scan rate-limit-bypass remediation).
-- Atomic per-key counters for POST /api/feedback, replacing the non-atomic
-- KV get→put counter. Incremented with a single
-- INSERT ... ON CONFLICT DO UPDATE ... RETURNING statement, so concurrent
-- requests can never observe the same count.
-- Keys (window is part of the key, so a new window starts at count 1):
--   ip:<sha256(domain-separated source IP)>:<hourBucket>  per-IP hourly limit
--   issue-create:<YYYY-MM-DD>                             global daily cap
-- Raw IPs are never stored. Rows are swept once expires_at passes.
CREATE TABLE IF NOT EXISTS feedback_rate_counters (
  counter_key TEXT NOT NULL PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_rate_counters_expires_at
  ON feedback_rate_counters (expires_at);
