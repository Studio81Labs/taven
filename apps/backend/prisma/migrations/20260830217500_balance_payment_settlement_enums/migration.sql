-- Keep enum additions isolated so later migrations can safely consume the new
-- labels regardless of PostgreSQL transaction handling.
ALTER TYPE "order_status" ADD VALUE IF NOT EXISTS 'AWAITING_BALANCE';
ALTER TYPE "order_settlement_kind" ADD VALUE IF NOT EXISTS 'BALANCE_SETTLEMENT';
ALTER TYPE "refund_reason" ADD VALUE IF NOT EXISTS 'BALANCE_SETTLEMENT';
