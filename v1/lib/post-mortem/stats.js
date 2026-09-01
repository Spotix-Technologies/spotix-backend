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

export function computeStats(rawAttendees) {
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
  };
}
