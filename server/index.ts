import cors from "cors";
import express from "express";
import { fetchMidiFile, healthResponse, searchSongs } from "./songService";

const PORT = Number(process.env.PORT ?? 8787);

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json(healthResponse());
});

app.get("/api/search", async (req, res) => {
  const response = await searchSongs(req.query.q, req.query.source, req.query.page);
  res.json(response);
});

app.get("/api/midi", async (req, res) => {
  try {
    const file = await fetchMidiFile({
      source: req.query.source,
      id: req.query.id,
      url: req.query.url
    });

    res.setHeader("content-type", file.contentType);
    res.setHeader("content-disposition", `inline; filename="${file.filename}"`);
    res.setHeader("cache-control", "public, max-age=3600");
    res.send(file.buffer);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not resolve MIDI" });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Piano API listening on http://127.0.0.1:${PORT}`);
});
