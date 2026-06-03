import { describe, expect, it } from "vitest";
import type { NormalizedNote, PracticeStats } from "../shared/types";
import {
  applyJudgement,
  applyMisses,
  collectStrictChordPitches,
  countMissedNotes,
  getTargetCluster,
  judgeContinuousInput,
  judgeStrictInput,
  notesInLoopRange,
  pruneRecentPitchTouches,
  snapLoopRangeToNotes
} from "../src/lib/practice";

const notes: NormalizedNote[] = [
  note("a", 60, 1),
  note("b", 64, 1.04),
  note("c", 67, 2.2)
];

describe("practice rules", () => {
  it("groups near-simultaneous notes for strict wait mode", () => {
    const cluster = getTargetCluster(notes, 0.95, new Set(), 0.08);
    expect(cluster?.notes.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("waits until every pitch in a strict cluster is held", () => {
    const cluster = getTargetCluster(notes, 0.95, new Set(), 0.08);
    expect(judgeStrictInput(60, cluster, new Set()).judgement).toBe("ignored");
    const complete = judgeStrictInput(64, cluster, new Set([60]));
    expect(complete.judgement).toBe("correct");
    expect(complete.matchedIds).toEqual(["a", "b"]);
    expect(judgeStrictInput(61, cluster, new Set([60])).judgement).toBe("wrong");
  });

  it("allows a short grace window for released notes in strict chords", () => {
    const cluster = getTargetCluster(notes, 0.95, new Set(), 0.08);
    const recentTouches = new Map([
      [60, { pressedAtMs: 1000, releasedAtMs: 1060 }],
      [64, { pressedAtMs: 1080 }]
    ]);

    const gracePitches = collectStrictChordPitches(new Set([64]), recentTouches, 1110, 80);
    const latePitches = collectStrictChordPitches(new Set([64]), recentTouches, 1160, 80);

    expect(judgeStrictInput(64, cluster, gracePitches).judgement).toBe("correct");
    expect(judgeStrictInput(64, cluster, latePitches).judgement).toBe("ignored");
  });

  it("prunes expired chord grace touches but keeps held notes", () => {
    const pruned = pruneRecentPitchTouches(
      new Set([64]),
      new Map([
        [60, { pressedAtMs: 1000, releasedAtMs: 1040 }],
        [64, { pressedAtMs: 1000 }]
      ]),
      1200,
      80
    );

    expect([...pruned.keys()]).toEqual([64]);
  });

  it("snaps a dragged loop range to the notes inside it", () => {
    const loop = snapLoopRangeToNotes({ startSec: 0.98, endSec: 1.5 }, notes, 4);

    expect(loop).toEqual({ startSec: 0.96, endSec: 1.58, noteIds: ["a", "b"] });
    expect(notesInLoopRange(notes, loop).map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("keeps loop playback notes locked to the highlighted notes", () => {
    const denseNotes = [
      note("edge-before", 57, 0.93),
      note("selected", 60, 1),
      note("edge-after", 64, 1.59)
    ];
    const loop = snapLoopRangeToNotes({ startSec: 0.98, endSec: 1.04 }, denseNotes, 4);

    expect(loop).toEqual({ startSec: 0.96, endSec: 1.54, noteIds: ["selected"] });
    expect(notesInLoopRange(denseNotes, loop).map((item) => item.id)).toEqual(["selected"]);
  });

  it("matches continuous input inside the hit window", () => {
    const hit = judgeContinuousInput(67, notes, 2.12, new Set());
    const wrong = judgeContinuousInput(65, notes, 2.12, new Set());
    expect(hit).toEqual({ judgement: "correct", matchedIds: ["c"] });
    expect(wrong).toEqual({ judgement: "wrong", matchedIds: [] });
  });

  it("counts misses once and updates scoring", () => {
    const missed = countMissedNotes(notes, 1.5, new Set(["a"]), new Set());
    expect(missed).toEqual(["b"]);

    const stats: PracticeStats = { correct: 0, wrong: 0, missed: 0, streak: 0 };
    expect(applyJudgement(stats, "correct", 2)).toEqual({ correct: 2, wrong: 0, missed: 0, streak: 2 });
    expect(applyMisses({ correct: 2, wrong: 0, missed: 0, streak: 2 }, 1)).toEqual({
      correct: 2,
      wrong: 0,
      missed: 1,
      streak: 0
    });
  });
});

function note(id: string, midi: number, startSec: number): NormalizedNote {
  return {
    id,
    midi,
    startSec,
    durationSec: 0.5,
    velocity: 0.7,
    trackId: "track",
    hand: midi < 60 ? "left" : "right"
  };
}
