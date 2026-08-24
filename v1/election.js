// v1/election.js
//
// Dedicated webhook handler entry point for election_form_purchase
// charge events. Imported into v1/webhook.js.
//
// The actual step-by-step crediting pipeline lives in v1/lib/election/ —
// see v1/lib/election/index.js for the full list of steps and what each
// one does. This file just re-exports processElectionCharge so
// webhook.js didn't need to change beyond adding the new branch.

export { processElectionCharge } from "./lib/election/index.js";
