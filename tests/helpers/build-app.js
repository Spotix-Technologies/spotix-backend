// tests/helpers/build-app.js
//
// Mirrors how server.js registers a route plugin (same /v1 prefix), but
// without the CORS/static/file-serving setup server.js also does — the
// route plugins don't depend on any of that.

import Fastify from "fastify";

export async function buildApp(routePlugin, opts = {}) {
  const app = Fastify({ logger: false });
  await app.register(routePlugin, { prefix: opts.prefix ?? "/v1" });
  await app.ready();
  return app;
}
