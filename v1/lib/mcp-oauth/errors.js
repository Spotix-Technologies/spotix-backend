// v1/lib/mcp-oauth/errors.js
//
// Shared error type for the MCP OAuth authorization server (v1/mcp-oauth.js).
// Carries a standard OAuth 2.0/2.1 `error` code (RFC 6749 §5.2/§4.1.2.1) so
// every endpoint can shape a spec-correct JSON error body without each
// route hand-rolling the mapping from "what went wrong" to "which of the
// ~8 registered error codes that is".

const VALID_CODES = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "access_denied",
  "server_error",
  "temporarily_unavailable",
  "unsupported_response_type",
  "invalid_token", // RFC 6750 (Bearer usage), not 6749 — resource-endpoint side
]);

const CODE_TO_STATUS = {
  invalid_request: 400,
  invalid_client: 401,
  invalid_grant: 400,
  unauthorized_client: 400,
  unsupported_grant_type: 400,
  invalid_scope: 400,
  access_denied: 403,
  server_error: 500,
  temporarily_unavailable: 503,
  unsupported_response_type: 400,
  invalid_token: 401,
};

export class McpOAuthError extends Error {
  /**
   * @param {string} code one of VALID_CODES — falls back to "server_error" if unrecognised
   * @param {string} description human-readable `error_description`
   * @param {number} [statusCode] overrides the default HTTP status for this code
   */
  constructor(code, description, statusCode) {
    super(description || code);
    this.name = "McpOAuthError";
    this.code = VALID_CODES.has(code) ? code : "server_error";
    this.description = description || "";
    this.statusCode = statusCode ?? CODE_TO_STATUS[this.code] ?? 400;
  }

  /** RFC 6749 §5.2-shaped error body. */
  toBody() {
    return { error: this.code, error_description: this.description };
  }
}
