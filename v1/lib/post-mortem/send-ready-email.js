// v1/lib/post-mortem/send-ready-email.js
//
// Sends the "your post mortem is ready" email once the PDF has been
// uploaded to Supabase Storage. Uses the same shared Mailjet client as
// everything under v1/mail-routes/ (see _mailjet-client.js) — called
// directly as a function rather than as its own HTTP route, since the
// caller (build.js) already runs inside this backend process.
//
// TODO(Babe): create the "Attendee Post Mortem Ready" template in Mailjet
// using v1/emails/attendee-post-mortem-ready.html as the starting point,
// then drop the real numeric Template ID in here — same pattern as
// EVENT_TRANSFER_REQUEST_TEMPLATE_ID in mail-routes/event-transfer-request.js.

import { mailjet } from "../../mail-routes/_mailjet-client.js";

const POST_MORTEM_READY_TEMPLATE_ID = 8313036;

export async function sendPostMortemReadyEmail({ email, username, eventName, downloadUrl }) {
  if (!email) return;

  if (!POST_MORTEM_READY_TEMPLATE_ID) {
    console.warn(
      "[post-mortem] MJ_POST_MORTEM_READY_TEMPLATE_ID not configured — skipping post-mortem-ready email"
    );
    return;
  }

  await mailjet.post("send", { version: "v3.1" }).request({
    Messages: [
      {
        From: { Email: "reports@spotix.com.ng", Name: "Spotix" },
        To: [{ Email: email, Name: username || email }],
        TemplateID: POST_MORTEM_READY_TEMPLATE_ID,
        TemplateLanguage: true,
        Subject: `Your Attendee Post Mortem for "${eventName}" is ready`,
        Variables: {
          year: new Date().getFullYear().toString(),
          username: username || "there",
          event_name: eventName,
          download_url: downloadUrl || "https://booker.spotix.com.ng/events",
        },
      },
    ],
  });
}
