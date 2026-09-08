// v1/lib/mcp/sale-window.js
//
// Plain-JS port of spotix-user/src/utils/ticketSaleWindow.ts — resolves
// whether a given ticket TYPE is currently on sale. Used by the MCP
// pricing/order endpoints so an AI chat model never sees (or is able to
// buy) a ticket tier that's outside its sale window, same rule the
// buyer-facing dialog and create-pay-ref already enforce.

function combine(date, time) {
  if (!date) return null;
  const safeTime = time && /^\d{1,2}:\d{2}$/.test(time) ? time : "00:00";
  const d = new Date(`${date}T${safeTime}:00`);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * ticket: { saleStartDate?, saleStartTime?, saleEndDate?, saleEndTime? }
 * eventWideStop: { enabled?, stopDate? } — only a real upper bound when
 * enabled is true AND stopDate is set.
 */
export function resolveTicketSaleWindow(ticket, eventWideStop = {}) {
  const startsAt = combine(ticket.saleStartDate, ticket.saleStartTime);
  const perTicketEnd = combine(ticket.saleEndDate, ticket.saleEndTime);
  let endsAt = perTicketEnd;
  if (!endsAt && eventWideStop.enabled && eventWideStop.stopDate) {
    const fallback = new Date(eventWideStop.stopDate);
    endsAt = isNaN(fallback.getTime()) ? null : fallback;
  }
  return { startsAt, endsAt };
}

export function getTicketSaleStatus(ticket, eventWideStop = {}, now = new Date()) {
  const { startsAt, endsAt } = resolveTicketSaleWindow(ticket, eventWideStop);
  if (startsAt && now < startsAt) return { onSale: false, reason: "not-started", startsAt };
  if (endsAt && now >= endsAt) return { onSale: false, reason: "ended", endsAt };
  return { onSale: true };
}

export function describeSaleStatus(status) {
  if (status.onSale) return null;
  if (status.reason === "not-started") {
    return `On sale from ${status.startsAt.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })}`;
  }
  return "Sales ended for this ticket";
}
