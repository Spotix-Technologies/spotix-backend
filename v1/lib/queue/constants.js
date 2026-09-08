// v1/lib/queue/constants.js
//
// Tunables and Redis key builders shared across the virtual queue
// modules. Kept separate so every other module imports the same
// key-naming scheme instead of re-deriving it (a mismatched key prefix
// is the classic way two modules end up silently talking to different
// data).

//  Tunables 
export const DEFAULT_BATCH_SIZE = 50;             // max concurrent checkout slots
export const DEFAULT_SESSION_TTL = 480;           // seconds a checkout slot is held (8 min)
export const JOIN_WINDOW_SECONDS = 10;            // randomize within this window to blunt bot precision
export const SWEEP_INTERVAL_MS = 3000;            // admission worker cadence
export const ADMISSION_LOG_WINDOW = 60;           // seconds of history used to measure live throughput
export const ADMISSION_LOG_RETENTION = 300;       // seconds admission-log entries are kept
export const COLD_START_ASSUMED_COMPLETION_SECS = 90; // fallback throughput assumption before real data exists
export const CONFIG_CACHE_TTL = 20;               // seconds — how stale an enable/disable toggle can be

//  Redis keys 
export const queueKey = (eventId) => `vqueue:queue:${eventId}`;
export const activeKey = (eventId) => `vqueue:active:${eventId}`;
export const logKey = (eventId) => `vqueue:log:${eventId}`;
export const configCacheKey = (eventId) => `vqueue:config:${eventId}`;
export const ACTIVE_EVENTS_KEY = "vqueue:active-events";
