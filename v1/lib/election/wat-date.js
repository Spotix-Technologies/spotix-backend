// v1/lib/election/wat-date.js
//
// Africa/Lagos (WAT) date parts, same helper as
// v1/lib/voting/wat-date.js — duplicated rather than imported
// cross-domain on purpose, matching how ticket/voting/election each own
// their own copy of small domain-local helpers in this codebase.

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
