/**
 * v1/lib/voting/tie-breaker.js
 *
 * Pure state-machine for resolving poll ties once a poll (or a leaf
 * category, for group polls) ends with 2+ contestants sharing the top
 * vote count.
 *
 * MIRRORS spotix-user/src/app/lib/tie-breaker.ts — keep both in sync.
 * They can't share a module (separate deployments/codebases), so the
 * logic is duplicated deliberately, the same way ROYALTY_PERCENT /
 * calcServiceFee are mirrored between ./fees.js and
 * booker/app/lib/poll-config.ts.
 *
 * Config (read from voting/{pollId}, set via TieBreakerPanel)
 *   enabledTieBreaker   boolean      — feature on/off for this poll
 *   tieBreakerDuration  number|null  — hours each round stays open (required if enabled)
 *   tieBreakerRounds    number|null  — cap on rounds; null = 1 round then FPTP
 *
 * Runtime state (voting/{pollId}.tieBreakers, keyed by scope) 
 *   scopeKey = "single" for single-type polls, or the leaf category's
 *   categoryId for group polls. Each scope's state:
 *
 *     status:                  "active" | "fptp" | "resolved"
 *     round:                   1-based round counter
 *     contestantIds:           contestants competing in the CURRENT round
 *     roundStartVotes:         { [contestantId]: votes at round start } —
 *                               lets us measure round-only deltas against
 *                               the ever-incrementing cumulative vote count
 *     firstVoterContestantId:  first contestant to receive a vote in the
 *                               current round (used once status hits "fptp")
 *     startedAt / endsAt:      ISO strings. In "fptp" status, endsAt is
 *                               tieBreakerDuration hours out (same length as
 *                               a normal round) — if nobody votes before it
 *                               lapses, the window just silently renews for
 *                               the same tied contestants (see tickScope).
 *     isFinalRound:            true once no further numbered rounds remain
 *     winnerId / resolvedMethod / resolvedAt: set once status === "resolved"
 *     history:                 past rounds' tallies, most recent last (capped)
 *
 * Lifecycle 
 *   1. Poll ends. If a scope has 2+ contestants tied at the top score
 *      (and tie-breaker is enabled), round 1 opens for just those
 *      contestants, lasting tieBreakerDuration hours.
 *   2. Round expires. Votes cast strictly *during that round* (current
 *      cumulative votes minus roundStartVotes) decide it:
 *        - one contestant strictly ahead → resolved, they win.
 *        - still tied (including 0-0, nobody voted) → open the next round
 *          if any remain (round < tieBreakerRounds), else fall into
 *          first-past-the-post ("fptp": whoever gets the next eligible
 *          vote wins immediately).
 *   3. A vote lands. If it's cast for a contestant in an active/fptp
 *      round's contestantIds, the caller (voting.js) records it as that
 *      round's first voter and — if status is "fptp" — resolves the tie
 *      immediately in favour of that contestant.
 *   4. FPTP has a window too — tieBreakerDuration hours, same as a timed
 *      round. If it lapses with no vote, it silently renews (same tied
 *      contestants, fresh endsAt) rather than resolving; a vote landing
 *      right as it flips is safe because the crediting flow always ticks
 *      state forward before recording the vote, so the vote lands against
 *      whichever window is current.
 *
 * This module never touches Firestore — callers own reads/writes so the
 * same logic works from both the webhook (spotix-backend) and the public
 * poll page's read path (spotix-user).
 */

export const DEFAULT_TIE_BREAKER_ROUNDS = 1
export const DEFAULT_TIE_BREAKER_DURATION_HOURS = 24

/** Poll's scheduled end instant, from its pollEndDate/pollEndTime fields. */
export function getPollEndTime(pollData) {
  return new Date(`${pollData.pollEndDate}T${pollData.pollEndTime}`)
}

/**
 * Enumerates the tie-breaker "scopes" on a poll: one for a single-type
 * poll (the whole contestant list), or one per LEAF category for a
 * group poll (categories with contestants, not subcategories — a
 * folder category has nothing of its own to tie-break).
 */
export function getTieBreakerScopes(pollData) {
  if (pollData?.pollType === "group") {
    const scopes = []
    const walk = (cats) => {
      for (const cat of cats ?? []) {
        if (Array.isArray(cat.subcategories) && cat.subcategories.length > 0) {
          walk(cat.subcategories)
        } else {
          scopes.push({ scopeKey: cat.categoryId, contestants: cat.contestants ?? [] })
        }
      }
    }
    walk(pollData.categories ?? [])
    return scopes
  }
  return [{ scopeKey: "single", contestants: pollData?.contestants ?? [] }]
}

/** Top score, the contestant(s) sharing it, and the scope's total votes. */
export function computeStandings(contestants) {
  const list = contestants ?? []
  const totalVotes = list.reduce((s, c) => s + (c.votes ?? 0), 0)
  if (list.length === 0) return { topScore: 0, top: [], totalVotes: 0 }
  const topScore = Math.max(...list.map((c) => c.votes ?? 0))
  const top = list.filter((c) => (c.votes ?? 0) === topScore)
  return { topScore, top, totalVotes }
}

function snapshotVotes(contestants, ids) {
  const map = {}
  for (const id of ids) map[id] = contestants.find((c) => c.contestantId === id)?.votes ?? 0
  return map
}

function openRound({ scopeKey, contestantIds, contestants, round, now, durationMs, maxRounds, history }) {
  return {
    scopeKey,
    status: "active",
    round,
    contestantIds,
    roundStartVotes: snapshotVotes(contestants, contestantIds),
    firstVoterContestantId: null,
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + durationMs).toISOString(),
    isFinalRound: round >= maxRounds,
    winnerId: null,
    resolvedMethod: null,
    resolvedAt: null,
    history: history ?? [],
  }
}

function openFptp({ scopeKey, contestantIds, contestants, round, now, durationMs, history }) {
  return {
    scopeKey,
    status: "fptp",
    round,
    contestantIds,
    roundStartVotes: snapshotVotes(contestants, contestantIds),
    firstVoterContestantId: null,
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + durationMs).toISOString(),
    isFinalRound: true,
    winnerId: null,
    resolvedMethod: null,
    resolvedAt: null,
    history: history ?? [],
  }
}

/**
 * Advance a single scope's tie-breaker state by however many rounds have
 * silently expired since it was last ticked. Returns the SAME object
 * (referentially) if nothing changed, so callers can cheaply detect
 * "did anything happen" with `!==`.
 */
function tickScope(scope, existingState, pollEndTime, now, config) {
  const { scopeKey, contestants } = scope
  const pollEnded = now.getTime() >= pollEndTime.getTime()
  if (!pollEnded) return existingState ?? null
  if (!config.enabled) return existingState ?? null
  if (existingState?.status === "resolved") return existingState

  const { top, totalVotes } = computeStandings(contestants)

  // Nothing to break a tie over yet.
  if (!existingState && totalVotes === 0) return null
  if (!existingState && top.length <= 1) return null

  const durationMs = (config.durationHours ?? DEFAULT_TIE_BREAKER_DURATION_HOURS) * 60 * 60 * 1000
  const maxRounds  = config.rounds ?? DEFAULT_TIE_BREAKER_ROUNDS

  if (!existingState) {
    return openRound({
      scopeKey,
      contestantIds: top.map((c) => c.contestantId),
      contestants,
      round: 1,
      now,
      durationMs,
      maxRounds,
      history: [],
    })
  }

  // FPTP window — same length as a timed round. Still waiting inside the
  // window? Nothing to do; a vote resolves it instantly elsewhere
  // (recordTieBreakerVote), not through this tick.
  if (existingState.status === "fptp") {
    const fptpEndsAt = existingState.endsAt ? new Date(existingState.endsAt) : null
    if (!fptpEndsAt || now.getTime() < fptpEndsAt.getTime()) return existingState

    // Window lapsed with nobody voting — renew a fresh FPTP window for the
    // same tied contestants rather than resolving anything.
    const roundVotes = {}
    for (const cid of existingState.contestantIds) {
      const current = contestants.find((c) => c.contestantId === cid)?.votes ?? 0
      const started = existingState.roundStartVotes?.[cid] ?? 0
      roundVotes[cid] = current - started
    }
    const history = [
      ...(existingState.history ?? []),
      { round: existingState.round, contestantIds: existingState.contestantIds, roundVotes, endedAt: now.toISOString() },
    ].slice(-20)

    return openFptp({
      scopeKey,
      contestantIds: existingState.contestantIds,
      contestants,
      round: existingState.round + 1,
      now,
      durationMs,
      history,
    })
  }

  const endsAt = existingState.endsAt ? new Date(existingState.endsAt) : null
  if (!endsAt || now.getTime() < endsAt.getTime()) return existingState

  // Round window has expired — tally THIS round's votes only.
  const roundVotes = {}
  let roundTop = -Infinity
  for (const cid of existingState.contestantIds) {
    const current = contestants.find((c) => c.contestantId === cid)?.votes ?? 0
    const started = existingState.roundStartVotes?.[cid] ?? 0
    const delta = current - started
    roundVotes[cid] = delta
    if (delta > roundTop) roundTop = delta
  }
  const stillTied = existingState.contestantIds.filter((cid) => roundVotes[cid] === roundTop)

  const history = [
    ...(existingState.history ?? []),
    { round: existingState.round, contestantIds: existingState.contestantIds, roundVotes, endedAt: now.toISOString() },
  ].slice(-20)

  if (stillTied.length <= 1) {
    const winnerId = stillTied[0] ?? existingState.contestantIds[0]
    return {
      ...existingState,
      status: "resolved",
      winnerId,
      resolvedMethod: "tiebreaker-round",
      resolvedAt: now.toISOString(),
      history,
    }
  }

  if (existingState.round < maxRounds) {
    return openRound({
      scopeKey,
      contestantIds: stillTied,
      contestants,
      round: existingState.round + 1,
      now,
      durationMs,
      maxRounds,
      history,
    })
  }

  // Rounds exhausted, still tied — first-past-the-post decides it.
  return openFptp({
    scopeKey,
    contestantIds: stillTied,
    contestants,
    round: existingState.round + 1,
    now,
    durationMs,
    history,
  })
}

/**
 * Advances every scope on a poll to its current state as of `now`.
 * Returns the full tieBreakers map (unchanged scopes included) plus a
 * `changed` flag so the caller only writes to Firestore when necessary.
 */
export function tickTieBreakers(pollData, now = new Date()) {
  const config = {
    enabled: pollData?.enabledTieBreaker ?? false,
    durationHours: pollData?.tieBreakerDuration ?? null,
    rounds: pollData?.tieBreakerRounds ?? null,
  }
  const existing = pollData?.tieBreakers ?? {}
  if (!config.enabled) return { tieBreakers: existing, changed: false }

  const pollEndTime = getPollEndTime(pollData)
  const scopes = getTieBreakerScopes(pollData)

  const updated = { ...existing }
  let changed = false

  for (const scope of scopes) {
    const before = existing[scope.scopeKey] ?? null
    const after  = tickScope(scope, before, pollEndTime, now, config)
    if (after !== before) {
      changed = true
      if (after) updated[scope.scopeKey] = after
    }
  }

  return { tieBreakers: updated, changed }
}

/**
 * Whether a vote for `contestantId` in `scopeKey` should be accepted right
 * now. Used by spotix-user's payref route (the real gate — before money
 * changes hands) and defensively inside the webhook.
 *
 *   "open"       → normal voting window, any contestant in-scope is fine
 *   "tiebreaker" → poll ended, but a tie-breaker round is live for this
 *                  scope; only contestantIds are votable
 *   "closed"     → poll ended and there's nothing left to vote on here
 */
export function getScopeEligibility(pollData, scopeKey, now = new Date()) {
  const pollEndTime = getPollEndTime(pollData)
  if (now.getTime() < pollEndTime.getTime()) return { mode: "open" }

  const tb = pollData?.tieBreakers?.[scopeKey] ?? null
  if (tb && (tb.status === "active" || tb.status === "fptp")) {
    return {
      mode: "tiebreaker",
      contestantIds: tb.contestantIds,
      round: tb.round,
      status: tb.status,
    }
  }
  return { mode: "closed" }
}
