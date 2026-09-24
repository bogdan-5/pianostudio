import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMidiFile, searchSongs } from "../server/songService";

describe("songService FreeMidi fallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses FreeMidi search results", async () => {
    const html = `
      <div class="card">
        <div class="card-body">
          <h5 class="card-title">
            <a href="download3-5820-killer-queen-queen" title="Killer Queen">Killer Queen</a>
          </h5>
          <a href="/artist-81-queen">Queen</a>
        </div>
      </div>
    `;
    const fetchMock = vi.fn().mockResolvedValue(new Response(html, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await searchSongs("queen", "freemidi", 0);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://freemidi.org/search?q=queen",
      expect.objectContaining({ headers: expect.objectContaining({ accept: expect.stringContaining("text/html") }) })
    );
    expect(response.results).toEqual([
      expect.objectContaining({
        id: "download3-5820-killer-queen-queen",
        source: "freemidi",
        title: "Killer Queen",
        artist: "Queen",
        detailUrl: "https://freemidi.org/download3-5820-killer-queen-queen"
      })
    ]);
  });

  it("reads the MIDI payload from FreeMidi's manual redirect response", async () => {
    const bytes = new Uint8Array([77, 84, 104, 100, 0, 0, 0, 6]);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(bytes, {
        status: 302,
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": "attachment; filename=KillerQueen.mid",
          location: "https://freemidi.org/download-5820"
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const file = await fetchMidiFile({
      source: "freemidi",
      id: "download3-5820-killer-queen-queen"
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://freemidi.org/getter-5820",
      expect.objectContaining({
        redirect: "manual",
        headers: expect.objectContaining({
          referer: "https://freemidi.org/download3-5820-killer-queen-queen"
        })
      })
    );
    expect(file.filename).toBe("KillerQueen.mid");
    expect(file.buffer).toEqual(Buffer.from(bytes));
  });
});
