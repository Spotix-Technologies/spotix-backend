/**
 * v1/mail-routes/_mailjet-client.js
 *
 * One shared Mailjet client for every route under v1/mail-routes/.
 * Previously each route in notify.js called Mailjet.apiConnect(...) itself
 * (harmless, but pointless duplication now that routes live in separate
 * files). Prefixed with `_` so it's obviously not a route module itself —
 * notify.js only imports actual route files.
 */

import dotenv from "dotenv"
import Mailjet from "node-mailjet"

dotenv.config()

export const mailjet = Mailjet.apiConnect(process.env.MJ_APIKEY_PUBLIC, process.env.MJ_APIKEY_PRIVATE)
