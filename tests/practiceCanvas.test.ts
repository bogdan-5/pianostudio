import { describe, expect, it } from "vitest";
import type { NormalizedNote } from "../shared/types";
import { buildTrackColorMap, getVisibleNotes } from "../src/components/PracticeCanvas";

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

  it("returns only notes intersecting the visible canvas window", () => {
    const notes = [
      note("past", 48, "left-hand", "left", 0, 0.3),
      note("held", 52, "left-hand", "left", 1, 3),
      note("visible", 60, "right-hand", "right", 3.2, 0.4),
      note("future", 64, "right-hand", "right", 7, 0.4)
    ];

    const visible = getVisibleNotes(notes, 2.5, 4, 3);

    expect(visible.map((item) => item.id)).toEqual(["held", "visible"]);
  });
});

function note(
  id: string,
  midi: number,
  trackId: string,
  hand: "left" | "right",
  startSec = 0,
  durationSec = 0.5
): NormalizedNote {
  return {
    id,
    midi,
    startSec,
    durationSec,
    velocity: 0.7,
    trackId,
    hand
  };
}
