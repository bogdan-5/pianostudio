import { bitMidiSearchUrl, parseBitMidiSearchResponse } from "../../shared/bitmidi";
import type { SearchResponse, SongSearchResult } from "../../shared/types";

const BITMIDI_ATTEMPT_TIMEOUTS_MS = [4_000, 8_000];
const BITMIDI_TIMEOUT_RETRY_DELAY_MS = 1_000;
const BITMIDI_UPSTREAM_RETRY_DELAY_MS = 4_000;
const BITMIDI_CACHE_LIMIT = 40;
const bitMidiSearchCache = new Map<string, SearchResponse>();
const bitMidiSearchesInFlight = new Map<string, Promise<SearchResponse>>();

export async function searchSongs(query: string, source = "all", page = 0): Promise<SearchResponse> {
  if (source === "bitmidi" && !isMidiUrl(query)) {
    return searchBitMidi(query, page);
  }

  const params = new URLSearchParams({ q: query, source, page: String(page) });
  const response = await fetch(`/api/search?${params.toString()}`);
  if (!response.ok) throw new Error(`Search failed (${response.status})`);
  return response.json();
}

export async function downloadMidi(result: SongSearchResult): Promise<ArrayBuffer> {
  const params = new URLSearchParams({
    source: result.source,
    id: result.id
  });
  if (result.midiUrl) params.set("url", result.midiUrl);
  else if (result.source === "direct" && result.detailUrl) params.set("url", result.detailUrl);

  const response = await fetch(`/api/midi?${params.toString()}`);
  if (!response.ok) {
    const body = await response.json().catch(() => undefined);
    throw new Error(body?.error ?? `MIDI download failed (${response.status})`);
  }
  return response.arrayBuffer();
}

async function searchBitMidi(query: string, page: number): Promise<SearchResponse> {
  const cacheKey = `${query.trim().toLowerCase()}:${page}`;
  const cached = bitMidiSearchCache.get(cacheKey);
  if (cached) return cached;

  const existing = bitMidiSearchesInFlight.get(cacheKey);
  if (existing) return existing;

  const search = runBitMidiSearch(query, page)
    .then((response) => {
      rememberBitMidiSearch(cacheKey, response);
      return response;
    })
    .finally(() => {
      bitMidiSearchesInFlight.delete(cacheKey);
    });

  bitMidiSearchesInFlight.set(cacheKey, search);
  return search;
}

async function runBitMidiSearch(query: string, page: number): Promise<SearchResponse> {
  const url = bitMidiSearchUrl(query, page);
  let lastStatus: number | undefined;

  for (let attempt = 0; attempt < BITMIDI_ATTEMPT_TIMEOUTS_MS.length; attempt += 1) {
    let retryDelay = BITMIDI_TIMEOUT_RETRY_DELAY_MS;

    try {
      const response = await fetchWithTimeout(url, BITMIDI_ATTEMPT_TIMEOUTS_MS[attempt]);
      if (response.ok) {
        return {
          results: parseBitMidiSearchResponse(await response.json()),
          source: "bitmidi",
          query,
          page
        };
      }

      lastStatus = response.status;
      if (!isRetryableStatus(response.status)) break;
      retryDelay = BITMIDI_UPSTREAM_RETRY_DELAY_MS;
    } catch {
      // BitMidi's first search for a query can stall. Pause before retrying so
      // its upstream cache has a chance to populate.
    }

    if (attempt < BITMIDI_ATTEMPT_TIMEOUTS_MS.length - 1) await delay(retryDelay);
  }

  const statusDetail = lastStatus ? ` (${lastStatus})` : "";
  throw new Error(`Song search is temporarily unavailable${statusDetail}. Please try again.`);
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function rememberBitMidiSearch(key: string, response: SearchResponse): void {
  if (bitMidiSearchCache.size >= BITMIDI_CACHE_LIMIT) {
    const oldestKey = bitMidiSearchCache.keys().next().value;
    if (oldestKey) bitMidiSearchCache.delete(oldestKey);
  }
  bitMidiSearchCache.set(key, response);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMidiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && /\.(mid|midi)(\?|$)/i.test(url.pathname + url.search);
  } catch {
    return false;
  }
}
