# Approved local files only. The controller publishes a full remaining schedule.
settings.server.telnet := false

state_dir = "/state"
def planned_end() =
  end_file = "#{state_dir}/planned-end.txt"
  if file.exists(end_file) then string.to_float(string.trim(file.contents(end_file))) else 0.0 end
end
def can_run() =
  file.exists("#{state_dir}/run.flag") and
  file.contents("#{state_dir}/run.flag") == file.contents("/proc/sys/kernel/random/boot_id")
end
music_queue = request.queue(id="music_queue", interactive=false, prefetch=1)
loaded_schedule = ref("")
loaded_skip = ref(if file.exists("#{state_dir}/skip.request") then file.contents("#{state_dir}/skip.request") else "" end)
loaded_stop = ref("")
fade_mode = ref("none")
fade_started = ref(0.0)

def gain() =
  elapsed = time() - fade_started()
  if fade_mode() == "skip_out" or fade_mode() == "stop_out" then
    if elapsed >= 2.0 then 0.0 else 1.0 - elapsed / 2.0 end
  else
    if fade_mode() == "skip_in" and elapsed < 2.0 then elapsed / 2.0 else 1.0 end
  end
end

def check_commands() =
  stop_file = "#{state_dir}/stop.request"
  skip_file = "#{state_dir}/skip.request"
  if file.exists(stop_file) and file.contents(stop_file) != loaded_stop() then
    loaded_stop := file.contents(stop_file)
    fade_started := time()
    fade_mode := "stop_out"
  else
    if file.exists(skip_file) and file.contents(skip_file) != loaded_skip() and fade_mode() != "stop_out" then
      loaded_skip := file.contents(skip_file)
      fade_started := time()
      fade_mode := "skip_out"
    end
  end
  if fade_mode() == "skip_out" and time() - fade_started() >= 2.0 then
    music_queue.skip()
    fade_started := time()
    fade_mode := "skip_in"
  end
  if fade_mode() == "skip_in" and time() - fade_started() >= 2.0 then
    fade_mode := "none"
  end
end
thread.run(every=0.1, check_commands)

def load_schedule() =
  schedule_file = "#{state_dir}/schedule.m3u"
  if can_run() and file.exists(schedule_file) then
    if time() >= planned_end() then
      music_queue.set_queue([])
      loaded_schedule := ""
    else
      contents = file.contents(schedule_file)
      if contents != loaded_schedule() then
        uris = process.read.lines("/bin/sh /etc/liquidsoap/filter-schedule.sh")
        requests = list.map(fun (uri) -> request.create(uri), uris)
        music_queue.set_queue(requests)
        loaded_schedule := contents
        log("Loaded #{list.length(uris)} remaining tracks")
      end
    end
  end
end
thread.run(every=0.5, load_schedule)

music = music_queue
music_queue.on_position(position=5.0, remaining=true, synchronous=false, fun (_, m) ->
  file.write(
    data=json.stringify(compact=true, { filename = m["filename"], at = time() }),
    atomic=true,
    temp_dir=state_dir,
    "#{state_dir}/committed.json"
  )
)
music = crossfade(duration=5.0, music)
music = switch(track_sensitive=false, [({can_run()}, music)])
music = amplify(gain, music)
music.on_metadata(synchronous=false, fun (m) ->
  begin
  fname = m["filename"]
  file.write(data="#{fname}\n", append=true, "#{state_dir}/played.txt")
  file.write(
    data=json.stringify(compact=true, {
      filename = fname,
      startedAt = time()
    }),
    atomic=true,
    temp_dir=state_dir,
    "#{state_dir}/now-playing.json"
  )
  end
)
speech_queue = request.queue(id="speech_queue", interactive=false, prefetch=1)
loaded_speech = ref(if file.exists("#{state_dir}/speech-next.txt") then file.contents("#{state_dir}/speech-next.txt") else "" end)
def speech_allowed() =
  can_run() and file.exists("#{state_dir}/speech-muted.txt") and
  file.contents("#{state_dir}/speech-muted.txt") == "0\n"
end
def load_speech() =
  speech_file = "#{state_dir}/speech-next.txt"
  if file.exists(speech_file) then
    contents = file.contents(speech_file)
    if contents != loaded_speech() then
      loaded_speech := contents
      if speech_allowed() then
        speech_queue.push(request.create(string.trim(contents)))
      end
    end
  end
end
thread.run(every=0.5, load_speech)
speech = switch(track_sensitive=false, [({speech_allowed()}, speech_queue)])
music = amplify(fun () -> if speech.is_ready() then 0.12 else 1.0 end, music)
music = add(normalize=false, [music, speech])
output.icecast(
  %mp3(bitrate=192, samplerate=44100, stereo=true),
  fallible=true,
  host="icecast",
  port=8000,
  password=environment.get("ICECAST_SOURCE_PASSWORD"),
  mount="/live.mp3",
  name="DJ Hero",
  music
)
