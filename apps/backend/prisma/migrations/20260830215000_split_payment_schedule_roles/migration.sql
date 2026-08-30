-- Add split-capture roles in a dedicated migration so later migrations can
-- safely consume the enum labels regardless of transaction handling.
ALTER TYPE "payment_role" ADD VALUE IF NOT EXISTS 'DEPOSIT';
ALTER TYPE "payment_role" ADD VALUE IF NOT EXISTS 'BALANCE';
