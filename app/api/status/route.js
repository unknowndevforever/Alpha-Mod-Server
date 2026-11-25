import { getGame } from "../../../lib/game.js";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json((await getGame()).status(), { headers: { "cache-control": "no-store" } });
}
