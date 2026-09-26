import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { authorized } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }

  if (process.env.DEMO_AUDIO === "1") {
    const bytes = await readFile(
      join(process.cwd(), "public", "demo-loop.mp3"),
    );
    return new Response(new Uint8Array(bytes), {
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
    });
  }

  try {
    const upstream = await fetch(
      process.env.STREAM_URL ?? "http://icecast:8000/live.mp3",
      {
        cache: "no-store",
        signal: request.signal,
      },
    );
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json(
        { error: "Venue stream unavailable" },
        { status: 503 },
      );
    }
    return new Response(upstream.body, {
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") ?? "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Venue stream unavailable" },
      { status: 503 },
    );
  }
}
