-- SQLite has no conditional ALTER TABLE syntax that is safe for both the
-- released preview 0013 schema and a fresh install's final 0013 schema. The
-- locked migration runner upgrades the preview shape transactionally before
-- recording this forward receipt.
SELECT 1;
