-- PostgreSQL enum additions must commit before later migrations use them.
ALTER TYPE "refund_status" ADD VALUE 'SUPERSEDED';
ALTER TYPE "refund_status" ADD VALUE 'SUSPENDED';
