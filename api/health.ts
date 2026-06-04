import { healthResponse } from "../server/songService.js";
import { rejectUnsupportedMethod, type VercelRequest, type VercelResponse } from "../server/vercelHttp.js";

export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (rejectUnsupportedMethod(req, res)) return;
  res.status(200).json(healthResponse());
}
