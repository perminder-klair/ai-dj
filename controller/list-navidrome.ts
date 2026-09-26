import { listNavidromePlaylists } from "./navidrome.ts";

const endpoint = process.env.NAVIDROME_URL;
const username = process.env.NAVIDROME_USER;
const password = process.env.NAVIDROME_PASSWORD;

if (!endpoint || !username || !password) {
  console.error("Set NAVIDROME_URL, NAVIDROME_USER, and NAVIDROME_PASSWORD");
  process.exitCode = 1;
} else {
  listNavidromePlaylists({ endpoint, username, password })
    .then((playlists) => console.log(JSON.stringify(playlists, null, 2)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "Could not list Navidrome playlists");
      process.exitCode = 1;
    });
}
