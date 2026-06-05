/**
 * CSRF protection via Content-Type enforcement.
 *
 * Rejects mutating requests (POST/PUT/PATCH/DELETE) that don't send
 * Content-Type: application/json. Cross-site form submissions can only
 * send application/x-www-form-urlencoded or multipart/form-data, and
 * CORS preflight blocks cross-origin fetch() with custom content types.
 *
 * Combined with SameSite=Lax cookies and CORS whitelisting, this closes
 * the remaining CSRF vectors (Lax+POST window, subdomain attacks).
 *
 * Exempt paths: Stripe webhook (raw body), file uploads (multipart).
 */
import { createMiddleware } from "hono/factory";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Paths exempt from JSON content-type check (prefix match).
// Public onboarding routes are token-authenticated (URL-bound, no cookie),
// so CSRF doesn't apply; the document upload endpoint is multipart.
const EXEMPT_PATHS = [
  "/auth/stripe-webhook",      // Stripe sends raw body with its own signature
  "/api/auth/stripe-webhook",
  "/demo/chat/transcribe",     // Multipart file upload (whisper audio)
  "/api/demo/chat/transcribe",
  "/public/onboarding",        // Token-auth, includes multipart upload
  "/api/public/onboarding",
];

function isExempt(path: string): boolean {
  return EXEMPT_PATHS.some((p) => path === p || path.startsWith(p + "/"));
}

export const requireJsonContentType = createMiddleware(async (c, next) => {
  const method = c.req.method;

  if (!MUTATING_METHODS.has(method)) {
    await next();
    return;
  }

  if (isExempt(c.req.path)) {
    await next();
    return;
  }

  const contentType = c.req.header("content-type") || "";
  if (!contentType.includes("application/json")) {
    return c.json({ error: "Content-Type must be application/json" }, 415);
  }

  await next();
});
