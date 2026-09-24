import * as cheerio from "cheerio";
import { bitMidiSearchUrl, parseBitMidiSearchResponse } from "../shared/bitmidi.js";
import type { SearchResponse, SongSearchResult, SongSource } from "../shared/types";

const USER_AGENT =
  "pianostudio/1.0 (+local development; educational MIDI search and practice)";
const FREEMIDI_ORIGIN = "https://freemidi.org";

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

export interface MidiFileResponse {
  buffer: Buffer;
  contentType: string;
  filename: string;
}

export function healthResponse(): { ok: true } {
  return { ok: true };
}

export async function searchSongs(
  queryValue: unknown,
  sourceValue: unknown,
  pageValue: unknown
): Promise<SearchResponse> {
  const query = firstQueryValue(queryValue).trim();
  const source = normalizeSource(sourceValue);
  const page = Math.max(0, Number(firstQueryValue(pageValue) || 0) || 0);
  const errors: string[] = [];

  if (!query) {
    return {
      results: [],
      source,
      query,
      page
    };
  }

  if (isMidiUrl(query)) {
    return {
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
  }

  const providers: SongSource[] =
    source === "all" ? ["bitmidi", "freemidi", "mutopia"] : [source];
  const chunks = await Promise.all(
    providers.map(async (provider) => {
      try {
        if (provider === "bitmidi") return await searchBitMidi(query, page);
        if (provider === "freemidi") return await searchFreeMidi(query);
        if (provider === "mutopia") return searchMutopia(query);
        return [];
      } catch (error) {
        errors.push(`${provider}: ${error instanceof Error ? error.message : "search failed"}`);
        return [];
      }
    })
  );

  return {
    results: dedupeResults(chunks.flat()).slice(0, 60),
    source,
    query,
    page,
    errors: errors.length ? errors : undefined
  };
}

export async function fetchMidiFile(input: {
  source: unknown;
  id: unknown;
  url?: unknown;
}): Promise<MidiFileResponse> {
  const source = normalizeSource(input.source);
  const id = firstQueryValue(input.id).trim();
  const url = firstQueryValue(input.url).trim();

  if (source === "freemidi") return fetchFreeMidiFile(id);

  const midiUrl = await resolveMidiUrl(source, id, url);
  const response = await fetch(midiUrl, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "audio/midi, audio/x-midi, application/octet-stream, */*"
    }
  });

  if (!response.ok) {
    throw new Error(`MIDI download failed (${response.status})`);
  }

  const contentType = response.headers.get("content-type") ?? "audio/midi";
  const filename = filenameFromUrl(midiUrl) ?? `${id || "song"}.mid`;

  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: contentType.includes("html") ? "audio/midi" : contentType,
    filename: sanitizeFilename(filename)
  };
}

function firstQueryValue(value: unknown): string {
  if (Array.isArray(value)) return firstQueryValue(value[0]);
  return String(value ?? "");
}

function normalizeSource(value: unknown): SongSource | "all" {
  const source = firstQueryValue(value).toLowerCase();
  if (
    source === "bitmidi" ||
    source === "freemidi" ||
    source === "mutopia" ||
    source === "direct"
  ) {
    return source;
  }
  return "all";
}

async function searchBitMidi(query: string, page: number): Promise<SongSearchResult[]> {
  const response = await fetch(bitMidiSearchUrl(query, page), {
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/json"
    }
  });

  if (!response.ok) throw new Error(`request failed (${response.status})`);
  return parseBitMidiSearchResponse(await response.json()).slice(0, 24);
}

async function searchFreeMidi(query: string): Promise<SongSearchResult[]> {
  const html = await fetchText(`${FREEMIDI_ORIGIN}/search?q=${encodeURIComponent(query)}`);
  const $ = cheerio.load(html);
  const results: SongSearchResult[] = [];
  const seen = new Set<string>();

  $("h5.card-title a[href]").each((_index, element) => {
    if (results.length >= 24) return false;

    const href = $(element).attr("href")?.trim() ?? "";
    const id = href.replace(/^\//, "");
    if (!/^download3-\d+(?:-|$)/i.test(id) || seen.has(id)) return;

    const card = $(element).closest(".card");
    const title = ($(element).attr("title") ?? $(element).text()).trim();
    const artist = card.find("a[href*='artist-']").first().text().trim();
    if (!title) return;

    seen.add(id);
    results.push({
      id,
      source: "freemidi",
      title,
      artist: artist || undefined,
      licenseLabel: "External archive",
      detailUrl: new URL(href, FREEMIDI_ORIGIN).toString()
    });
  });

  return results;
}

async function fetchFreeMidiFile(id: string): Promise<MidiFileResponse> {
  const match = /^download3-(\d+)(?:-|$)/i.exec(id);
  if (!match) throw new Error("Invalid FreeMidi id");

  const detailUrl = `${FREEMIDI_ORIGIN}/${encodeURIComponent(id)}`;
  const response = await fetch(`${FREEMIDI_ORIGIN}/getter-${match[1]}`, {
    redirect: "manual",
    headers: {
      "user-agent": USER_AGENT,
      referer: detailUrl,
      accept: "audio/midi, audio/x-midi, application/octet-stream, */*"
    }
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  if ((response.status !== 200 && response.status !== 302) || buffer.subarray(0, 4).toString("ascii") !== "MThd") {
    throw new Error(`FreeMidi download failed (${response.status})`);
  }

  const disposition = response.headers.get("content-disposition") ?? "";
  const dispositionName = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
  return {
    buffer,
    contentType: "audio/midi",
    filename: sanitizeFilename(dispositionName ?? `${id}.mid`)
  };
}

function searchMutopia(query: string): SongSearchResult[] {
  const needle = query.toLowerCase();
  return PUBLIC_DOMAIN_PIECES.filter((piece) =>
    `${piece.title} ${piece.artist ?? ""} ${piece.difficulty ?? ""}`.toLowerCase().includes(needle)
  );
}

async function resolveMidiUrl(
  source: SongSource | "all",
  id: string,
  directUrl: string
): Promise<string> {
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
