import { addSelection, eligibleCandidates, type EventState, type EventTrack } from "./event.ts";

export interface SelectionChoice { trackId: string; reason: string }

function selectionFingerprint(state: EventState): string {
  return JSON.stringify({
    status: state.status, current: state.current, upcoming: state.upcoming,
    historyLength: state.history.length, steering: state.steering, plannedEndMs: state.plannedEndMs,
  });
}

/** Discard a result if playback or operator direction changed during the model call. */
export function applySelectionIfCurrent(
  snapshot: EventState, current: EventState, choice: SelectionChoice, nowMs: number,
): EventState | null {
  if (selectionFingerprint(snapshot) !== selectionFingerprint(current) ||
      current.upcoming.length >= 2 || nowMs >= current.plannedEndMs) return null;
  return addSelection(current, choice.trackId, "agent", nowMs, choice.reason);
}

export interface SelectorConfig {
  apiKey: string;
  model?: string;
  endpoint?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

interface FunctionCall extends Record<string, unknown> {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
}

interface ModelResponse {
  status: string;
  output: Array<Record<string, unknown>>;
}

const tools = [
  {
    type: "function", name: "search_pool", strict: true,
    description: "Search eligible tracks in the frozen event pool by artist, title, album, or genre. An empty query browses the pool.",
    parameters: { type: "object", properties: {
      query: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" },
    }, required: ["query", "offset", "limit"], additionalProperties: false },
  },
  {
    type: "function", name: "inspect_tracks", strict: true,
    description: "Inspect up to eight track IDs from the frozen event pool, including any available metadata.",
    parameters: { type: "object", properties: {
      trackIds: { type: "array", items: { type: "string" } },
    }, required: ["trackIds"], additionalProperties: false },
  },
  {
    type: "function", name: "read_history", strict: true,
    description: "Read recent actual playback, the current track, and the planned queue.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    type: "function", name: "submit_selection", strict: true,
    description: "Submit exactly one approved track ID and a short reason for the operator.",
    parameters: { type: "object", properties: {
      trackId: { type: "string" }, reason: { type: "string" },
    }, required: ["trackId", "reason"], additionalProperties: false },
  },
] as const;

function metadata(track: EventTrack): Record<string, unknown> {
  return {
    id: track.id, artist: track.artist, title: track.title,
    durationMs: track.durationMs,
    ...(track.album ? { album: track.album } : {}),
    ...(track.genre ? { genre: track.genre } : {}),
    ...(track.year !== undefined ? { year: track.year } : {}),
  };
}

function stringArg(args: Record<string, unknown>, key: string): string {
  if (typeof args[key] !== "string") throw new Error(`Invalid ${key} in model tool call`);
  return args[key];
}

function executeTool(call: FunctionCall, state: EventState, nowMs: number): { output?: unknown; choice?: SelectionChoice } {
  const parsed = JSON.parse(call.arguments) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid model tool arguments");
  const args = parsed as Record<string, unknown>;
  if (call.name === "search_pool") {
    const query = stringArg(args, "query").trim().toLowerCase();
    const offset = Number.isInteger(args.offset) ? Math.max(0, args.offset as number) : 0;
    const limit = Number.isInteger(args.limit) ? Math.max(1, Math.min(20, args.limit as number)) : 20;
    const eligible = eligibleCandidates(state, nowMs).filter((track) =>
      !query || [track.artist, track.title, track.album, track.genre].some((value) => value?.toLowerCase().includes(query)));
    return { output: { total: eligible.length, tracks: eligible.slice(offset, offset + limit).map(metadata) } };
  }
  if (call.name === "inspect_tracks") {
    if (!Array.isArray(args.trackIds) || !args.trackIds.every((id) => typeof id === "string")) throw new Error("Invalid trackIds in model tool call");
    const eligibleIds = new Set(eligibleCandidates(state, nowMs).map((track) => track.id));
    return { output: (args.trackIds as string[]).slice(0, 8).map((id) => {
      const track = state.pool.find((item) => item.id === id);
      return track && !track.requestOnly ? { ...metadata(track), eligible: eligibleIds.has(id) } : { id, eligible: false, error: "outside-event-pool" };
    }) };
  }
  if (call.name === "read_history") {
    const describe = (trackId: string) => {
      const track = state.pool.find((item) => item.id === trackId);
      return track ? metadata(track) : { id: trackId };
    };
    return { output: {
      recent: state.history.slice(-12).map((item) => ({ ...describe(item.trackId), startedAtMs: item.startedAtMs })),
      current: state.current ? describe(state.current.trackId) : null,
      upcoming: state.upcoming.map((entry) => ({ ...describe(entry.trackId), source: entry.source, protected: entry.protected, committed: entry.committed })),
    } };
  }
  if (call.name === "submit_selection") {
    const trackId = stringArg(args, "trackId");
    const reason = stringArg(args, "reason").trim();
    if (!reason || reason.length > 180) throw new Error("Model selection reason must be 1–180 characters");
    addSelection(state, trackId, "agent", nowMs, reason);
    return { choice: { trackId, reason } };
  }
  throw new Error(`Unknown model tool: ${call.name}`);
}

/** One stateless Responses function-calling turn, bounded by time and tool count. */
export async function selectTrack(state: EventState, config: SelectorConfig, nowMs = Date.now()): Promise<SelectionChoice> {
  if (!config.apiKey) throw new Error("OPENAI_API_KEY is required for autonomous selection");
  if (!eligibleCandidates(state, nowMs).length) throw new Error("No eligible track before the planned end");
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), config.timeoutMs ?? 30_000);
  const input: Record<string, unknown>[] = [{ role: "user", content: JSON.stringify({
    eventBrief: state.eventBrief, steering: state.steering,
    currentTrackId: state.current?.trackId ?? null,
    upcoming: state.upcoming.map((entry) => ({ trackId: entry.trackId, source: entry.source, protected: entry.protected })),
    task: "Choose one eligible track to append after the existing queue.",
  }) }];
  try {
    for (let calls = 0; calls < 6; calls++) {
      const response = await (config.fetcher ?? fetch)(config.endpoint ?? "https://api.openai.com/v1/responses", {
        method: "POST", signal: abort.signal,
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: config.model ?? "gpt-6-luna", store: false, reasoning: { effort: "none" },
          instructions: "You select music for one venue event. Use only the supplied frozen pool and actual metadata. Search the pool, inspect candidates, and read history as useful. Respect the event brief, live steering, no-repeat rule, and artist spacing. Never invent BPM, key, mood, or energy if absent. Submit one track with a concise, concrete reason. The controller validates your choice.",
          input, tools, tool_choice: "required", parallel_tool_calls: false, max_output_tokens: 1_000,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: { code?: string } };
        throw new Error(body.error?.code === "credit_balance_exhausted"
          ? "OpenAI credit balance exhausted"
          : `OpenAI request failed: HTTP ${response.status}`);
      }
      const payload = await response.json() as ModelResponse;
      if (payload.status !== "completed" || !Array.isArray(payload.output)) throw new Error(`OpenAI response status: ${payload.status ?? "invalid"}`);
      const functionCalls = payload.output.filter((item): item is FunctionCall => item.type === "function_call" &&
        typeof item.call_id === "string" && typeof item.name === "string" && typeof item.arguments === "string");
      if (functionCalls.length !== 1) throw new Error("Model did not make exactly one function call");
      const call = functionCalls[0]!;
      input.push(...payload.output);
      const result = executeTool(call, state, nowMs);
      if (result.choice) return result.choice;
      input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result.output) });
    }
    throw new Error("Model exceeded six tool calls");
  } finally {
    clearTimeout(timeout);
  }
}
