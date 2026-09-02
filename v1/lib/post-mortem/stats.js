// v1/lib/post-mortem/stats.js
//
// Turns the raw attendee roster into everything the PDF renderer needs:
// the sorted timeline, first/last buyer, purchase + check-in buckets for
// the two charts, and the "fun facts" awards. Pure function, no I/O — kept
// separate from data.js (which does the Firestore reads) so this part is
// trivially testable with mock data.

function dayKey(d) {
  return d.toISOString().slice(0, 10);
}

/** Bucket a sorted list of Dates either by calendar day (if the activity
 *  spans more than one day) or by hour-of-day (if it's all one day —
 *  e.g. a single-day rush of ticket sales right before an event). */
function bucketByDayOrHour(dates) {
  if (dates.length === 0) return { granularity: "hour", buckets: [] };

  const uniqueDays = new Set(dates.map(dayKey));

  if (uniqueDays.size <= 1) {
    const counts = new Array(24).fill(0);
    dates.forEach((d) => counts[d.getHours()]++);
    return {
      granularity: "hour",
      buckets: counts.map((value, h) => ({ label: `${String(h).padStart(2, "0")}:00`, value })),
    };
  }

  const map = new Map();
  dates.forEach((d) => {
    const k = dayKey(d);
    map.set(k, (map.get(k) || 0) + 1);
  });
  const sortedKeys = [...map.keys()].sort();
  return {
    granularity: "day",
    buckets: sortedKeys.map((k) => ({
      label: new Date(`${k}T00:00:00`).toLocaleDateString("en-NG", { month: "short", day: "numeric" }),
      value: map.get(k),
    })),
  };
}

export function computeStats(rawAttendees, referrals = []) {
  const withPurchase = rawAttendees.filter((a) => a.purchaseDate instanceof Date);
  const withoutPurchase = rawAttendees.filter((a) => !(a.purchaseDate instanceof Date));

  const timeline = [...withPurchase].sort((a, b) => a.purchaseDate - b.purchaseDate);
  const fullTimelineForTable = [...timeline, ...withoutPurchase];

  const firstBuyer = timeline[0] || null;
  const lastBuyer = timeline.length > 0 ? timeline[timeline.length - 1] : null;

  const purchaseBucketResult = bucketByDayOrHour(timeline.map((a) => a.purchaseDate));

  // ── Check-ins ──
  const checkedIn = rawAttendees.filter((a) => a.verified && a.checkedInAt instanceof Date);
  const hasCheckins = checkedIn.length > 0;
  const checkinTimeline = [...checkedIn].sort((a, b) => a.checkedInAt - b.checkedInAt);
  const earlyBird = checkinTimeline[0] || null;
  const crasher = checkinTimeline.length > 0 ? checkinTimeline[checkinTimeline.length - 1] : null;
  const checkinBucketResult = bucketByDayOrHour(checkinTimeline.map((a) => a.checkedInAt));

  // ── Hoarder: email with the most ticket purchases (needs >1 to be fun) ──
  const byEmail = new Map();
  rawAttendees.forEach((a) => {
    if (!a.email) return;
    const entry = byEmail.get(a.email) || { count: 0, rep: a };
    entry.count += 1;
    byEmail.set(a.email, entry);
  });
  let hoarder = null;
  for (const [email, entry] of byEmail) {
    if (entry.count > 1 && (!hoarder || entry.count > hoarder.count)) {
      hoarder = { email, count: entry.count, fullName: entry.rep.fullName };
    }
  }

  // ── Night Owl: latest time-of-day purchase (closest to midnight) ──
  let nightOwl = null;
  let nightOwlMinutes = -1;
  timeline.forEach((a) => {
    const minutes = a.purchaseDate.getHours() * 60 + a.purchaseDate.getMinutes();
    if (minutes > nightOwlMinutes) {
      nightOwlMinutes = minutes;
      nightOwl = a;
    }
  });

  // ── Referrals & discounts ──
  const withDiscount = rawAttendees.filter((a) => a.discountApplied && a.discountCode);
  const withReferral = rawAttendees.filter((a) => !!a.referralCode);
  const organic = rawAttendees.filter((a) => !(a.discountApplied && a.discountCode) && !a.referralCode);

  const discountCodeCounts = new Map();
  withDiscount.forEach((a) => {
    discountCodeCounts.set(a.discountCode, (discountCodeCounts.get(a.discountCode) || 0) + 1);
  });

  const total = rawAttendees.length || 1; // guard div-by-zero for percentages
  const acquisition = {
    discountCount: withDiscount.length,
    discountPct: Math.round((withDiscount.length / total) * 100),
    referralCount: withReferral.length,
    referralPct: Math.round((withReferral.length / total) * 100),
    organicCount: organic.length,
    organicPct: Math.round((organic.length / total) * 100),
    topDiscountCodes: [...discountCodeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => ({ code, count })),
    // Sourced from events/{eventId}/referrals/{code}.totalTickets (see
    // data.js#fetchReferralsForPostMortem) — NOT a tally of attendee docs.
    // A referral doc's totalTickets is the correct per-code usage count;
    // deriving it from attendees would double-handle nothing here, but
    // keeping one source of truth avoids drift if a code is ever renamed
    // or a ticket transferred.
    topReferrers: referrals.map((r) => ({ label: r.code, count: r.totalTickets })),
  };

  // ── Revenue: sum of each ticket's own price (see data.js#ticketPriceOf
  // for why this must be ticketPrice, not totalAmount). This is the
  // number the organizer cares about — what their event generated from
  // ticket sales. Spotix's transaction fee is Spotix's own business and
  // is deliberately not surfaced here. ──
  const withTicketPrice = rawAttendees.filter((a) => typeof a.ticketPrice === "number");
  const totalRevenue = withTicketPrice.reduce((sum, a) => sum + a.ticketPrice, 0);

  return {
    totalAttendees: rawAttendees.length,
    checkedInCount: checkedIn.length,
    notCheckedInCount: rawAttendees.length - checkedIn.length,

    firstBuyer,
    lastBuyer,
    timeline,
    fullTimelineForTable,

    purchaseBuckets: purchaseBucketResult.buckets,
    purchaseBucketGranularity: purchaseBucketResult.granularity,

    hasCheckins,
    checkinTimeline,
    earlyBird,
    crasher,
    checkinBuckets: checkinBucketResult.buckets,
    checkinBucketGranularity: checkinBucketResult.granularity,

    hoarder,
    nightOwl,

    acquisition,
    revenue: {
      totalRevenue,
    },
  };
}

/** Aggregates raw survey responses against the organizer's question set
 *  for the PDF's survey section. Pure function — no I/O.
 *
 *  - radio: single-choice — tally counts per option for a pie chart, plus
 *    a text key ("Item A: 62%, Item B: 38%").
 *  - checkbox: multi-choice — respondents can pick more than one option,
 *    so percentages are of respondents (not of total picks) and can sum
 *    past 100%; represented as a horizontal bar per option, matching the
 *    existing bar-chart treatment used elsewhere in this PDF.
 *  - anything else (short/long/number/phone/date/time/datetime): no
 *    meaningful aggregation — every individual answer is listed verbatim
 *    against the attendee who gave it. */
export function computeSurveyStats(questions, responses) {
  if (!Array.isArray(questions) || questions.length === 0) return [];

  return questions.map((q) => {
    const answered = responses.filter((r) => {
      const v = r.responses?.[q.id];
      return v !== undefined && v !== null && v !== "";
    });

    if (q.questionType === "radio") {
      const counts = new Map(q.options.map((o) => [o, 0]));
      let otherCount = 0;
      answered.forEach((r) => {
        const v = r.responses[q.id];
        if (counts.has(v)) counts.set(v, counts.get(v) + 1);
        else otherCount += 1;
      });
      if (otherCount > 0) counts.set("Other", otherCount);
      const totalAnswered = answered.length || 1;
      const segments = [...counts.entries()].map(([label, count]) => ({
        label,
        count,
        pct: Math.round((count / totalAnswered) * 100),
      }));
      return { ...q, kind: "single-choice", segments, answeredCount: answered.length };
    }

    if (q.questionType === "checkbox") {
      const counts = new Map(q.options.map((o) => [o, 0]));
      let otherCount = 0;
      answered.forEach((r) => {
        const v = r.responses[q.id];
        const picks = Array.isArray(v) ? v : [v];
        picks.forEach((p) => {
          if (counts.has(p)) counts.set(p, counts.get(p) + 1);
          else otherCount += 1;
        });
      });
      if (otherCount > 0) counts.set("Other", otherCount);
      const totalAnswered = answered.length || 1;
      const segments = [...counts.entries()].map(([label, count]) => ({
        label,
        count,
        pct: Math.round((count / totalAnswered) * 100),
      }));
      return { ...q, kind: "multi-choice", segments, answeredCount: answered.length };
    }

    // free text (short/long/number/phone/date/time/datetime)
    const entries = answered.map((r) => ({
      fullName: r.attendeeInfo.fullName,
      email: r.attendeeInfo.email,
      answer: Array.isArray(r.responses[q.id]) ? r.responses[q.id].join(", ") : String(r.responses[q.id]),
    }));
    return { ...q, kind: "text", entries, answeredCount: answered.length };
  });
}
