import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { prepareFallback, type EventState, type EventTrack } from "./event.ts";

export interface ManifestTrack {
  id: string;
  artistId: string;
  artist: string;
  title: string;
  durationMs: number;
  file: string;
  album?: string;
  genre?: string;
  year?: number;
}

export interface Manifest {
  id: string;
  eventBrief: string;
  startsAt: string;
  plannedEnd: string;
  tracks: ManifestTrack[];
}

function nonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string`);
}

const execFileAsync = promisify(execFile);

export async function probeDuration(path: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path]);
  const durationMs = Math.round(Number(stdout.trim()) * 1000);
  if (!Number.isFinite(durationMs) || durationMs <= 5_000) throw new Error(`Cannot determine audio duration: ${path}`);
  return durationMs;
}

async function validateTrack(input: ManifestTrack, musicRoot: string, durationProbe: (path: string) => Promise<number>): Promise<EventTrack> {
  for (const key of ["id", "artistId", "artist", "title", "file"] as const) nonempty(input[key], `track ${key}`);
  if (!Number.isFinite(input.durationMs) || input.durationMs <= 5_000) throw new Error(`Invalid duration for ${input.id}`);
  if (isAbsolute(input.file)) throw new Error(`Track path must be relative: ${input.file}`);
  const source = await realpath(resolve(musicRoot, input.file));
  const withinRoot = relative(musicRoot, source);
  if (withinRoot.startsWith("..") || isAbsolute(withinRoot)) throw new Error(`Track leaves music directory: ${input.file}`);
  if (!(await stat(source)).isFile()) throw new Error(`Track is not a file: ${input.file}`);
  const actualDurationMs = await durationProbe(source);
  if (Math.abs(actualDurationMs - input.durationMs) > 5_000) throw new Error(`Duration differs from audio file: ${input.id}`);
  return {
    id: input.id, artistId: input.artistId, artist: input.artist, title: input.title,
    durationMs: input.durationMs, localPath: `/music/${withinRoot}`,
    ...(input.album ? { album: input.album } : {}),
    ...(input.genre ? { genre: input.genre } : {}),
    ...(Number.isInteger(input.year) ? { year: input.year } : {}),
  };
}

export async function prepare(
  manifestPath: string,
  musicDirectory: string,
  stateDirectory: string,
  durationProbe: (path: string) => Promise<number> = probeDuration,
): Promise<EventState> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  nonempty(manifest.id, "event id");
  nonempty(manifest.eventBrief, "event brief");
  const startMs = Date.parse(manifest.startsAt);
  const plannedEndMs = Date.parse(manifest.plannedEnd);
  if (!Number.isFinite(startMs) || !Number.isFinite(plannedEndMs) || plannedEndMs <= startMs) {
    throw new Error("Invalid event start or planned end");
  }
  if (!Array.isArray(manifest.tracks)) throw new Error("tracks must be an array");
  const musicRoot = await realpath(musicDirectory);
  const pool = await Promise.all(manifest.tracks.map((track) => validateTrack(track, musicRoot, durationProbe)));
  if (new Set(pool.map((track) => track.id)).size !== pool.length) throw new Error("Duplicate track id");
  for (const track of pool) {
    if (/[\r\n]/.test(track.localPath)) throw new Error(`Unsupported newline in filename: ${track.id}`);
  }
  const fallback = prepareFallback(pool, startMs, Math.min(5 * 3_600_000, (plannedEndMs - startMs) + 15 * 60_000));
  const state: EventState = {
    id: manifest.id, status: "prepared", plannedEndMs, eventBrief: manifest.eventBrief,
    steering: [], speechMuted: false, pool, fallbackOrder: fallback.order,
    history: [], current: null, upcoming: [], warnings: [],
  };
  await mkdir(stateDirectory, { recursive: true });
  for (const file of ["event.json", "fallback.m3u", "schedule.m3u", "planned-end.txt", "played.txt", "now-playing.json", "committed.json", "run.flag", "skip.request", "stop.request"]) {
    try {
      await stat(resolve(stateDirectory, file));
      throw new Error("State directory already contains event data; use a new directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await atomicWrite(resolve(stateDirectory, "fallback.m3u"), fallback.order.map((id) => pool.find((track) => track.id === id)!.localPath).join("\n") + "\n");
  await atomicWrite(resolve(stateDirectory, "planned-end.txt"), `${plannedEndMs / 1000}\n`);
  await atomicWrite(resolve(stateDirectory, "event.json"), JSON.stringify(state, null, 2) + "\n");
  return state;
}

export async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [manifestPath, musicDirectory, stateDirectory] = process.argv.slice(2);
  if (!manifestPath || !musicDirectory || !stateDirectory) {
    console.error("Usage: node controller/prepare.ts <manifest.json> <music-directory> <state-directory>");
    process.exitCode = 1;
  } else {
    prepare(manifestPath, musicDirectory, stateDirectory)
      .then((state) => console.log(`Prepared ${state.id}: ${state.pool.length} approved tracks`))
      .catch((error: unknown) => { console.error(error); process.exitCode = 1; });
  }
}
