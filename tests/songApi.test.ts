import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadMidi, searchSongs } from "../src/lib/songApi";

describe("songApi", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses BitMidi's public API and keeps its direct download URL", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith("/api/search")) return new Promise<Response>(() => undefined);
      return Promise.resolve(
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
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await searchSongs("queen", "bitmidi", 2);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://bitmidi.com/api/midi/search?q=queen&page=2",
      expect.objectContaining({
        headers: { accept: "application/json" },
        signal: expect.any(AbortSignal)
      })
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

  it("retries a cold BitMidi search that times out", async () => {
    vi.useFakeTimers();
    let bitMidiAttempts = 0;
    const fetchMock = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
      if (url.startsWith("/api/search")) return new Promise<Response>(() => undefined);
      bitMidiAttempts += 1;
      if (bitMidiAttempts === 1) {
        return new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            result: {
              results: [
                {
                  id: 1,
                  name: "Cold Search.mid",
                  slug: "cold-search-mid",
                  downloadUrl: "/uploads/1.mid"
                }
              ]
            }
          }),
          { status: 200 }
        )
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const responsePromise = searchSongs("cold search", "bitmidi");
    await vi.advanceTimersByTimeAsync(5_000);
    const response = await responsePromise;

    expect(bitMidiAttempts).toBe(2);
    expect(response.results[0]?.title).toBe("Cold Search.mid");
  });

  it("backs off after a retryable BitMidi response", async () => {
    vi.useFakeTimers();
    let bitMidiAttempts = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith("/api/search")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ results: [], source: "freemidi", query: "gateway retry", page: 0 }),
            { status: 200 }
          )
        );
      }
      bitMidiAttempts += 1;
      return Promise.resolve(
        bitMidiAttempts === 1
          ? new Response(undefined, { status: 502 })
          : new Response(JSON.stringify({ result: { results: [] } }), {
              status: 200,
              headers: { "content-type": "application/json" }
            })
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const responsePromise = searchSongs("gateway retry", "bitmidi");
    await vi.advanceTimersByTimeAsync(3_999);
    expect(bitMidiAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const response = await responsePromise;

    expect(bitMidiAttempts).toBe(2);
    expect(response.results).toEqual([]);
  });

  it("uses the app's FreeMidi fallback when BitMidi is unavailable", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith("https://bitmidi.com")) {
        return Promise.resolve(new Response(undefined, { status: 502 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: [
              {
                id: "download3-5820-killer-queen-queen",
                source: "freemidi",
                title: "Killer Queen",
                artist: "Queen"
              }
            ],
            source: "freemidi",
            query: "fallback search",
            page: 0
          }),
          { status: 200 }
        )
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await searchSongs("fallback search", "bitmidi");

    expect(response.source).toBe("freemidi");
    expect(response.results[0]?.title).toBe("Killer Queen");
  });

  it("reuses successful BitMidi searches during the session", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith("/api/search")) return new Promise<Response>(() => undefined);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            result: {
              results: [{ id: 2, name: "Cached.mid", slug: "cached-mid", downloadUrl: "/uploads/2.mid" }]
            }
          }),
          { status: 200 }
        )
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await searchSongs("cache test", "bitmidi");
    const second = await searchSongs(" CACHE TEST ", "bitmidi");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second).toBe(first);
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
