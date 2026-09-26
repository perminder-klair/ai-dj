import { checkSelection, type PlayedTrack, type PlannedTrack, type Track } from "./eligibility.ts";

export interface EventTrack extends Track {
  title: string;
  artist: string;
  localPath: string;
  album?: string;
  genre?: string;
  year?: number;
  /** A listener request outside the frozen playlist; never offered to the autonomous selector. */
  requestOnly?: boolean;
}

export interface QueueEntry {
  trackId: string;
  source: "agent" | "fallback" | "operator";
  reason: string;
  protected: boolean;
  committed: boolean;
  operatorOverride?: { allowRepeats?: boolean; allowArtistSpacing?: boolean };
}

export interface EventState {
  id: string;
  status: "prepared" | "running" | "paused" | "stopped";
  plannedEndMs: number;
  sessionDurationMs?: number;
  eventBrief: string;
  steering: string[];
  speechMuted: boolean;
  pool: EventTrack[];
  fallbackOrder: string[];
  history: PlayedTrack[];
  current: { trackId: string; startedAtMs: number } | null;
  upcoming: QueueEntry[];
  warnings: string[];
}

export class SelectionError extends Error {
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super(`Track is ineligible: ${reasons.join(", ")}`);
    this.reasons = reasons;
  }
}

export const CROSSFADE_MS = 5_000;
export const REQUIRED_COVERAGE_MS = 5 * 60 * 60 * 1000;

function trackFor(state: EventState, trackId: string): EventTrack {
  const track = state.pool.find((item) => item.id === trackId);
  if (!track) throw new SelectionError(["outside-event-pool"]);
  return track;
}

function validateQueue(state: EventState, entries: readonly QueueEntry[], nowMs: number): void {
  let startMs = state.current
    ? Math.max(nowMs, state.current.startedAtMs + trackFor(state, state.current.trackId).durationMs - CROSSFADE_MS)
    : nowMs;
  const upcoming: PlannedTrack[] = [];
  for (const entry of entries) {
    const track = trackFor(state, entry.trackId);
    const common = { trackId: entry.trackId, eventPool: state.pool, history: selectionHistory(state), upcoming, expectedStartMs: startMs };
    const result = entry.source === "operator"
      ? checkSelection({ ...common, source: "operator", operatorOverride: entry.operatorOverride })
      : checkSelection({ ...common, source: entry.source });
    if (!result.eligible) throw new SelectionError(result.reasons);
    upcoming.push({ trackId: track.id, artistId: track.artistId, expectedStartMs: startMs, expectedEndMs: startMs + track.durationMs });
    startMs += track.durationMs - CROSSFADE_MS;
  }
}

function selectionHistory(state: EventState): PlayedTrack[] {
  if (!state.current) return state.history;
  const track = trackFor(state, state.current.trackId);
  return [...state.history, {
    trackId: track.id,
    artistId: track.artistId,
    startedAtMs: state.current.startedAtMs,
    endedAtMs: state.current.startedAtMs + track.durationMs,
  }];
}

export function addSelection(
  state: EventState,
  trackId: string,
  source: QueueEntry["source"],
  nowMs: number,
  reason = "",
  operatorOverride?: { allowRepeats?: boolean; allowArtistSpacing?: boolean },
): EventState {
  if (state.status === "stopped") throw new Error("Event is stopped");
  if (source !== "operator" && operatorOverride) throw new Error("Only operator selections may override eligibility");
  if (source !== "operator" && state.pool.find((track) => track.id === trackId)?.requestOnly) {
    throw new SelectionError(["outside-event-pool"]);
  }
  const upcoming = [...state.upcoming, {
    trackId, source, reason, protected: source === "operator", committed: false,
    ...(source === "operator" && operatorOverride ? { operatorOverride } : {}),
  }];
  validateQueue(state, upcoming, nowMs);
  return { ...state, upcoming };
}

/** Put an operator choice immediately after any transition already committed. */
export function forceNext(
  state: EventState,
  trackId: string,
  nowMs: number,
  operatorOverride?: QueueEntry["operatorOverride"],
): EventState {
  if (state.status === "stopped") throw new Error("Event is stopped");
  const index = state.upcoming[0]?.committed ? 1 : 0;
  const upcoming = state.upcoming.filter((entry) => entry.source !== "agent" || entry.protected || entry.committed);
  upcoming.splice(index, 0, { trackId, source: "operator", reason: "Operator chose next", protected: true, committed: false, operatorOverride });
  validateQueue(state, upcoming, nowMs);
  return { ...state, upcoming };
}

export function replaceUpcoming(
  state: EventState,
  index: number,
  trackId: string,
  nowMs: number,
  operatorOverride?: QueueEntry["operatorOverride"],
): EventState {
  if (!Number.isInteger(index) || index < 0 || index >= state.upcoming.length) throw new Error("Invalid queue index");
  if (state.upcoming[index]!.committed) throw new Error("Incoming transition is committed");
  const upcoming = state.upcoming.filter((entry, entryIndex) => entryIndex <= index || entry.source !== "agent" || entry.protected || entry.committed);
  upcoming[index] = { trackId, source: "operator", reason: "Operator replaced selection", protected: true, committed: false, operatorOverride };
  validateQueue(state, upcoming, nowMs);
  return { ...state, upcoming };
}

export function reorderUpcoming(state: EventState, order: readonly number[], nowMs: number): EventState {
  if (order.length !== state.upcoming.length || new Set(order).size !== order.length ||
      order.some((index) => !Number.isInteger(index) || index < 0 || index >= state.upcoming.length)) {
    throw new Error("Queue order must be a permutation of current indices");
  }
  if (state.upcoming[0]?.committed && order[0] !== 0) throw new Error("Incoming transition is committed");
  const upcoming = order.map((oldIndex, newIndex) => ({
    ...state.upcoming[oldIndex]!,
    protected: state.upcoming[oldIndex]!.protected || oldIndex !== newIndex,
  }));
  validateQueue(state, upcoming, nowMs);
  return { ...state, upcoming };
}

/** Steering drops only agent choices. Operator choices and a committed transition stay put. */
export function steer(state: EventState, instruction: string): EventState {
  const trimmed = instruction.trim();
  if (!trimmed) throw new Error("Steering instruction is empty");
  return {
    ...state,
    steering: [...state.steering, trimmed],
    upcoming: state.upcoming.filter((entry) => entry.source !== "agent" || entry.protected || entry.committed),
  };
}

export function commitIncoming(state: EventState): EventState {
  if (!state.upcoming.length) throw new Error("No incoming track");
  return { ...state, upcoming: state.upcoming.map((entry, index) => index === 0 ? { ...entry, committed: true } : entry) };
}

/** The mixer reports actual starts, including starts from its local fallback. */
export function recordPlaybackStart(state: EventState, trackId: string, startedAtMs: number): EventState {
  const track = trackFor(state, trackId);
  const history = state.current ? [...state.history, {
    trackId: state.current.trackId,
    artistId: trackFor(state, state.current.trackId).artistId,
    startedAtMs: state.current.startedAtMs,
    endedAtMs: startedAtMs + CROSSFADE_MS,
  }] : state.history;
  const index = state.upcoming.findIndex((entry) => entry.trackId === trackId);
  const repeated = state.history.some((entry) => entry.trackId === trackId) || state.current?.trackId === trackId;
  const warnings = repeated
    ? [...state.warnings, `Mixer repeated track ${track.title}`]
    : index < 0 && !state.fallbackOrder.includes(trackId)
      ? [...state.warnings, `Mixer played unqueued track ${track.title}`]
      : state.warnings;
  return {
    ...state,
    status: "running",
    current: { trackId, startedAtMs },
    history,
    upcoming: index < 0 ? state.upcoming : state.upcoming.filter((_, entryIndex) => entryIndex !== index),
    warnings,
  };
}

export function nextFallback(state: EventState, nowMs: number): EventState | null {
  for (const trackId of state.fallbackOrder) {
    try {
      return addSelection(state, trackId, "fallback", nowMs, "Prepared fallback");
    } catch (error) {
      if (!(error instanceof SelectionError)) throw error;
    }
  }
  return null;
}

/** The choices the agent may append after all currently planned tracks. */
export function eligibleCandidates(state: EventState, nowMs: number): EventTrack[] {
  if (state.status === "stopped" || state.status === "paused") return [];
  validateQueue(state, state.upcoming, nowMs);
  let startMs = state.current
    ? Math.max(nowMs, state.current.startedAtMs + trackFor(state, state.current.trackId).durationMs - CROSSFADE_MS)
    : nowMs;
  const upcoming: PlannedTrack[] = [];
  for (const entry of state.upcoming) {
    const track = trackFor(state, entry.trackId);
    upcoming.push({ trackId: track.id, artistId: track.artistId, expectedStartMs: startMs, expectedEndMs: startMs + track.durationMs });
    startMs += track.durationMs - CROSSFADE_MS;
  }
  if (startMs >= state.plannedEndMs) return [];
  return state.pool.filter((track) => !track.requestOnly && checkSelection({
    source: "agent", trackId: track.id, eventPool: state.pool,
    history: selectionHistory(state), upcoming, expectedStartMs: startMs,
  }).eligible);
}

/** Ordered validated queue followed by unused eligible local fallback tracks. */
export function buildSchedule(state: EventState, nowMs: number): string[] {
  if (state.status === "stopped") return [];
  validateQueue(state, state.upcoming, nowMs);
  let startMs = state.current
    ? Math.max(nowMs, state.current.startedAtMs + trackFor(state, state.current.trackId).durationMs - CROSSFADE_MS)
    : nowMs;
  const planned: PlannedTrack[] = [];
  const paths: string[] = [];
  for (const entry of state.upcoming) {
    if (startMs >= state.plannedEndMs) break;
    const track = trackFor(state, entry.trackId);
    planned.push({ trackId: track.id, artistId: track.artistId, expectedStartMs: startMs, expectedEndMs: startMs + track.durationMs });
    paths.push(track.localPath);
    startMs += track.durationMs - CROSSFADE_MS;
  }
  const remaining = new Set(state.fallbackOrder.filter((id) => !planned.some((item) => item.trackId === id)));
  while (remaining.size) {
    if (startMs >= state.plannedEndMs) break;
    const track = state.fallbackOrder.map((id) => trackFor(state, id)).find((candidate) => remaining.has(candidate.id) && checkSelection({
      source: "fallback", trackId: candidate.id, eventPool: state.pool,
      history: selectionHistory(state), upcoming: planned, expectedStartMs: startMs,
    }).eligible);
    if (!track) break;
    remaining.delete(track.id);
    planned.push({ trackId: track.id, artistId: track.artistId, expectedStartMs: startMs, expectedEndMs: startMs + track.durationMs });
    paths.push(track.localPath);
    startMs += track.durationMs - CROSSFADE_MS;
  }
  return paths;
}

/** Build a no-repeat fallback order and check five hours of playable coverage. */
export function prepareFallback(pool: readonly EventTrack[], startMs: number, requiredCoverageMs = REQUIRED_COVERAGE_MS): { order: string[]; coverageMs: number } {
  if (!pool.length) throw new Error("Event pool is empty");
  const order: string[] = [];
  const upcoming: PlannedTrack[] = [];
  let nextStartMs = startMs;
  while (order.length < pool.length) {
    const track = pool.find((candidate) => checkSelection({
      source: "fallback", trackId: candidate.id, eventPool: pool, history: [], upcoming, expectedStartMs: nextStartMs,
    }).eligible);
    if (!track) break;
    order.push(track.id);
    upcoming.push({ trackId: track.id, artistId: track.artistId, expectedStartMs: nextStartMs, expectedEndMs: nextStartMs + track.durationMs });
    nextStartMs += track.durationMs - CROSSFADE_MS;
  }
  const coverageMs = order.length ? nextStartMs - startMs + CROSSFADE_MS : 0;
  if (coverageMs < requiredCoverageMs) {
    const required = requiredCoverageMs === REQUIRED_COVERAGE_MS ? "five hours" : `${(requiredCoverageMs / 3_600_000).toFixed(2)} hours`;
    throw new Error(`Fallback covers ${(coverageMs / 3_600_000).toFixed(2)} hours; ${required} required`);
  }
  return { order, coverageMs };
}
