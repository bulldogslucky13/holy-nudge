// Security headers. public/_headers covers static files; Pages `_headers` does NOT apply to responses
// produced by Functions (/l/<token>, /manifest.webmanifest, /api/*, /oauth/*), so they set these in code.
// Keep CSP and the list below in step with public/_headers (test/headers.test.ts checks).

/**
 * No 'unsafe-inline' anywhere: the app has no inline scripts, no inline <style> and no style
 * attributes (app.js uses classes). The OAuth pages carry their one inline <style> by hash.
 */
export const CSP =
  "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; " +
  "manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CSP,
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

/** The headers above, optionally with a different CSP (the OAuth pages allow their inline style by hash). */
export function securityHeaders(csp: string = CSP): Record<string, string> {
  return { ...SECURITY_HEADERS, 'Content-Security-Policy': csp };
}

/** Set the security headers on an existing Headers object (overwrites any copies from the asset server). */
export function applySecurityHeaders(headers: Headers, csp: string = CSP): Headers {
  for (const [k, v] of Object.entries(securityHeaders(csp))) headers.set(k, v);
  return headers;
}
