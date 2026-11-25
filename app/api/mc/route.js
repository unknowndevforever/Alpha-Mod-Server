import { getGame } from "../../../lib/game.js";

export const dynamic = "force-dynamic";

// The game client's HTTP tunnel (HttpSocket.java):
//   POST /api/mc?op=open           -> session id (text)
//   POST /api/mc?sid=ID  body=bytes -> bytes the server queued for this client (410 = session over)
//   POST /api/mc?op=close&sid=ID
export async function POST(req) {
  const game = await getGame();
  const url = new URL(req.url);
  const op = url.searchParams.get("op"), sid = url.searchParams.get("sid");
  if (op === "open") {
    const id = game.open();
    if (!id) return new Response("server full", { status: 503 });
    return new Response(id, { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
  }
  if (!sid) return new Response("missing sid", { status: 400 });
  if (op === "close") { game.close(sid); return new Response("ok"); }
  const body = new Uint8Array(await req.arrayBuffer());
  const out = game.poll(sid, body);
  if (out === null) return new Response("gone", { status: 410 });
  return new Response(out, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
}
