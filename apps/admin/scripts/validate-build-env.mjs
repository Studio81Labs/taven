const environment = process.env.VITE_APP_ENV;
const configured = process.env.VITE_API_BASE_URL;

if (!["local", "staging", "production"].includes(environment)) {
  throw new Error("VITE_APP_ENV must be local, staging, or production");
}
if (!configured) {
  throw new Error("VITE_API_BASE_URL is required");
}

let url;
try {
  url = new URL(configured);
} catch {
  throw new Error("VITE_API_BASE_URL must be an exact HTTP(S) origin");
}
if (
  (url.protocol !== "http:" && url.protocol !== "https:") ||
  url.origin !== configured.replace(/\/$/, "")
) {
  throw new Error("VITE_API_BASE_URL must be an exact HTTP(S) origin");
}
if (environment !== "local" && url.protocol !== "https:") {
  throw new Error("Staging and production require an HTTPS API origin");
}
