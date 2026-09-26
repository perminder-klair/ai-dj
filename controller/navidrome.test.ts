import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importNavidromePlaylist, listNavidromePlaylists, saveManifest } from "./navidrome.ts";

test("lists Navidrome playlists without exposing the password", async () => {
  const playlists = await listNavidromePlaylists({
    endpoint: "https://music.example", username: "test-user", password: "test-password",
    fetcher: async (input) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/rest/getPlaylists.view");
      assert.equal(url.searchParams.get("u"), "test-user");
      assert.equal(url.searchParams.has("p"), false);
      assert.equal(url.searchParams.get("t"), createHash("md5").update(`test-password${url.searchParams.get("s")}`).digest("hex"));
      return Response.json({ "subsonic-response": { status: "ok", playlists: { playlist: [
        { id: "playlist-1", name: "Warmup", songCount: 60, duration: 18000 },
      ] } } });
    },
  });
  assert.deepEqual(playlists, [{ id: "playlist-1", name: "Warmup", songCount: 60, duration: 18000 }]);
});

test("rejects a radio website URL in place of the Navidrome API", async () => {
  await assert.rejects(
    listNavidromePlaylists({ endpoint: "https://radio.example", username: "test-user", password: "test-password",
      fetcher: async () => new Response("<html>Radio</html>", { headers: { "content-type": "text/html" } }),
    }),
    /did not return JSON; check the server URL/,
  );
});

test("imports one Navidrome playlist, deduplicates membership, and stores no credentials", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-dj-navidrome-"));
  context.after(async () => { const { rm } = await import("node:fs/promises"); await rm(directory, { recursive: true, force: true }); });
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    assert.equal(url.searchParams.get("u"), "test-user");
    assert.equal(url.searchParams.has("p"), false);
    const salt = url.searchParams.get("s")!;
    assert.equal(url.searchParams.get("t"), createHash("md5").update(`test-password${salt}`).digest("hex"));
    if (url.pathname.endsWith("/getPlaylist.view")) {
      assert.equal(url.searchParams.get("id"), "playlist-1");
      return Response.json({ "subsonic-response": { status: "ok", playlist: { id: "playlist-1", entry: [
        { id: "song-1", title: "One", artist: "Artist", artistId: "artist-1", duration: 240, suffix: "mp3", genre: "House" },
        { id: "song-1", title: "One", artist: "Artist", artistId: "artist-1", duration: 240, suffix: "mp3" },
      ] } } });
    }
    assert.equal(url.searchParams.get("id"), "song-1");
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
  };
  const manifest = await importNavidromePlaylist(
    { endpoint: "https://navidrome.example/subpath", username: "test-user", password: "test-password", fetcher: fakeFetch },
    "playlist-1", directory,
    { id: "night", eventBrief: "House", startsAt: "2026-10-01T20:00:00Z", plannedEnd: "2026-10-02T00:00:00Z" },
  );
  assert.deepEqual(calls, ["/subpath/rest/getPlaylist.view", "/subpath/rest/download.view"]);
  assert.equal(manifest.tracks.length, 1);
  assert.equal(manifest.tracks[0]?.genre, "House");
  assert.deepEqual([...await readFile(join(directory, manifest.tracks[0]!.file))], [1, 2, 3]);
  const manifestPath = join(directory, "manifest.json");
  await saveManifest(manifest, manifestPath);
  const contents = await readFile(manifestPath, "utf8");
  assert.equal(contents.includes("test-password"), false);
  assert.equal(contents.includes("test-user"), false);
});
