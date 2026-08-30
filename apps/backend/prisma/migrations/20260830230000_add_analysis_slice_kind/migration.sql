-- Keep enum introduction separate from its first use. PostgreSQL does not
-- permit a new enum label to be used until the transaction that adds it has
-- committed.
ALTER TYPE "slice_kind" ADD VALUE 'ANALYSIS';
