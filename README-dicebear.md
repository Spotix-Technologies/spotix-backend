# Self-hosted Dicebear avatars

Every Spotix portal that shows a user avatar (agent dashboard, booker's
attendee list, purchase history, etc.) generates it from **this backend**
rather than calling `https://api.dicebear.com`. Same deterministic SVGs,
same seeds-in-URL API shape, but nothing leaves Spotix's own
infrastructure and there's no dependency on a third-party service's
uptime or rate limits. 

## 1. Install the dependencies

```bash
npm install @dicebear/core @dicebear/collection
```

## 2. Register the route

`v1/dicebear.js` is a standard Fastify plugin, exactly like the existing
`v1/verify.js`. Register it the same way your other `v1/*` routes are
registered (wherever that happens in your Fastify bootstrap — it wasn't
included in this export, so wire it in alongside the others):

```js
import dicebearRoute from "./v1/dicebear.js"

fastify.register(dicebearRoute, { prefix: "/v1" })
```

That's it — no environment variables, no API keys, no external calls.

## 3. Usage

```
GET /v1/dicebear/:seed
GET /v1/dicebear/:seed?style=avataaars   (default)
GET /v1/dicebear/:seed?style=initials
GET /v1/dicebear/:seed?style=identicon
GET /v1/dicebear/:seed?size=96           (default 128)
```

The `seed` is whatever you want the avatar to be deterministically derived
from — across Spotix that's always a user's **email address**, so the same
person gets the same avatar everywhere without storing an image anywhere.
The seed is lowercased + trimmed server-side before generation, so
`Jane@Spotix.com` and `jane@spotix.com ` produce the identical avatar.

Example, straight in an `<img>` tag from any portal:

```tsx
<img
  src={`${process.env.NEXT_PUBLIC_BACKEND_URL}/v1/dicebear/${encodeURIComponent(email)}`}
  alt={name}
  className="rounded-full"
/>
```

(Plain `<img>`, not `next/image` — the backend host is dynamic across
environments, and Next's image optimizer would need every backend
deployment domain added to `remotePatterns` for no real benefit, since
Dicebear SVGs are already tiny and don't need re-encoding.)

## 4. Response

Returns raw `image/svg+xml` with a one-week immutable cache header — safe,
since the same seed + style always renders the exact same SVG.

## 5. Adding more styles

`@dicebear/collection` ships ~30 styles. This route only imports three to
keep the bundle small (`avataaars`, `initials`, `identicon`). To add
another one (e.g. `notionists`):

```js
import { avataaars, initials, identicon, notionists } from "@dicebear/collection"
const STYLES = { avataaars, initials, identicon, notionists }
```
