import cors from "cors";
import express from "express";
import * as cheerio from "cheerio";
import type { SearchResponse, SongSearchResult, SongSource } from "../shared/types";

const PORT = Number(process.env.PORT ?? 8787);
const USER_AGENT =
  "PianoLearningApp/1.0 (+local development; educational MIDI search and practice)";

const PUBLIC_DOMAIN_PIECES: SongSearchResult[] = [
  {
    id: "695",
    source: "mutopia",
    title: "Menuet in G, BWV Anh. 114",
    artist: "J. S. Bach / Christian Petzold",
    difficulty: "Beginner",
    licenseLabel: "Public Domain",
    detailUrl: "https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=695"
  },
  {
    id: "75",
    source: "mutopia",
    title: "Menuet, BWV Anh. 114",
    artist: "J. S. Bach / Christian Petzold",
    difficulty: "Beginner",
    licenseLabel: "Public Domain",
    detailUrl: "https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=75"
  },
  {
    id: "258",
    source: "mutopia",
    title: "Menuet in G",
    artist: "J. S. Bach",
    difficulty: "Beginner",
    licenseLabel: "Public Domain",
    detailUrl: "https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=258"
  },
  {
    id: "102",
    source: "mutopia",
    title: "Menuet, BWV Anh. 114",
    artist: "J. S. Bach",
    difficulty: "Beginner",
    licenseLabel: "Public Domain",
    detailUrl: "https://www.ibiblio.org/mutopia/cgibin/piece-info.cgi?id=102"
  }
];

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/search", async (req, res) => {
  const query = String(req.query.q ?? "").trim();
  const source = normalizeSource(req.query.source);
  const page = Math.max(0, Number(req.query.page ?? 0) || 0);
  const errors: string[] = [];

  if (!query) {
    const response: SearchResponse = {
      results: [],
      source,
      query,
      page
    };
    res.json(response);
    return;
  }

  if (isMidiUrl(query)) {
    const response: SearchResponse = {
      results: [
        {
          id: encodeURIComponent(query),
          source: "direct",
          title: readableTitleFromUrl(query),
          licenseLabel: "External MIDI URL",
          detailUrl: query
        }
      ],
      source,
      query,
      page
    };
    res.json(response);
    return;
  }

  const providers = source === "all" ? ["bitmidi", "mutopia"] : [source];
  const chunks = await Promise.all(
    providers.map(async (provider) => {
      try {
        if (provider === "bitmidi") return await searchBitMidi(query, page);
        if (provider === "mutopia") return searchMutopia(query);
        return [];
      } catch (error) {
        errors.push(`${provider}: ${error instanceof Error ? error.message : "search failed"}`);
        return [];
      }
    })
  );

  const response: SearchResponse = {
    results: dedupeResults(chunks.flat()).slice(0, 60),
    source,
    query,
    page,
    errors: errors.length ? errors : undefined
  };
  res.json(response);
});

app.get("/api/midi", async (req, res) => {
  const source = normalizeSource(req.query.source);
  const id = String(req.query.id ?? "").trim();
  const url = String(req.query.url ?? "").trim();

  try {
    const midiUrl = await resolveMidiUrl(source, id, url);
    const response = await fetch(midiUrl, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "audio/midi, audio/x-midi, application/octet-stream, */*"
      }
    });

    if (!response.ok) {
      res.status(response.status).json({ error: `MIDI download failed (${response.status})` });
      return;
    }

    const contentType = response.headers.get("content-type") ?? "audio/midi";
    const filename = filenameFromUrl(midiUrl) ?? `${id || "song"}.mid`;
    const buffer = Buffer.from(await response.arrayBuffer());

    res.setHeader("content-type", contentType.includes("html") ? "audio/midi" : contentType);
    res.setHeader("content-disposition", `inline; filename="${sanitizeFilename(filename)}"`);
    res.setHeader("cache-control", "public, max-age=3600");
    res.send(buffer);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not resolve MIDI" });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Piano API listening on http://127.0.0.1:${PORT}`);
});

function normalizeSource(value: unknown): SongSource | "all" {
  const source = String(value ?? "all").toLowerCase();
  if (source === "bitmidi" || source === "mutopia" || source === "direct") {
    return source;
  }
  return "all";
}

async function searchBitMidi(query: string, page: number): Promise<SongSearchResult[]> {
  const url = new URL("https://bitmidi.com/search");
  url.searchParams.set("q", query);
  if (page > 0) url.searchParams.set("page", String(page));

  const html = await fetchText(url.toString());
  const $ = cheerio.load(html);
  const results: SongSearchResult[] = [];

  $("a[href]").each((_index, element) => {
    const title = $(element).text().replace(/\s+/g, " ").trim();
    const href = $(element).attr("href") ?? "";

    if (!title.toLowerCase().endsWith(".mid")) return;
    if (!href.startsWith("/") || href.includes("/uploads/")) return;

    const id = href.replace(/^\/+|\/+$/g, "");
    if (!id || id === "random") return;

    results.push({
      id,
      source: "bitmidi",
      title,
      licenseLabel: "External archive",
      detailUrl: `https://bitmidi.com/${id}`
    });
  });

  return results.slice(0, 24);
}

function searchMutopia(query: string): SongSearchResult[] {
  const needle = query.toLowerCase();
  return PUBLIC_DOMAIN_PIECES.filter((piece) =>
    `${piece.title} ${piece.artist ?? ""} ${piece.difficulty ?? ""}`.toLowerCase().includes(needle)
  );
}

async function resolveMidiUrl(source: SongSource | "all", id: string, directUrl: string): Promise<string> {
  if (source === "direct") {
    const decoded = decodeURIComponent(id || directUrl);
    return validateRemoteMidiUrl(decoded);
  }

  if (directUrl && isMidiUrl(directUrl)) {
    return validateRemoteMidiUrl(directUrl);
  }

  if (source === "bitmidi") {
    if (!id) throw new Error("Missing BitMidi id");
    const html = await fetchText(`https://bitmidi.com/${encodeURIComponent(id)}`);
    const $ = cheerio.load(html);
    const href =
      $("a[href*='/uploads/']").first().attr("href") ??
      $("a[href$='.mid']").first().attr("href") ??
      $("a[href$='.midi']").first().attr("href");

    if (!href) throw new Error("Could not find BitMidi download link");
    return validateRemoteMidiUrl(new URL(href, "https://bitmidi.com").toString());
  }

  if (source === "mutopia") {
    const piece = PUBLIC_DOMAIN_PIECES.find((entry) => entry.id === id);
    const detailUrl = piece?.detailUrl;
    if (!detailUrl) throw new Error("Unknown Mutopia piece");

    const html = await fetchText(detailUrl);
    const $ = cheerio.load(html);
    let href: string | undefined;
    $("a[href]").each((_index, element) => {
      const label = $(element).text().toLowerCase();
      const candidate = $(element).attr("href");
      if (!href && candidate && (label.includes("midi") || /\.mid(i)?(\?|$)/i.test(candidate))) {
        href = candidate;
      }
    });

    if (!href) throw new Error("Could not find Mutopia MIDI link");
    return validateRemoteMidiUrl(new URL(href, detailUrl).toString());
  }

  throw new Error("Unsupported MIDI source");
}

function dedupeResults(results: SongSearchResult[]): SongSearchResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = `${result.source}:${result.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });

  if (!response.ok) throw new Error(`request failed (${response.status})`);
  return response.text();
}

function isMidiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && /\.(mid|midi)(\?|$)/i.test(url.pathname + url.search);
  } catch {
    return false;
  }
}

function validateRemoteMidiUrl(value: string): string {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http/https MIDI URLs are supported");
  if (!/\.(mid|midi)(\?|$)/i.test(url.pathname + url.search)) {
    throw new Error("URL must point to a .mid or .midi file");
  }

  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".local") ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  ) {
    throw new Error("Local or private MIDI URLs are not proxied");
  }

  return url.toString();
}

function readableTitleFromUrl(value: string): string {
  const name = filenameFromUrl(value) ?? "External MIDI";
  return decodeURIComponent(name).replace(/[-_]+/g, " ");
}

function filenameFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.pathname.split("/").filter(Boolean).at(-1);
  } catch {
    return undefined;
  }
}

function sanitizeFilename(value: string): string {
  return value.replace(/["<>:|?*\u0000-\u001f]/g, "_").slice(0, 120);
}
