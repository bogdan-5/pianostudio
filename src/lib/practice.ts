import type { LoopRange, NormalizedNote, PracticeStats } from "../../shared/types";

export type Judgement = "correct" | "wrong" | "ignored";

export type TargetCluster = {
  time: number;
  notes: NormalizedNote[];
};

export type RecentPitchTouch = {
  pressedAtMs: number;
  releasedAtMs?: number;
};

export const STRICT_TOLERANCE_SEC = 0.09;
export const CONTINUOUS_HIT_WINDOW_SEC = 0.22;
export const STRICT_CHORD_GRACE_MS = 130;
export const LOOP_NOTE_TOLERANCE_SEC = 0.04;
export const MIN_LOOP_RANGE_SEC = 0.25;

export function getTargetCluster(
  notes: NormalizedNote[],
  cursorSec: number,
  completedNoteIds: Set<string>,
  toleranceSec = STRICT_TOLERANCE_SEC
): TargetCluster | undefined {
  const next = notes.find((note) => !completedNoteIds.has(note.id) && note.startSec >= cursorSec - toleranceSec);
  if (!next) return undefined;
  return {
    time: next.startSec,
    notes: notes.filter(
      (note) => !completedNoteIds.has(note.id) && Math.abs(note.startSec - next.startSec) <= toleranceSec
    )
  };
}

export function judgeStrictInput(
  midi: number,
  target: TargetCluster | undefined,
  heldPitches: Set<number>
): { judgement: Judgement; matchedIds: string[] } {
  if (!target) return { judgement: "ignored", matchedIds: [] };
  const needed = new Set(target.notes.map((note) => note.midi));
  if (!needed.has(midi)) return { judgement: "wrong", matchedIds: [] };

  const afterPress = new Set(heldPitches);
  afterPress.add(midi);
  const allHeld = [...needed].every((pitch) => afterPress.has(pitch));
  return {
    judgement: allHeld ? "correct" : "ignored",
    matchedIds: allHeld ? target.notes.map((note) => note.id) : []
  };
}

export function collectStrictChordPitches(
  heldPitches: Set<number>,
  recentTouches: Map<number, RecentPitchTouch>,
  nowMs: number,
  graceMs = STRICT_CHORD_GRACE_MS
): Set<number> {
  const pitches = new Set(heldPitches);

  recentTouches.forEach((touch, pitch) => {
    if (heldPitches.has(pitch)) {
      pitches.add(pitch);
      return;
    }

    if (touch.releasedAtMs !== undefined && nowMs - touch.releasedAtMs <= graceMs) {
      pitches.add(pitch);
    }
  });

  return pitches;
}

export function pruneRecentPitchTouches(
  heldPitches: Set<number>,
  recentTouches: Map<number, RecentPitchTouch>,
  nowMs: number,
  graceMs = STRICT_CHORD_GRACE_MS
): Map<number, RecentPitchTouch> {
  const next = new Map<number, RecentPitchTouch>();

  recentTouches.forEach((touch, pitch) => {
    if (heldPitches.has(pitch) || touch.releasedAtMs === undefined || nowMs - touch.releasedAtMs <= graceMs) {
      next.set(pitch, touch);
    }
  });

  return next;
}

export function normalizeLoopRange(
  range: LoopRange,
  durationSec: number,
  minRangeSec = MIN_LOOP_RANGE_SEC
): LoopRange {
  const duration = Math.max(0, durationSec);
  let startSec = Math.max(0, Math.min(duration, Math.min(range.startSec, range.endSec)));
  let endSec = Math.max(0, Math.min(duration, Math.max(range.startSec, range.endSec)));

  if (endSec - startSec < minRangeSec) {
    endSec = Math.min(duration, startSec + minRangeSec);
    startSec = Math.max(0, Math.min(startSec, endSec - minRangeSec));
  }

  return { startSec, endSec };
}

export function notesInLoopRange(
  notes: NormalizedNote[],
  range: LoopRange | undefined,
  toleranceSec = LOOP_NOTE_TOLERANCE_SEC
): NormalizedNote[] {
  if (!range) return notes;
  return notes.filter(
    (note) => note.startSec >= range.startSec - toleranceSec && note.startSec <= range.endSec + toleranceSec
  );
}

export function snapLoopRangeToNotes(
  range: LoopRange,
  notes: NormalizedNote[],
  durationSec: number,
  toleranceSec = LOOP_NOTE_TOLERANCE_SEC
): LoopRange | undefined {
  const normalized = normalizeLoopRange(range, durationSec);
  const selected = notesInLoopRange(notes, normalized, toleranceSec);
  if (!selected.length) return undefined;

  const firstStart = Math.min(...selected.map((note) => note.startSec));
  const lastEnd = Math.max(...selected.map((note) => note.startSec + Math.max(0.12, note.durationSec)));

  return normalizeLoopRange(
    {
      startSec: Math.max(0, firstStart - toleranceSec),
      endSec: Math.min(Math.max(0, durationSec), lastEnd + toleranceSec)
    },
    durationSec
  );
}

export function judgeContinuousInput(
  midi: number,
  notes: NormalizedNote[],
  cursorSec: number,
  completedNoteIds: Set<string>,
  windowSec = CONTINUOUS_HIT_WINDOW_SEC
): { judgement: Judgement; matchedIds: string[] } {
  const candidates = notes
    .filter(
      (note) =>
        !completedNoteIds.has(note.id) && note.midi === midi && Math.abs(note.startSec - cursorSec) <= windowSec
    )
    .sort((a, b) => Math.abs(a.startSec - cursorSec) - Math.abs(b.startSec - cursorSec));

  if (!candidates.length) return { judgement: "wrong", matchedIds: [] };
  return { judgement: "correct", matchedIds: [candidates[0].id] };
}

export function countMissedNotes(
  notes: NormalizedNote[],
  cursorSec: number,
  completedNoteIds: Set<string>,
  alreadyMissedIds: Set<string>,
  missWindowSec = CONTINUOUS_HIT_WINDOW_SEC
): string[] {
  return notes
    .filter(
      (note) =>
        !completedNoteIds.has(note.id) &&
        !alreadyMissedIds.has(note.id) &&
        note.startSec + missWindowSec < cursorSec
    )
    .map((note) => note.id);
}

export function applyJudgement(stats: PracticeStats, judgement: Judgement, count = 1): PracticeStats {
  if (judgement === "correct") {
    return { ...stats, correct: stats.correct + count, streak: stats.streak + count };
  }
  if (judgement === "wrong") {
    return { ...stats, wrong: stats.wrong + 1, streak: 0 };
  }
  return stats;
}

export function applyMisses(stats: PracticeStats, count: number): PracticeStats {
  if (count <= 0) return stats;
  return { ...stats, missed: stats.missed + count, streak: 0 };
}
