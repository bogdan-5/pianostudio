import type { SearchResponse, SongSearchResult } from "../../shared/types";

export async function searchSongs(query: string, source = "all", page = 0): Promise<SearchResponse> {
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
  if (result.source === "direct" && result.detailUrl) params.set("url", result.detailUrl);

  const response = await fetch(`/api/midi?${params.toString()}`);
  if (!response.ok) {
    const body = await response.json().catch(() => undefined);
    throw new Error(body?.error ?? `MIDI download failed (${response.status})`);
  }
  return response.arrayBuffer();
}
