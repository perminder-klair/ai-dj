import { NextRequest, NextResponse } from "next/server";
import { authorized } from "@/lib/auth";
import { controller } from "@/lib/controller";

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const query = request.nextUrl.searchParams.get("q") ?? "";
  if (query.trim().length < 2 || query.length > 120)
    return NextResponse.json({ error: "Search must be 2–120 characters" }, { status: 400 });
  try {
    const upstream = await controller(`/library-search?q=${encodeURIComponent(query)}`);
    return NextResponse.json(await upstream.json(), { status: upstream.status, headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Library search unavailable" }, { status: 503 });
  }
}
