export async function controller(
  path: string,
  body?: unknown,
): Promise<Response> {
  const url = new URL(
    path,
    process.env.CONTROLLER_URL ?? "http://127.0.0.1:8787",
  );
  return fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPERATOR_PASSWORD ?? ""}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(path === "/request" ? 120000 : path === "/announce" ? 90000 : 5000),
  });
}
