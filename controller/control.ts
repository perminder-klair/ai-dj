import { readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { atomicWrite } from "./prepare.ts";
import { buildSchedule } from "./event.ts";
import type { EventState } from "./event.ts";

async function removeIfPresent(path: string): Promise<void> {
  try { await unlink(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

async function bootId(): Promise<string> {
  return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
}

async function saveState(directory: string, state: EventState): Promise<void> {
  await atomicWrite(resolve(directory, "event.json"), JSON.stringify(state, null, 2) + "\n");
}

async function finishStop(directory: string, state: EventState): Promise<EventState> {
  await removeIfPresent(resolve(directory, "run.flag"));
  const currentTrack = state.pool.find((track) => track.id === state.current?.trackId);
  const history = state.current && currentTrack ? [...state.history, {
    trackId: currentTrack.id, artistId: currentTrack.artistId,
    startedAtMs: state.current.startedAtMs, endedAtMs: Date.now(),
  }] : state.history;
  const stopped: EventState = { ...state, status: "stopped", current: null, upcoming: [], history };
  await saveState(directory, stopped);
  return stopped;
}

/** A full machine reboot requires an explicit resume; a service restart does not. */
export async function recoverOnStartup(directory: string, bootIdOverride?: string): Promise<EventState> {
  const currentBootId = bootIdOverride ?? await bootId();
  const state = JSON.parse(await readFile(resolve(directory, "event.json"), "utf8")) as EventState;
  if (state.status === "stopped") {
    await removeIfPresent(resolve(directory, "run.flag"));
    return state;
  }
  try {
    await readFile(resolve(directory, "stop.request"), "utf8");
    return await finishStop(directory, state);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (state.status === "prepared" || state.status === "paused") {
    await removeIfPresent(resolve(directory, "run.flag"));
    return state;
  }
  let storedBootId = "";
  try { storedBootId = (await readFile(resolve(directory, "run.flag"), "utf8")).trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (state.status === "running" && storedBootId !== currentBootId) {
    await removeIfPresent(resolve(directory, "run.flag"));
    await removeIfPresent(resolve(directory, "now-playing.json"));
    await removeIfPresent(resolve(directory, "committed.json"));
    const currentTrack = state.pool.find((track) => track.id === state.current?.trackId);
    const history = state.current && currentTrack ? [...state.history, {
      trackId: currentTrack.id, artistId: currentTrack.artistId,
      startedAtMs: state.current.startedAtMs, endedAtMs: Date.now(),
    }] : state.history;
    const paused: EventState = { ...state, status: "paused", current: null, upcoming: [], history,
      warnings: [...state.warnings, "Machine restarted; operator resume required"] };
    await saveState(directory, paused);
    return paused;
  }
  return state;
}

export async function control(stateDirectory: string, command: "start" | "resume" | "stop"): Promise<void> {
  const statePath = resolve(stateDirectory, "event.json");
  const flagPath = resolve(stateDirectory, "run.flag");
  const state = JSON.parse(await readFile(statePath, "utf8")) as EventState;
  if (command === "start" || command === "resume") {
    if (command === "start" && state.status !== "prepared" && state.status !== "stopped") throw new Error("Only a prepared or stopped event may start");
    if (command === "resume" && state.status !== "paused") throw new Error("Only a paused event may resume");
    let next = state;
    if (state.status === "stopped") {
      const duration = state.sessionDurationMs && state.sessionDurationMs > 0 ? state.sessionDurationMs : 40 * 60_000;
      next = { ...state, status: "prepared", sessionDurationMs: duration, plannedEndMs: Date.now() + duration,
        pool: state.pool.filter((track) => !track.requestOnly), history: [], current: null, upcoming: [], warnings: [], steering: [] };
      for (const name of ["played.txt", "now-playing.json", "committed.json", "skip.request", "stop.request", "speech-next.txt"]) {
        await removeIfPresent(resolve(stateDirectory, name));
      }
      await atomicWrite(resolve(stateDirectory, "planned-end.txt"), `${next.plannedEndMs / 1000}\n`);
      const paths = buildSchedule(next, Date.now());
      await atomicWrite(resolve(stateDirectory, "schedule.m3u"), paths.join("\n") + (paths.length ? "\n" : ""));
    }
    if (Date.now() >= next.plannedEndMs) throw new Error("Planned end has passed; extend before starting");
    await writeFile(flagPath, `${await bootId()}\n`, { flag: "wx" });
    await saveState(stateDirectory, { ...next, status: "running" });
  } else {
    if (state.status === "stopped") return;
    await atomicWrite(resolve(stateDirectory, "stop.request"), `${Date.now()}\n`);
    if (state.status === "running") await delay(2_200);
    await finishStop(stateDirectory, state);
  }
}

if (process.argv[1]?.endsWith("/controller/control.ts")) {
  const [command, stateDirectory] = process.argv.slice(2);
  if ((command !== "start" && command !== "resume" && command !== "stop") || !stateDirectory) {
    console.error("Usage: node controller/control.ts <start|resume|stop> <state-directory>");
    process.exitCode = 1;
  } else {
    control(stateDirectory, command).catch((error: unknown) => { console.error(error); process.exitCode = 1; });
  }
}
