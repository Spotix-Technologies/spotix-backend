// v1/lib/voting/wat-date.js
//
// Africa/Lagos (WAT) date parts, used to key the daily/monthly/yearly
// aggregation docs the same way ticket.js's admin-sales.js does for
// events — keeps voting and ticket revenue reporting on the same
// calendar-day boundaries regardless of server timezone.

export function getWATDateParts() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date());
  const get   = (t) => parts.find((p) => p.type === t)?.value ?? "";
  const year  = get("year");
  const month = `${year}-${get("month")}`;
  const day   = `${month}-${get("day")}`;
  return { year, month, day };
}
