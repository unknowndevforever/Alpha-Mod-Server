import { getGame } from "../../../lib/game.js";

export const dynamic = "force-dynamic";

export async function GET() {
  const game = await getGame();
  return Response.json(await game.run(() => game.status(), true), { headers: { "cache-control": "no-store" } });
}
