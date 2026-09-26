import { NextRequest, NextResponse } from "next/server";
import { authorized, sameOrigin } from "@/lib/auth";
import { controller } from "@/lib/controller";

const COMMANDS = new Set([
  "start",
  "resume",
  "stop",
  "skip",
  "mute",
  "steer",
  "queue",
  "force-next",
  "replace",
  "reorder",
  "extend",
  "request",
  "announce",
]);

export async function POST(request: NextRequest) {
  if (!authorized(request))
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  if (!sameOrigin(request))
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { command, ...body } = input as Record<string, unknown>;
  if (typeof command !== "string" || !COMMANDS.has(command))
    return NextResponse.json({ error: "Unknown command" }, { status: 400 });
  try {
    const upstream = await controller(`/${command}`, body);
    return NextResponse.json(await upstream.json(), {
      status: upstream.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      {
        error:
          "Controller unavailable. Check the connection before trying again.",
      },
      { status: 503 },
    );
  }
}
