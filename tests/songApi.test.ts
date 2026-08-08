import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadMidi, searchSongs } from "../src/lib/songApi";

describe("songApi", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses BitMidi's public API and keeps its direct download URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          result: {
            results: [
              {
                id: 87218,
                name: "Queen - Killer Queen.mid",
                slug: "queen-killer-queen-mid",
                downloadUrl: "/uploads/87218.mid"
              }
            ]
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await searchSongs("queen", "bitmidi", 2);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://bitmidi.com/api/midi/search?q=queen&page=2",
      { headers: { accept: "application/json" } }
    );
    expect(response.results).toEqual([
      expect.objectContaining({
        id: "queen-killer-queen-mid",
        title: "Queen - Killer Queen.mid",
        detailUrl: "https://bitmidi.com/queen-killer-queen-mid",
        midiUrl: "https://bitmidi.com/uploads/87218.mid"
      })
    ]);
  });

  it("passes a BitMidi direct download URL to the app's MIDI proxy", async () => {
    const bytes = new Uint8Array([77, 84, 104, 100]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(bytes, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await downloadMidi({
      id: "queen-killer-queen-mid",
      source: "bitmidi",
      title: "Queen - Killer Queen.mid",
      midiUrl: "https://bitmidi.com/uploads/87218.mid"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/midi?source=bitmidi&id=queen-killer-queen-mid&url=https%3A%2F%2Fbitmidi.com%2Fuploads%2F87218.mid"
    );
  });

  it("keeps direct MIDI URL searches on the app API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [], source: "bitmidi", query: "", page: 0 }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await searchSongs("https://example.com/song.mid", "bitmidi");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/search?q=https%3A%2F%2Fexample.com%2Fsong.mid&source=bitmidi&page=0"
    );
  });
});
