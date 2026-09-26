"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { EventState, Track } from "@/lib/types";

type View = "loading" | "login" | "deck";
const formatTime = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};
const formatClock = (ms: number) =>
  new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(ms);

function RecordArt({ playing, title }: { playing: boolean; title: string }) {
  return (
    <div
      className={`record-wrap${playing ? " playing" : ""}`}
      aria-label={playing ? `Playing ${title}` : "Turntable idle"}
      role="img"
    >
      <div className="record-orbit" />
      <div className="record">
        <div className="record-label">
          <span className="record-label-top">DJ HERO · SIDE A</span>
          <span className="record-spindle" />
          <strong>{title}</strong>
          <span className="record-label-bottom">DIRECT DRIVE / 33 RPM</span>
        </div>
      </div>
      <div className="tonearm">
        <span className="arm-pivot" />
        <span className="arm-shaft" />
        <span className="arm-head" />
      </div>
    </div>
  );
}

function Sleeve({ track }: { track?: Track }) {
  return (
    <div className="sleeve" aria-hidden="true">
      <div className="sleeve-disc">
        <div className="sleeve-core" />
      </div>
      <span>DJH / {track?.year ?? "26"}</span>
    </div>
  );
}

export default function Deck() {
  const [view, setView] = useState<View>("loading");
  const [state, setState] = useState<EventState | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [password, setPassword] = useState("");
  const [steering, setSteering] = useState("");
  const [search, setSearch] = useState("");
  const [librarySource, setLibrarySource] = useState<"pool" | "all">("pool");
  const [libraryResults, setLibraryResults] = useState<Track[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  const [selectedTrack, setSelectedTrack] = useState("");
  const [showLibrary, setShowLibrary] = useState(false);
  const [replaceIndex, setReplaceIndex] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [listening, setListening] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  const loadState = useCallback(async () => {
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      if (response.status === 401) {
        setView("login");
        setState(null);
        return;
      }
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error ?? "Could not reach controller");
      setState(data as EventState);
      setConnectionError("");
      setView("deck");
    } catch (error) {
      setConnectionError(
        error instanceof Error ? error.message : "Could not reach controller",
      );
      setView((current) => (current === "loading" ? "deck" : current));
    }
  }, []);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  useEffect(() => {
    if (view !== "deck") return;
    const refresh = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadState();
    }, 2500);
    return () => window.clearInterval(refresh);
  }, [loadState, view]);

  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(clock);
  }, []);

  useEffect(() => {
    if (!showLibrary || librarySource !== "all" || search.trim().length < 2) {
      setLibraryResults([]);
      setLibraryLoading(false);
      setLibraryError("");
      return;
    }
    const abort = new AbortController();
    const timer = window.setTimeout(async () => {
      setLibraryLoading(true);
      setLibraryError("");
      try {
        const response = await fetch(`/api/library-search?q=${encodeURIComponent(search.trim())}`, { signal: abort.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Library search failed");
        setLibraryResults(data.songs as Track[]);
      } catch (error) {
        if (!abort.signal.aborted) setLibraryError(error instanceof Error ? error.message : "Library search failed");
      } finally {
        if (!abort.signal.aborted) setLibraryLoading(false);
      }
    }, 300);
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, [showLibrary, librarySource, search]);

  async function signIn(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setActionError("");
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not sign in");
      setPassword("");
      setView("deck");
      await loadState();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Could not sign in",
      );
    } finally {
      setPending(false);
    }
  }

  async function command(
    name: string,
    body: Record<string, unknown> = {},
    success?: string,
  ): Promise<boolean> {
    setPending(true);
    setActionError("");
    setNotice("");
    try {
      const response = await fetch("/api/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: name, ...body }),
      });
      const data = await response.json();
      if (response.status === 401) {
        setView("login");
        setState(null);
        throw new Error("Session expired. Sign in again.");
      }
      if (!response.ok) throw new Error(data.error ?? "Command failed");
      setNotice(success ?? `${name.replace("-", " ")} sent`);
      await loadState();
      return true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Command failed");
      return false;
    } finally {
      setPending(false);
    }
  }

  async function toggleAudio() {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      setListening(false);
      return;
    }
    try {
      await audio.play();
      setListening(true);
      setActionError("");
    } catch {
      setActionError(
        "Audio is unavailable. Check that the venue stream is running.",
      );
    }
  }

  const current = state?.pool.find(
    (track) => track.id === state.current?.trackId,
  );
  const elapsed = state?.current
    ? Math.max(0, now - state.current.startedAtMs)
    : 0;
  const progress = current
    ? Math.min(100, (elapsed / current.durationMs) * 100)
    : 0;
  const history = state?.history.slice(-4).reverse() ?? [];
  const pool = useMemo(
    () =>
      (state?.pool ?? [])
        .filter((track) => !track.requestOnly)
        .filter((track) =>
          `${track.title} ${track.artist} ${track.album ?? ""}`
            .toLowerCase()
            .includes(search.toLowerCase()),
        )
        .slice(0, 24),
    [state?.pool, search],
  );
  const canControl = !!state && !connectionError && !pending;
  const status = state?.status ?? "offline";

  if (view === "loading")
    return (
      <main className="loading-screen">
        <span className="brand">DJ HERO</span>
        <p>Connecting to the deck…</p>
      </main>
    );
  if (view === "login")
    return (
      <main className="login-screen">
        <div className="login-card">
          <span className="eyebrow accent">OPERATOR ACCESS / 01</span>
          <h1>
            DJ <span>HERO</span>
          </h1>
          <p>The booth is yours. Sign in to control the set.</p>
          <form onSubmit={signIn}>
            <label htmlFor="password">OPERATOR PASSWORD</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
              autoFocus
            />
            <button type="submit" disabled={pending}>
              ENTER THE BOOTH <span aria-hidden="true">↗</span>
            </button>
          </form>
          {actionError && (
            <p className="form-error" role="alert">
              {actionError}
            </p>
          )}
          <small>LIVE VENUE CONTROL · AUTHORISED OPERATORS ONLY</small>
        </div>
      </main>
    );

  return (
    <main className="app-shell">
      <audio
        ref={audioRef}
        src="/api/audio"
        preload="none"
        loop
        onPause={() => setListening(false)}
        onError={() =>
          setActionError(
            "Audio is unavailable. Check that the venue stream is running.",
          )
        }
      />
      <header className="masthead">
        <div className="brand">
          DJ <span>HERO</span>
        </div>
        <div className="masthead-right">
          <span className="live-mark">
            <i className={status === "running" ? "on" : ""} />
            {status === "running" ? "ON AIR" : status.toUpperCase()}
          </span>
          <span className="masthead-brief">
            {state?.eventBrief || "THE OPERATOR DECK"}
          </span>
          <button
            className="signout"
            onClick={async () => {
              await fetch("/api/logout", { method: "POST" });
              setView("login");
              setState(null);
            }}
            title="Sign out"
          >
            SIGN OUT ↗
          </button>
        </div>
      </header>
      <div className="deck-grid">
        <section
          className="turntable-panel"
          aria-label="Turntable and playback controls"
        >
          <div className="panel-eyebrow">
            DIRECT DRIVE <span>·</span> QUARTZ LOCK
          </div>
          <RecordArt
            playing={status === "running" && !!current}
            title={current?.title ?? "DJ HERO"}
          />
          <div className="transport">
            <div className="transport-buttons">
              {status === "running" ? (
                <button
                  className="main-control stop-control"
                  onClick={() => {
                    if (
                      window.confirm(
                        "Stop the event? This ends playback and cannot be resumed.",
                      )
                    )
                      void command("stop", {}, "Event stopped");
                  }}
                  disabled={!canControl}
                >
                  <span className="control-symbol">■</span>
                  <span>STOP</span>
                </button>
              ) : (
                <button
                  className="main-control"
                  onClick={() =>
                    void command(
                      status === "paused" ? "resume" : "start",
                      {},
                      status === "paused"
                        ? "Playback resumed"
                        : "Playback started",
                    )
                  }
                  disabled={!canControl || status === "stopped"}
                >
                  <span className="control-symbol">▶</span>
                  <span>{status === "paused" ? "RESUME" : "START"}</span>
                </button>
              )}
              <button
                className="round-control"
                onClick={() =>
                  void command("skip", {}, "Skipping current track")
                }
                disabled={!canControl || status !== "running" || !current}
                title="Skip current track"
              >
                <span>↠</span>
                <small>SKIP</small>
              </button>
              <button
                className={`round-control${state?.speechMuted ? " active" : ""}`}
                onClick={() =>
                  void command(
                    "mute",
                    { muted: !state?.speechMuted },
                    state?.speechMuted ? "Speech unmuted" : "Speech muted",
                  )
                }
                disabled={!canControl}
                title={state?.speechMuted ? "Unmute speech" : "Mute speech"}
              >
                <span>{state?.speechMuted ? "×" : "◖"}</span>
                <small>VOICE</small>
              </button>
              <button
                className="round-control"
                onClick={() => void command("announce", {}, "DJ line sent to the stream")}
                disabled={!canControl || status !== "running" || state?.speechMuted}
                title="Generate and speak a DJ line"
              >
                <span>♫</span>
                <small>SPEAK</small>
              </button>
            </div>
            <button
              className={`signal-block audio-monitor${listening ? " listening" : ""}`}
              onClick={() => void toggleAudio()}
              disabled={!state}
              aria-label={
                listening
                  ? "Stop listening to the audio stream"
                  : "Listen to the audio stream"
              }
              aria-pressed={listening}
            >
              <div className="signal-bars" aria-hidden="true">
                {[24, 38, 52, 70, 56, 84, 64, 44, 26].map((height, index) => (
                  <i key={index} style={{ height: `${height}%` }} />
                ))}
              </div>
              <span>{listening ? "■ MONITOR ON" : "▶ LISTEN"}</span>
            </button>
          </div>
        </section>
        <section className="content-panel" aria-label="Set details">
          <div className="now-playing">
            <div className="now-main">
              <Sleeve track={current} />
              <div className="now-copy">
                <span className="eyebrow accent">
                  {current ? "NOW SPINNING" : "ON THE TURNTABLE"}
                </span>
                <h1>
                  {current?.title ??
                    (status === "prepared"
                      ? "Ready when you are"
                      : status === "paused"
                        ? "On pause"
                        : status === "stopped"
                          ? "End of the set"
                          : "No record playing")}
                </h1>
                <div className="artist">{current?.artist ?? "DJ HERO"}</div>
                <div className="album">
                  {current?.album ??
                    (state ? `EVENT ${state.id}` : "WAITING FOR CONTROLLER")}
                </div>
              </div>
            </div>
            <div className="progress-row">
              <span>
                {current
                  ? formatTime(Math.min(elapsed, current.durationMs))
                  : "0:00"}
              </span>
              <div
                className="progress-track"
                role="progressbar"
                aria-label="Track progress"
                aria-valuenow={Math.round(progress)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <i style={{ width: `${progress}%` }} />
              </div>
              <span>{current ? formatTime(current.durationMs) : "0:00"}</span>
            </div>
          </div>
          <div className="right-sections">
            <section className="box-section queue-section">
              <div className="box-heading">
                <h2>NEXT ON THE PLATTER</h2>
                <span>{state?.upcoming.length ?? 0} QUEUED</span>
              </div>
              <div className="box-content">
                {state?.upcoming.length ? (
                  state.upcoming.slice(0, 4).map((entry, index) => {
                    const track = state.pool.find(
                      (item) => item.id === entry.trackId,
                    );
                    return (
                      <div
                        className="queue-row"
                        key={`${entry.trackId}-${index}`}
                      >
                        <span className="queue-number">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <div className="queue-track">
                          <strong>{track?.title ?? entry.trackId}</strong>
                          <small>
                            {track?.artist ?? "Unknown artist"} ·{" "}
                            {entry.source === "agent"
                              ? "MARLOWE'S PICK"
                              : entry.source.toUpperCase()}
                            {entry.committed ? " · LOCKED" : ""}
                          </small>
                        </div>
                        <span className="queue-duration">
                          {track ? formatTime(track.durationMs) : ""}
                        </span>
                        {!entry.committed && (
                          <button
                            className="queue-action"
                            onClick={() => {
                              setShowLibrary(true);
                              setLibrarySource("pool");
                              setSelectedTrack("");
                              setReplaceIndex(index);
                            }}
                            title={`Choose a replacement for ${track?.title ?? "this track"}`}
                          >
                            EDIT ↗
                          </button>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <p className="empty-copy">
                    Nothing cued. The selector will choose at the run-out.
                  </p>
                )}
              </div>
            </section>
            <section className="box-section history-section">
              <div className="box-heading">
                <h2>RECENTLY SPUN</h2>
                <span>THE SESSION</span>
              </div>
              <div className="box-content">
                {history.length ? (
                  history.map((item, index) => {
                    const track = state?.pool.find(
                      (entry) => entry.id === item.trackId,
                    );
                    return (
                      <div
                        className="history-row"
                        key={`${item.trackId}-${index}`}
                      >
                        <span>{formatClock(item.startedAtMs)}</span>
                        <strong>{track?.title ?? item.trackId}</strong>
                        <span>{track?.artist ?? ""}</span>
                      </div>
                    );
                  })
                ) : (
                  <p className="empty-copy">
                    The platter has been quiet. Nothing spun yet this session.
                  </p>
                )}
              </div>
            </section>
          </div>
          <div className="operator-tools">
            <form
              className="steer-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!steering.trim()) return;
                void command(
                  "steer",
                  { instruction: steering.trim() },
                  "Direction sent to Marlowe",
                ).then((ok) => {
                  if (ok) setSteering("");
                });
              }}
            >
              <label htmlFor="steering">DEAR DJ —</label>
              <input
                id="steering"
                value={steering}
                onChange={(event) => setSteering(event.target.value)}
                placeholder="a song, an artist, a feeling…"
                disabled={!canControl || status === "stopped"}
              />
              <button
                disabled={
                  !canControl || !steering.trim() || status === "stopped"
                }
              >
                SEND ↗
              </button>
            </form>
            <div className="tool-buttons">
              <button
                onClick={() => {
                  setReplaceIndex(null);
                  setShowLibrary(!showLibrary);
                }}
                disabled={!state}
                aria-expanded={showLibrary}
              >
                BROWSE MUSIC ↗
              </button>
              <span>{state?.pool.filter((track) => !track.requestOnly).length ?? 0} APPROVED TRACKS</span>
            </div>
          </div>
        </section>
      </div>
      <div className="status-strip">
        <span>
          <i className={`status-dot ${connectionError ? "bad" : ""}`} />
          {connectionError
            ? "CONTROLLER OFFLINE"
            : `${status.toUpperCase()} · ${status === "running" ? "LOCKED" : "STANDBY"}`}
        </span>
        <span>{state?.speechMuted ? "VOICE MUTED" : "VOICE READY"}</span>
        <span>ENDS {state ? formatClock(state.plannedEndMs) : "--:--"}</span>
      </div>
      {(connectionError ||
        actionError ||
        notice ||
        !!state?.warnings.length) && (
        <div className="message-stack" aria-live="polite">
          {connectionError && (
            <p className="message error">
              {connectionError}{" "}
              <button onClick={() => void loadState()}>RETRY ↗</button>
            </p>
          )}
          {actionError && <p className="message error">{actionError}</p>}
          {notice && <p className="message success">{notice}</p>}
          {state?.warnings.slice(-2).map((warning, index) => (
            <p className="message warning" key={index}>
              WARNING / {warning}
            </p>
          ))}
        </div>
      )}
      {state?.steering.length ? (
        <div className="steering-history">
          <span className="eyebrow">LATEST DIRECTION</span>
          <p>“{state.steering.at(-1)}”</p>
        </div>
      ) : null}
      {showLibrary && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowLibrary(false);
          }}
        >
          <section
            className="library-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="library-title"
          >
            <div className="modal-header">
              <div>
                <span className="eyebrow accent">{librarySource === "pool" ? "THE APPROVED POOL" : "WHOLE LIBRARY · REQUESTS"}</span>
                <h2 id="library-title">
                  {replaceIndex === null ? "Find a record" : "Replace record"}
                </h2>
              </div>
              <button
                className="modal-close"
                onClick={() => setShowLibrary(false)}
                aria-label="Close library"
              >
                ×
              </button>
            </div>
            <div className="library-tabs" role="tablist" aria-label="Music source">
              <button type="button" role="tab" aria-selected={librarySource === "pool"} className={librarySource === "pool" ? "active" : ""}
                onClick={() => { setLibrarySource("pool"); setSelectedTrack(""); }}>EVENT POOL</button>
              {replaceIndex === null && <button type="button" role="tab" aria-selected={librarySource === "all"} className={librarySource === "all" ? "active" : ""}
                onClick={() => { setLibrarySource("all"); setSelectedTrack(""); }}>WHOLE LIBRARY</button>}
            </div>
            <input
              className="library-search"
              autoFocus
              placeholder="Search title, artist, or album"
              value={search}
              onChange={(event) => { setSearch(event.target.value); setSelectedTrack(""); setLibraryResults([]); }}
            />
            <div className="library-list">
              {(librarySource === "pool" ? pool : libraryResults).map((track) => (
                <button
                  className={`library-track${selectedTrack === track.id ? " selected" : ""}`}
                  key={track.id}
                  onClick={() => setSelectedTrack(track.id)}
                >
                  <span>
                    <strong>{track.title}</strong>
                    <small>
                      {track.artist}
                      {track.album ? ` · ${track.album}` : ""}
                    </small>
                  </span>
                  <span>{formatTime(track.durationMs)}</span>
                </button>
              ))}
              {librarySource === "all" && search.trim().length < 2 && <p className="empty-copy">Enter at least two characters to search every song in Navidrome.</p>}
              {libraryLoading && <p className="empty-copy">Searching the library…</p>}
              {libraryError && <p className="library-error" role="alert">{libraryError}</p>}
              {!libraryLoading && !libraryError && (librarySource === "pool" ? pool.length === 0 : search.trim().length >= 2 && libraryResults.length === 0) && (
                <p className="empty-copy">No records match that search.</p>
              )}
            </div>
            {actionError && (
              <p className="library-error" role="alert">
                {actionError}
              </p>
            )}
            <div className="library-footer">
              <span>
                {selectedTrack
                  ? (librarySource === "pool" ? pool : libraryResults).find((track) => track.id === selectedTrack)
                      ?.title
                  : "SELECT A RECORD"}
              </span>
              <div>
                {replaceIndex === null ? (
                  <>
                    <button
                      onClick={() => {
                        if (selectedTrack)
                          void command(
                            librarySource === "all" ? "request" : "queue",
                            librarySource === "all" ? { trackId: selectedTrack, position: "queue" } : { trackId: selectedTrack, source: "operator" },
                            "Track added to queue",
                          ).then((ok) => {
                            if (ok) setShowLibrary(false);
                          });
                      }}
                      disabled={!selectedTrack || !canControl}
                    >
                      ADD TO QUEUE
                    </button>
                    <button
                      className="primary"
                      onClick={() => {
                        if (selectedTrack)
                          void command(
                            librarySource === "all" ? "request" : "force-next",
                            librarySource === "all" ? { trackId: selectedTrack, position: "next" } : { trackId: selectedTrack },
                            "Track set to play next",
                          ).then((ok) => {
                            if (ok) setShowLibrary(false);
                          });
                      }}
                      disabled={!selectedTrack || !canControl}
                    >
                      PLAY NEXT ↗
                    </button>
                  </>
                ) : (
                  <button
                    className="primary"
                    onClick={() => {
                      if (selectedTrack)
                        void command(
                          "replace",
                          { index: replaceIndex, trackId: selectedTrack },
                          "Queued track replaced",
                        ).then((ok) => {
                          if (ok) setShowLibrary(false);
                        });
                    }}
                    disabled={!selectedTrack || !canControl}
                  >
                    REPLACE ↗
                  </button>
                )}
              </div>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
