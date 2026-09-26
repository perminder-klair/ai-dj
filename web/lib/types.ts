export interface Track {
  id: string;
  title: string;
  artist: string;
  artistId: string;
  durationMs: number;
  album?: string;
  genre?: string;
  year?: number;
  requestOnly?: boolean;
}

export interface QueueEntry {
  trackId: string;
  source: "agent" | "fallback" | "operator";
  reason: string;
  protected: boolean;
  committed: boolean;
}

export interface EventState {
  id: string;
  status: "prepared" | "running" | "paused" | "stopped";
  plannedEndMs: number;
  eventBrief: string;
  steering: string[];
  speechMuted: boolean;
  pool: Track[];
  history: { trackId: string; startedAtMs: number; endedAtMs: number }[];
  current: { trackId: string; startedAtMs: number } | null;
  upcoming: QueueEntry[];
  warnings: string[];
}
