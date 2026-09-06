CREATE TYPE "operator_role" AS ENUM ('ADMIN', 'OPERATOR', 'VIEWER');
CREATE TYPE "operator_authentication_method" AS ENUM ('DEVELOPMENT_PASSWORD', 'GITHUB');
CREATE TYPE "operator_login_attempt_status" AS ENUM ('PENDING', 'EXCHANGING', 'COMPLETED', 'FAILED');
CREATE TYPE "security_event_type" AS ENUM (
    'LOGIN_SUCCEEDED',
    'LOGIN_FAILED',
    'LOGOUT',
    'CREDENTIAL_RESET',
    'OPERATOR_DISABLED'
);

CREATE TABLE "operator_identities" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "email" varchar(320) NOT NULL UNIQUE,
    "role" "operator_role" NOT NULL DEFAULT 'OPERATOR',
    "active" boolean NOT NULL DEFAULT true,
    "credential_version" integer NOT NULL DEFAULT 1,
    "created_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
    "updated_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "operator_identities_email_normalized_check"
        CHECK ("email" = lower("email") AND "email" = btrim("email")),
    CONSTRAINT "operator_identities_credential_version_check"
        CHECK ("credential_version" > 0)
);

CREATE TABLE "operator_development_credentials" (
    "operator_id" uuid PRIMARY KEY,
    "password_hash" text NOT NULL,
    "created_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
    "updated_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "operator_development_credentials_operator_id_fkey"
        FOREIGN KEY ("operator_id") REFERENCES "operator_identities"("id") ON DELETE RESTRICT,
    CONSTRAINT "operator_development_credentials_password_hash_check"
        CHECK (length("password_hash") BETWEEN 20 AND 2000)
);

CREATE TABLE "operator_github_identities" (
    "operator_id" uuid NOT NULL UNIQUE,
    "issuer" varchar(200) NOT NULL DEFAULT 'https://github.com',
    "github_user_id" varchar(30) NOT NULL,
    "display_login" varchar(100),
    "created_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
    "updated_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY ("issuer", "github_user_id"),
    CONSTRAINT "operator_github_identities_operator_id_fkey"
        FOREIGN KEY ("operator_id") REFERENCES "operator_identities"("id") ON DELETE RESTRICT,
    CONSTRAINT "operator_github_identities_issuer_check"
        CHECK ("issuer" = 'https://github.com'),
    CONSTRAINT "operator_github_identities_user_id_check"
        CHECK ("github_user_id" ~ '^[1-9][0-9]{0,28}$')
);

CREATE TABLE "operator_node_grants" (
    "operator_id" uuid NOT NULL,
    "node_id" uuid NOT NULL,
    "created_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY ("operator_id", "node_id"),
    CONSTRAINT "operator_node_grants_operator_id_fkey"
        FOREIGN KEY ("operator_id") REFERENCES "operator_identities"("id") ON DELETE RESTRICT,
    CONSTRAINT "operator_node_grants_node_id_fkey"
        FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT
);
CREATE INDEX "operator_node_grants_node_id_idx" ON "operator_node_grants"("node_id");

CREATE TABLE "operator_sessions" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "token_hash" char(64) NOT NULL UNIQUE,
    "csrf_hash" char(64) NOT NULL,
    "operator_id" uuid NOT NULL,
    "authentication_method" "operator_authentication_method" NOT NULL,
    "credential_version" integer NOT NULL,
    "created_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
    "last_seen_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
    "absolute_expires_at" timestamptz(3) NOT NULL,
    "revoked_at" timestamptz(3),
    CONSTRAINT "operator_sessions_operator_id_fkey"
        FOREIGN KEY ("operator_id") REFERENCES "operator_identities"("id") ON DELETE RESTRICT,
    CONSTRAINT "operator_sessions_expiry_check"
        CHECK ("absolute_expires_at" > "created_at"),
    CONSTRAINT "operator_sessions_credential_version_check"
        CHECK ("credential_version" > 0)
);
CREATE INDEX "operator_sessions_operator_expiry_idx"
    ON "operator_sessions"("operator_id", "absolute_expires_at");
CREATE INDEX "operator_sessions_expiry_id_idx"
    ON "operator_sessions"("absolute_expires_at", "id");
CREATE INDEX "operator_sessions_revoked_id_idx"
    ON "operator_sessions"("revoked_at", "id");

CREATE TABLE "operator_login_attempts" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "state_hash" char(64) NOT NULL UNIQUE,
    "browser_binding_hash" char(64) NOT NULL,
    "encrypted_pkce_verifier" text,
    "environment" varchar(20) NOT NULL,
    "github_client_id" varchar(200) NOT NULL,
    "callback_url" text NOT NULL,
    "status" "operator_login_attempt_status" NOT NULL DEFAULT 'PENDING',
    "expires_at" timestamptz(3) NOT NULL,
    "session_id" uuid,
    "created_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
    "completed_at" timestamptz(3),
    CONSTRAINT "operator_login_attempts_session_id_fkey"
        FOREIGN KEY ("session_id") REFERENCES "operator_sessions"("id") ON DELETE RESTRICT,
    CONSTRAINT "operator_login_attempts_environment_check"
        CHECK ("environment" IN ('staging', 'production')),
    CONSTRAINT "operator_login_attempts_expiry_check"
        CHECK ("expires_at" > "created_at")
);
CREATE INDEX "operator_login_attempts_expiry_id_idx"
    ON "operator_login_attempts"("expires_at", "id");

CREATE TABLE "operator_login_rate_buckets" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "subject_hash" char(64) NOT NULL,
    "client_hash" char(64) NOT NULL,
    "window_start" timestamptz(3) NOT NULL,
    "attempts" integer NOT NULL DEFAULT 0,
    "failures" integer NOT NULL DEFAULT 0,
    "created_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
    "updated_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT "operator_login_rate_buckets_counts_check"
        CHECK ("attempts" >= 0 AND "failures" >= 0 AND "failures" <= "attempts")
);
CREATE UNIQUE INDEX "operator_login_rate_buckets_subject_hash_client_hash_window_start_key"
    ON "operator_login_rate_buckets"("subject_hash", "client_hash", "window_start");
CREATE INDEX "operator_login_rate_buckets_window_id_idx"
    ON "operator_login_rate_buckets"("window_start", "id");

CREATE TABLE "security_events" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "event_type" "security_event_type" NOT NULL,
    "operator_id" uuid,
    "operator_session_id" uuid,
    "subject_hash" char(64),
    "outcome" varchar(100) NOT NULL,
    "recorded_at" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
    "expires_at" timestamptz(3) NOT NULL,
    CONSTRAINT "security_events_operator_id_fkey"
        FOREIGN KEY ("operator_id") REFERENCES "operator_identities"("id") ON DELETE RESTRICT,
    CONSTRAINT "security_events_operator_session_id_fkey"
        FOREIGN KEY ("operator_session_id") REFERENCES "operator_sessions"("id") ON DELETE RESTRICT,
    CONSTRAINT "security_events_expiry_check" CHECK ("expires_at" > "recorded_at")
);
CREATE INDEX "security_events_expiry_id_idx" ON "security_events"("expires_at", "id");
CREATE INDEX "security_events_operator_recorded_idx"
    ON "security_events"("operator_id", "recorded_at");
