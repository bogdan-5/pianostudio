import type { SongSearchResult } from "./types";

type BitMidiApiItem = {
  name?: unknown;
  slug?: unknown;
  downloadUrl?: unknown;
};

type BitMidiApiResponse = {
  result?: {
    results?: unknown;
  };
};

const BITMIDI_ORIGIN = "https://bitmidi.com";

export function bitMidiSearchUrl(query: string, page: number): string {
  const url = new URL("/api/midi/search", BITMIDI_ORIGIN);
  url.searchParams.set("q", query);
  if (page > 0) url.searchParams.set("page", String(page));
  return url.toString();
}

export function parseBitMidiSearchResponse(payload: unknown): SongSearchResult[] {
  const results = (payload as BitMidiApiResponse | null)?.result?.results;
  if (!Array.isArray(results)) throw new Error("BitMidi returned an invalid search response");

  return results.flatMap((value): SongSearchResult[] => {
    const item = value as BitMidiApiItem;
    if (typeof item.name !== "string" || typeof item.slug !== "string") return [];

    const detailUrl = new URL(`/${item.slug}`, BITMIDI_ORIGIN).toString();
    const midiUrl = safeBitMidiDownloadUrl(item.downloadUrl);

    return [
      {
        id: item.slug,
        source: "bitmidi",
        title: item.name,
        licenseLabel: "External archive",
        detailUrl,
        midiUrl
      }
    ];
  });
}

function safeBitMidiDownloadUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  try {
    const url = new URL(value, BITMIDI_ORIGIN);
    if (url.origin !== BITMIDI_ORIGIN || !/^\/uploads\/[^/]+\.mid$/i.test(url.pathname)) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
