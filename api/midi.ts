import { fetchMidiFile } from "../server/songService.js";
import { rejectUnsupportedMethod, type VercelRequest, type VercelResponse } from "../server/vercelHttp.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (rejectUnsupportedMethod(req, res)) return;

  try {
    const file = await fetchMidiFile({
      source: req.query.source,
      id: req.query.id,
      url: req.query.url
    });

    res.setHeader("content-type", file.contentType);
    res.setHeader("content-disposition", `inline; filename="${file.filename}"`);
    res.setHeader("cache-control", "public, max-age=3600");
    res.status(200).send(file.buffer);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not resolve MIDI" });
  }
}
