// v1/models/collections.js
//
// Reference-only index of the Firestore collections (and the one
// Supabase table) this backend reads/writes, grouped by the feature
// that owns them. NOT imported anywhere — see v1/models/README.md for
// why. If a name below is wrong or stale, it was gathered by scanning
// `.collection("...")` call sites across v1/lib/ during this migration,
// not from a live schema.

export const FIRESTORE_COLLECTIONS = {
  // Core platform
  users: "users",
  events: "events",
  admin: "admin",

  // Ticketing (v1/lib/ticket/, v1/lib/free-ticket/)
  tickets: "tickets",
  ticketHistory: "TicketHistory",
  attendees: "attendees",
  addons: "addons",
  discounts: "discounts",
  referrals: "referrals",
  purchases: "purchases",

  // Agents (v1/lib/ticket/agent-sale.js, spotix-agent portal)
  agents: "agents",

  // Voting / elections (v1/lib/voting/, v1/lib/election/)
  voting: "voting", // subcollections: voting/{pollId}/categories, entries
  votingHistory: "votingHistory",
  categories: "categories",
  entries: "entries",

  // Merch (v1/lib/merch/)
  merch: "Merch",
  merchOrders: "merchOrders",

  // Payouts (v1/lib/payout/, v1/lib/admin-transfer/)
  payouts: "payouts",
  payoutMethods: "payoutMethods", // subcollection: payoutMethods/{userId}/methods
  methods: "methods",

  // Reference / idempotency (v1/lib/reference-format.js)
  reference: "Reference",

  // Forecast cron (v1/controllers/cron/forecast.controller.js)
  forecasts: "forecasts",

  // Post-mortem analytics (v1/lib/post-mortem/)
  daily: "daily",
  monthly: "monthly",
  yearly: "yearly",
  usages: "usages",
  userEvents: "userEvents",
  transactions: "transactions",

  // Survey / questions feature
  questions: "questions",
  responses: "responses",

  // MCP OAuth (v1/lib/mcp-oauth/)
  mcpClients: "mcpClients",
  mcpAuthCodes: "mcpAuthCodes",
  mcpAccessTokens: "mcpAccessTokens",
  mcpRefreshTokens: "mcpRefreshTokens",
  mcpConnections: "mcpConnections",
};

// Supabase Postgres (v1/lib/supabase-admin.js) — used alongside Firestore
// for the payout ledger per the election-feature Supabase migration.
export const SUPABASE_TABLES = {
  payouts: "payouts",
};
