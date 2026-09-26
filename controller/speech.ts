import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { EventState } from "./event.ts";
import { atomicWrite } from "./prepare.ts";

export interface SpeechConfig {
  openaiKey: string;
  elevenlabsKey: string;
  voiceId: string;
  model: string;
}

function outputText(payload: unknown): string {
  const response = payload as { output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> };
  return response.output?.flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text!.trim()).join(" ").trim() ?? "";
}

export async function generateDjScript(state: EventState, config: SpeechConfig): Promise<string> {
  const current = state.pool.find((track) => track.id === state.current?.trackId);
  const next = state.pool.find((track) => track.id === state.upcoming[0]?.trackId);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${config.openaiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.model, max_output_tokens: 140,
      instructions: "You are Marlowe, a warm, sharp nightclub radio DJ. Write one natural spoken line of 15–35 words. Keep it upbeat and specific to the supplied music. No invented facts, listener names, emojis, stage directions, or quoted lyrics. Output only the line to speak.",
      input: `Event: ${state.eventBrief}\nPlaying: ${current ? `${current.title} by ${current.artist}` : "opening the set"}\nUp next: ${next ? `${next.title} by ${next.artist}` : "not yet selected"}\nOperator direction: ${state.steering.at(-1) ?? "none"}` }),
  });
  if (!response.ok) throw new Error(`DJ script generation failed: HTTP ${response.status}`);
  const text = outputText(await response.json());
  if (!text || text.length > 500) throw new Error("DJ script generation returned no usable text");
  return text;
}

export async function renderDjSpeech(text: string, stateDirectory: string, config: SpeechConfig): Promise<string> {
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.voiceId)}?output_format=mp3_44100_128`, {
    method: "POST", signal: AbortSignal.timeout(45_000),
    headers: { "xi-api-key": config.elevenlabsKey, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
  });
  if (!response.ok || !response.headers.get("content-type")?.includes("audio")) {
    throw new Error(`ElevenLabs speech failed: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1_000 || bytes.length > 10_000_000) throw new Error("ElevenLabs returned invalid audio size");
  const directory = resolve(stateDirectory, "speech");
  await mkdir(directory, { recursive: true });
  const name = `${randomUUID()}.mp3`;
  const temporary = resolve(directory, `${name}.part`);
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, resolve(directory, name));
  const path = `/state/speech/${name}`;
  await atomicWrite(resolve(stateDirectory, "speech-next.txt"), `${path}\n`);
  await atomicWrite(resolve(stateDirectory, "speech-last.txt"), `${text}\n`);
  return path;
}
