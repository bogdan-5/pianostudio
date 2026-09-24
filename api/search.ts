import { searchSongs } from "../server/songService.js";
import { rejectUnsupportedMethod, type VercelRequest, type VercelResponse } from "../server/vercelHttp.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (rejectUnsupportedMethod(req, res)) return;

  const response = await searchSongs(req.query.q, req.query.source, req.query.page);
  res.setHeader(
    "cache-control",
    response.errors?.length
      ? "no-store"
      : "public, s-maxage=900, stale-while-revalidate=86400"
  );
  res.status(200).json(response);
}
