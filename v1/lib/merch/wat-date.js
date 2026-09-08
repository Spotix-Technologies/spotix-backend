// v1/lib/merch/wat-date.js
//
// Africa/Lagos (WAT) date parts, used to key the daily aggregation doc
// the same way ticket.js's admin-sales.js and voting's
// daily-aggregation.js do — keeps merch revenue reporting on the same
// calendar-day boundaries regardless of server timezone. Each domain
// (ticket/voting/merch) keeps its own tiny copy of this rather than
// cross-importing between lib folders.

export function getWATDateParts() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  const year = get("year");
  const month = `${year}-${get("month")}`;
  const day = `${month}-${get("day")}`;
  return { year, month, day };
}
