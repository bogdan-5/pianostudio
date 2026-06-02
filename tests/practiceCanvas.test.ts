import { describe, expect, it } from "vitest";
import type { NormalizedNote } from "../shared/types";
import { buildTrackColorMap } from "../src/components/PracticeCanvas";

describe("PracticeCanvas track color mapping", () => {
  it("uses one note color when only one track is active", () => {
    const colors = buildTrackColorMap(
      [note("low", 48, "solo", "left"), note("high", 72, "solo", "right")],
      ["solo"]
    );

    expect(new Set(colors.values()).size).toBe(1);
  });

  it("assigns distinct note colors by track order", () => {
    const colors = buildTrackColorMap(
      [note("left", 48, "left-hand", "left"), note("right", 72, "right-hand", "right")],
      ["right-hand", "left-hand"]
    );

    expect([...colors.keys()]).toEqual(["right-hand", "left-hand"]);
    expect(colors.get("right-hand")).not.toBe(colors.get("left-hand"));
  });
});

function note(id: string, midi: number, trackId: string, hand: "left" | "right"): NormalizedNote {
  return {
    id,
    midi,
    startSec: 0,
    durationSec: 0.5,
    velocity: 0.7,
    trackId,
    hand
  };
}
