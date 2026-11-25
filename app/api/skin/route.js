import { getGame } from "../../../lib/game.js";

export const dynamic = "force-dynamic";

const NAME = /^[A-Za-z0-9_]{1,16}$/;

// GET /api/skin?name=NAME -> that player's skin PNG (404 = default skin)
export async function GET(req) {
  const name = new URL(req.url).searchParams.get("name") || "";
  if (!NAME.test(name)) return new Response("bad name", { status: 400 });
  const png = (await getGame()).skin(name);
  if (!png) return new Response("no skin", { status: 404 });
  return new Response(png, { headers: { "content-type": "image/png", "cache-control": "no-cache" } });
}

// POST /api/skin?name=NAME, body = 64x32 PNG (the game uploads it when it connects)
export async function POST(req) {
  const name = new URL(req.url).searchParams.get("name") || "";
  if (!NAME.test(name)) return new Response("bad name", { status: 400 });
  const png = new Uint8Array(await req.arrayBuffer());
  if (png.length > 64 * 1024) return new Response("too big", { status: 413 });
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (png.length < 24 || sig.some((b, i) => png[i] !== b)) return new Response("not a png", { status: 400 });
  const dv = new DataView(png.buffer, png.byteOffset);
  if (dv.getUint32(16) !== 64 || dv.getUint32(20) !== 32) return new Response("skin must be 64x32", { status: 400 });
  (await getGame()).setSkin(name, png);
  return new Response("ok");
}
