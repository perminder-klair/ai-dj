"""Create the original, eight-bar preview loop with Python and ffmpeg."""

from array import array
from math import exp, pi, sin, tanh
from pathlib import Path
from random import Random
from struct import pack
from subprocess import run
from tempfile import TemporaryDirectory
from wave import open as wave_open

RATE = 22_050
BPM = 120
BEAT = 60 / BPM
SECONDS = 16
SAMPLES = RATE * SECONDS
audio = array("f", [0.0]) * SAMPLES
noise = Random(42)


def add(t: float, duration: float, voice) -> None:
    first = round(t * RATE)
    count = min(round(duration * RATE), SAMPLES - first)
    for n in range(max(0, count)):
        audio[first + n] += voice(n / RATE)


def hz(midi: int) -> float:
    return 440 * 2 ** ((midi - 69) / 12)


# Am9, Fmaj7, Cmaj9, G6. Each chord lasts two bars.
chords = [
    (45, (57, 60, 64, 67, 71)),
    (41, (53, 57, 60, 64, 69)),
    (48, (55, 59, 62, 64, 67)),
    (43, (55, 59, 62, 64, 69)),
]

for block, (root, notes) in enumerate(chords):
    start = block * 4
    for note in notes:
        frequency = hz(note)

        def pad(t: float, frequency=frequency) -> float:
            envelope = min(1, t / 0.09) * min(1, (3.8 - t) / 0.35)
            return 0.021 * max(0, envelope) * (
                sin(2 * pi * frequency * t)
                + 0.22 * sin(2 * pi * frequency * 1.003 * t)
            )

        add(start, 3.8, pad)

    for beat in range(8):
        note = root + (7 if beat % 4 == 3 else 0)
        frequency = hz(note)

        def bass(t: float, frequency=frequency) -> float:
            envelope = exp(-8 * t) * min(1, t / 0.012)
            return 0.24 * envelope * (
                sin(2 * pi * frequency * t)
                + 0.15 * sin(4 * pi * frequency * t)
            )

        add(start + beat * BEAT, 0.44, bass)

for beat in range(32):
    at = beat * BEAT

    def kick(t: float) -> float:
        phase = 2 * pi * (48 * t + 68 * (1 - exp(-28 * t)) / 28)
        return 0.55 * exp(-14 * t) * sin(phase)

    add(at, 0.35, kick)

    if beat % 4 in (1, 3):
        clap_samples = [noise.uniform(-1, 1) for _ in range(round(0.13 * RATE))]

        def clap(t: float, samples=clap_samples) -> float:
            index = min(len(samples) - 1, int(t * RATE))
            return 0.09 * exp(-26 * t) * samples[index]

        add(at, 0.13, clap)

for eighth in range(64):
    at = eighth * BEAT / 2
    hat_samples = [noise.uniform(-1, 1) for _ in range(round(0.09 * RATE))]

    def hat(t: float, samples=hat_samples, accent=eighth % 2) -> float:
        index = min(len(samples) - 1, int(t * RATE))
        return (0.038 if accent else 0.023) * exp(-48 * t) * samples[index]

    add(at, 0.09, hat)

output = Path(__file__).resolve().parents[1] / "public" / "demo-loop.mp3"
output.parent.mkdir(parents=True, exist_ok=True)
with TemporaryDirectory() as temporary:
    wav = Path(temporary) / "loop.wav"
    with wave_open(str(wav), "wb") as file:
        file.setnchannels(1)
        file.setsampwidth(2)
        file.setframerate(RATE)
        file.writeframes(b"".join(pack("<h", round(27_000 * tanh(sample))) for sample in audio))
    run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(wav),
         "-codec:a", "libmp3lame", "-b:a", "128k", str(output)],
        check=True,
    )
print(output)
