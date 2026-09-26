# AI DJ

An autonomous music selector and occasional spoken host for a nightclub event, using Navidrome, GPT-6-Luna, ElevenLabs, Next.js, Liquidsoap, and Icecast.

Preparation freezes a Navidrome playlist into a local event pool. The controller checks pool membership, repeats, and a 30-minute artist gap before publishing a queue. Operators can also search the whole Navidrome library and queue a validated request outside the playlist; the autonomous selector never chooses these request-only tracks. Liquidsoap plays local files through Icecast, reports actual starts, and continues through its loaded fallback queue if the controller disconnects. Preparation requires coverage for the event plus 15 minutes, capped at five hours.

## Prepare an event

Requires Node 26, pnpm, `ffprobe`, Docker Compose, and enough approved music for the planned duration plus 15 minutes (up to five hours). Create `event-settings.json`:

```json
{
  "id": "rehearsal-1",
  "eventBrief": "Warm house, then higher energy after 10pm",
  "startsAt": "2026-10-01T20:00:00+01:00",
  "plannedEnd": "2026-10-02T00:00:00+01:00"
}
```

Import a Navidrome playlist. The importer downloads its original audio files into the music directory and writes a manifest without credentials. You can instead write the manifest yourself; each track needs `id`, `artistId`, `artist`, `title`, `durationMs`, and a `file` path relative to the music directory.

```sh
pnpm install
export NAVIDROME_URL=https://your-navidrome.example
export NAVIDROME_USER=your-user
export NAVIDROME_PASSWORD=your-password
pnpm list:navidrome # find the playlist ID; prints metadata only
pnpm import:navidrome PLAYLIST_ID /absolute/path/to/music ./event-settings.json ./event-manifest.json
pnpm prepare ./event-manifest.json /absolute/path/to/music /absolute/path/to/new-state
cp .env.example .env
```

Use a new state directory for each event. Set `MUSIC_DIR`, `STATE_DIR`, three distinct passwords, `NAVIDROME_URL`, `NAVIDROME_USER`, `NAVIDROME_PASSWORD`, and `VENUE_UID`/`VENUE_GID` in `.env`. On Linux, `id -u` and `id -g` provide the IDs; both services need write access to the state directory, and the controller needs write access to the music directory for requests. Set `OPENAI_API_KEY` to enable GPT-6-Luna track selection and DJ scripts. Set `ELEVENLABS_API_KEY` to render the scripts with voice `xB7ZTAdAjd7cI20IXiAL`. With either key absent, speech stays off. Set `ICECAST_PORT` and `CONTROLLER_PORT` if the defaults conflict.

```sh
docker compose up -d --build
```

Open the operator deck at `http://<venue-machine>:3000` and sign in with `OPERATOR_PASSWORD`. It shows the current record, progress, queue, recent plays, and controller warnings. Operators can start, resume, stop, skip, mute speech, steer the selector, and browse the event pool or search the entire Navidrome library for a request. A whole-library song is downloaded and checked before it enters the queue; repeats and artist spacing still apply. The web service keeps the password in an HTTP-only session cookie and sends commands to the controller from the server. Set `WEB_PORT` if port 3000 conflicts; restrict access to the venue network or a trusted VPN.

Press **Listen** beside the transport controls to monitor the Icecast stream in that browser. Browser playback starts only after the button is pressed; the operator deck does not automatically play audio. The venue player remains the main sound output. For an interface-only preview without a prepared event, set `DEMO_AUDIO=1` when starting the web service to play the original bundled 16-second loop instead of Icecast. The loop can be regenerated with `python web/scripts/generate-demo-loop.py` and `ffmpeg`.

To run the interface without Compose, start the controller and then run `cd web && npm ci && OPERATOR_PASSWORD=your-password CONTROLLER_URL=http://127.0.0.1:8787 STREAM_URL=http://127.0.0.1:8000/live.mp3 npm run dev`. Open `http://localhost:3000`.

The controller listens on `127.0.0.1:8787` by default. Every request requires `Authorization: Bearer <OPERATOR_PASSWORD>`. For example, queue a track before starting, then inspect the state:

```sh
export OPERATOR_PASSWORD=the-value-you-set-in-.env
curl -X POST http://127.0.0.1:8787/queue \
  -H "Authorization: Bearer $OPERATOR_PASSWORD" \
  -H 'Content-Type: application/json' \
  -d '{"trackId":"navidrome-track-id","source":"operator"}'
curl -X POST http://127.0.0.1:8787/start -H "Authorization: Bearer $OPERATOR_PASSWORD"
curl http://127.0.0.1:8787/state -H "Authorization: Bearer $OPERATOR_PASSWORD"
mpv http://127.0.0.1:8000/live.mp3
```

With an API key, the controller starts selecting while the event is prepared and keeps up to two choices queued. Wait for `/state` to show those choices if you want the first track selected by the model; starting immediately may play the prepared local fallback first. Each selection uses up to six pool/history tool calls and has a 30-second deadline. The controller validates the returned ID against the frozen pool, history, artist gap, and current queue. Operator edits or steering received during a model call make its result stale and discard it. API errors leave the local schedule playing and retry in the background with backoff; the event state records a warning.

The venue player should consume the Icecast URL on the dedicated audio machine. `/force-next` accepts `{"trackId":"..."}`; `/replace` accepts an `index` and `trackId`; `/reorder` accepts an `order` array of current queue indices. `/steer` accepts an `instruction`, `/mute` accepts `muted`, and `/extend` accepts a later `plannedEndMs`. `/skip` fades the current track for two seconds and advances; `/stop` fades it out over two seconds and ends the event. These commands use `POST` with JSON bodies and the same bearer token. Operator choices may override artist spacing with `{"operatorOverride":{"allowArtistSpacing":true}}`. Repeat overrides are not available through the live venue pipeline yet.

The local schedule contains the validated queue followed by eligible unused fallback tracks. Liquidsoap reloads it on edits, records played paths in `played.txt`, and writes `now-playing.json`; the controller copies actual playback into `event.json`. Liquidsoap marks the incoming choice committed near the crossfade, preventing late replacement. Both controller and mixer enforce the planned end: it blocks new track starts, the current track finishes, and the controller marks the event stopped when available. The stream also ends when unique prepared tracks are exhausted.

On a mixer restart, played paths are filtered from the schedule and playback continues with a fresh track. The services restart automatically after a service failure. After a full machine reboot, playback stays paused until an operator sends `POST /resume`; the interrupted track and stale queue are discarded. Extend the event first if its planned end has passed. Stop the event before shutting down services if it should stay silent on the next service start.

Run `pnpm test`, `pnpm typecheck`, `npm --prefix web run typecheck`, `npm --prefix web run build`, and `docker compose config --quiet` after changes. Liquidsoap can be checked with `docker run --rm -v "$PWD/audio/radio.liq:/radio.liq:ro" savonet/liquidsoap:v2.4.5 --check /radio.liq`.

DJ speech is generated after playback starts and roughly every ten minutes, with a **Speak** control for a manual line. Liquidsoap overlays the voice and reduces music volume while it plays. A full venue rehearsal is still needed to measure timing and mix levels.

- [Agreed design and acceptance checks](docs/design-interview.md)
- [Domain glossary](CONTEXT.md)
- [Decision: approved event pool](docs/adr/0001-event-pool-selection.md)
- [Decision: offline venue preparation](docs/adr/0002-prepare-music-for-offline-playback.md)
- [Decision: independent playback controller](docs/adr/0003-separate-controller-from-web-interface.md)
