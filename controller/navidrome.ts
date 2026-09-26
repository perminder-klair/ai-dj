import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Manifest, ManifestTrack } from "./prepare.ts";
import type { EventTrack } from "./event.ts";

export interface NavidromeConfig {
  endpoint: string;
  username: string;
  password: string;
  fetcher?: typeof fetch;
}

interface Song {
  id: string;
  title?: string;
  artist?: string;
  artistId?: string;
  album?: string;
  genre?: string;
  year?: number;
  duration?: number;
  suffix?: string;
}

interface PlaylistResponse {
  "subsonic-response"?: {
    status?: string;
    error?: { message?: string };
    playlist?: { id?: string; entry?: Song[] | Song };
  };
}

export interface NavidromePlaylist {
  id: string;
  name: string;
  songCount: number;
  duration: number;
}

interface PlaylistsResponse {
  "subsonic-response"?: {
    status?: string;
    error?: { message?: string };
    playlists?: { playlist?: NavidromePlaylist[] | NavidromePlaylist };
  };
}

export interface LibrarySong {
  id: string;
  title: string;
  artist: string;
  artistId: string;
  durationMs: number;
  album?: string;
  genre?: string;
  year?: number;
}

function songMetadata(song: Song): LibrarySong {
  if (typeof song.id !== "string" || !song.id || !Number.isFinite(song.duration) || (song.duration ?? 0) <= 5) {
    throw new Error("Navidrome returned a song without an id or usable duration");
  }
  return {
    id: song.id, title: song.title || song.id, artist: song.artist || "Unknown artist",
    artistId: song.artistId || song.artist || "unknown-artist", durationMs: Math.round(song.duration! * 1000),
    ...(song.album ? { album: song.album } : {}),
    ...(song.genre ? { genre: song.genre } : {}),
    ...(Number.isInteger(song.year) ? { year: song.year } : {}),
  };
}

async function jsonResponse(config: NavidromeConfig, method: string, parameters: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetcher(config)(subsonicUrl(config, method, parameters));
  if (!response.ok || !response.headers.get("content-type")?.includes("json")) {
    throw new Error(`Navidrome ${method} failed: HTTP ${response.status}`);
  }
  const payload = await response.json() as { "subsonic-response"?: Record<string, unknown> };
  const body = payload["subsonic-response"];
  if (body?.status !== "ok") {
    const error = body?.error as { message?: string } | undefined;
    throw new Error(`Navidrome ${method} failed: ${error?.message ?? "invalid response"}`);
  }
  return body;
}

export async function searchNavidromeSongs(config: NavidromeConfig, query: string): Promise<LibrarySong[]> {
  const term = query.trim();
  if (term.length < 2 || term.length > 120) throw new Error("Search must be 2–120 characters");
  const body = await jsonResponse(config, "search3", { query: term, artistCount: "0", albumCount: "0", songCount: "30" });
  const result = body.searchResult3 as { song?: Song[] | Song } | undefined;
  const songs = result?.song;
  return (Array.isArray(songs) ? songs : songs ? [songs] : []).map(songMetadata);
}

export async function fetchNavidromeRequestTrack(config: NavidromeConfig, trackId: string, musicDirectory: string): Promise<EventTrack> {
  if (!trackId || trackId.length > 512) throw new Error("Invalid track id");
  const body = await jsonResponse(config, "getSong", { id: trackId });
  const song = body.song as Song | undefined;
  if (!song || song.id !== trackId) throw new Error("Navidrome returned a different song");
  const metadata = songMetadata(song);
  const file = await downloadSong(config, song, musicDirectory, "requests");
  return { ...metadata, localPath: `/music/${file}`, requestOnly: true };
}

function subsonicUrl(config: NavidromeConfig, method: string, parameters: Record<string, string>): URL {
  const base = config.endpoint.replace(/\/+$/, "");
  const url = new URL(`${base}/rest/${method}.view`);
  const salt = randomBytes(8).toString("hex");
  const token = createHash("md5").update(config.password + salt).digest("hex");
  for (const [key, value] of Object.entries({ u: config.username, t: token, s: salt, v: "1.16.1", c: "ai-dj", f: "json", ...parameters })) {
    url.searchParams.set(key, value);
  }
  return url;
}

function fetcher(config: NavidromeConfig): typeof fetch {
  return config.fetcher ?? fetch;
}

export async function listNavidromePlaylists(config: NavidromeConfig): Promise<NavidromePlaylist[]> {
  const response = await fetcher(config)(subsonicUrl(config, "getPlaylists", {}));
  if (!response.ok) throw new Error(`Navidrome playlists request failed: HTTP ${response.status}`);
  if (!response.headers.get("content-type")?.includes("json")) {
    throw new Error("Navidrome playlists request did not return JSON; check the server URL");
  }
  const payload = await response.json() as PlaylistsResponse;
  const body = payload["subsonic-response"];
  if (body?.status !== "ok") throw new Error(`Navidrome playlists request failed: ${body?.error?.message ?? "invalid response"}`);
  const playlists = body.playlists?.playlist;
  return Array.isArray(playlists) ? playlists : playlists ? [playlists] : [];
}

async function playlistSongs(config: NavidromeConfig, playlistId: string): Promise<Song[]> {
  const response = await fetcher(config)(subsonicUrl(config, "getPlaylist", { id: playlistId }));
  if (!response.ok) throw new Error(`Navidrome playlist request failed: HTTP ${response.status}`);
  if (!response.headers.get("content-type")?.includes("json")) {
    throw new Error("Navidrome playlist request did not return JSON; check the server URL");
  }
  const payload = await response.json() as PlaylistResponse;
  const body = payload["subsonic-response"];
  if (body?.status !== "ok") throw new Error(`Navidrome playlist request failed: ${body?.error?.message ?? "invalid response"}`);
  if (body.playlist?.id !== playlistId) throw new Error("Navidrome returned a different playlist");
  const entries = body.playlist.entry;
  return Array.isArray(entries) ? entries : entries ? [entries] : [];
}

async function downloadSong(config: NavidromeConfig, song: Song, musicDirectory: string, playlistId: string): Promise<string> {
  const suffix = typeof song.suffix === "string" && /^[a-zA-Z0-9]{1,8}$/.test(song.suffix) ? song.suffix.toLowerCase() : "audio";
  const playlistFolder = createHash("sha256").update(playlistId).digest("hex").slice(0, 16);
  const trackName = createHash("sha256").update(song.id).digest("hex");
  const relativeFile = `navidrome/${playlistFolder}/${trackName}.${suffix}`;
  const destination = join(musicDirectory, relativeFile);
  await mkdir(join(musicDirectory, "navidrome", playlistFolder), { recursive: true });
  try {
    if ((await stat(destination)).size > 0) return relativeFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const response = await fetcher(config)(subsonicUrl(config, "download", { id: song.id }));
  if (!response.ok || !response.body || /json|xml|html/i.test(response.headers.get("content-type") ?? "")) {
    throw new Error(`Navidrome download failed for track ${song.id}: HTTP ${response.status}`);
  }
  const temporary = `${destination}.${randomUUID()}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    if ((await stat(temporary)).size === 0) throw new Error(`Navidrome returned an empty file for ${song.id}`);
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return relativeFile;
}

/** Fetch playlist membership once, then download original files into a local cache. */
export async function importNavidromePlaylist(
  config: NavidromeConfig,
  playlistId: string,
  musicDirectory: string,
  event: Pick<Manifest, "id" | "eventBrief" | "startsAt" | "plannedEnd">,
): Promise<Manifest> {
  if (!playlistId) throw new Error("Playlist id is required");
  const songs = await playlistSongs(config, playlistId);
  if (!songs.length) throw new Error("Navidrome playlist is empty");
  const seen = new Set<string>();
  const tracks: ManifestTrack[] = [];
  for (const song of songs) {
    if (typeof song.id !== "string" || !song.id) throw new Error("Playlist entry has no track id");
    if (seen.has(song.id)) continue;
    seen.add(song.id);
    if (!Number.isFinite(song.duration) || (song.duration ?? 0) <= 5) throw new Error(`Track ${song.id} has no usable duration`);
    const file = await downloadSong(config, song, musicDirectory, playlistId);
    tracks.push({
      id: song.id,
      artistId: song.artistId || song.artist || "unknown-artist",
      artist: song.artist || "Unknown artist",
      title: song.title || song.id,
      durationMs: Math.round(song.duration! * 1000),
      file,
      ...(song.album ? { album: song.album } : {}),
      ...(song.genre ? { genre: song.genre } : {}),
      ...(Number.isInteger(song.year) ? { year: song.year } : {}),
    });
  }
  return { ...event, tracks };
}

export async function saveManifest(manifest: Manifest, path: string): Promise<void> {
  await writeFile(path, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
