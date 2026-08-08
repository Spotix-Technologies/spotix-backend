// v1/voting.js
//
// Dedicated webhook handler entry point for voting_purchase charge
// events. Imported into v1/webhook.js.
//
// The actual step-by-step crediting pipeline lives in v1/lib/voting/ —
// see v1/lib/voting/index.js for the full list of steps and what each
// one does. This file just re-exports processVotingCharge so
// webhook.js didn't need to change.

export { processVotingCharge } from "./lib/voting/index.js";
