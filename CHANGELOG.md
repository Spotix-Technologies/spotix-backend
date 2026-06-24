# Changelog

## [Unreleased] — Webhook-driven ticket generation

### Changed

#### `v1/ticket.js`
- Extracted all ticket generation logic (Steps 1–11) into a named export `generateTickets(fastify, reference)`.
- `generateTickets` throws errors with a `.statusCode` property so callers can handle them correctly.
- Added an **idempotency guard** at the top of `generateTickets`: if `paymentData.ticketGenerated` is already `true`, it returns early with `{ alreadyGenerated: true, ... }` instead of re-running all steps — safe for both webhook retries and manual frontend calls.
- The default Fastify route export (`ticketRoute`) now delegates to `generateTickets` instead of containing its own logic, and maps thrown errors to the appropriate HTTP status codes.

#### `v1/webhook.js`
- Imported `generateTickets` from `./ticket.js`.
- After a `charge.success` event is processed and the Reference document status is updated to `"successful"`, the webhook now calls `generateTickets(fastify, reference)` directly.
- Ticket generation failure in the webhook is **non-fatal**: the payment status is already persisted, and the `/v1/ticket` HTTP route remains available as a manual retry fallback.
- `charge.failed` events continue to only update the Reference status (no ticket generation attempted).
- Paystack signature verification is unchanged.

### Why
Previously the frontend had to make a separate POST to `/v1/ticket` after payment to trigger ticket creation. This created a race condition window and meant tickets were never generated if the user closed the browser or the frontend call failed. Ticket creation now happens server-side as soon as Paystack confirms the charge.
