export const OPERATOR_CSRF_HEADER = {
  name: "x-csrf-token",
  required: false,
  description:
    "Required for unsafe operator requests. Obtain the session-bound value from GET /admin/auth/session.",
  schema: { type: "string", minLength: 20, maxLength: 256 },
};
