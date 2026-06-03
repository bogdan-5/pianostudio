import { searchSongs } from "../server/songService";
import { rejectUnsupportedMethod, type VercelRequest, type VercelResponse } from "../server/vercelHttp";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (rejectUnsupportedMethod(req, res)) return;

  const response = await searchSongs(req.query.q, req.query.source, req.query.page);
  res.status(200).json(response);
}
