// tests/setup.js
//
// Runs before every test file. Provides fake-but-present values for the
// env vars various modules read (some throw at import/call time if
// missing — e.g. v1/lib/queue/token.js's QUEUE_TOKEN_SECRET). None of
// these are real credentials; every test that would otherwise make a
// real network/Firestore/Redis call mocks that dependency directly
// instead of relying on these values doing anything.

process.env.PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "sk_test_fake_key_for_tests";
process.env.CRON_SECRET = process.env.CRON_SECRET || "test-cron-secret";
process.env.QUEUE_TOKEN_SECRET = process.env.QUEUE_TOKEN_SECRET || "test-queue-token-secret";
process.env.APP_URL = process.env.APP_URL || "https://example.test";
process.env.UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || "https://fake-redis.test";
process.env.UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "fake-redis-token";
process.env.FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "fake-project";
process.env.FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL || "fake@example.test";
process.env.FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY || "fake-key";
