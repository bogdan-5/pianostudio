import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent, WheelEvent as ReactWheelEvent } from "react";
import type { LoopRange, NormalizedNote, PracticeMode } from "../../shared/types";
import { buildPianoKeys, isBlackKey, midiToNoteName, PIANO_HIGH_MIDI, PIANO_LOW_MIDI } from "../../shared/music";
import { LOOP_NOTE_TOLERANCE_SEC, normalizeLoopRange, notesInLoopRange } from "../lib/practice";

type PracticeCanvasProps = {
  notes: NormalizedNote[];
  trackIds?: string[];
  cursorSec: number;
  durationSec: number;
  mode: PracticeMode;
  activePitches: Set<number>;
  targetIds: Set<string>;
  completedIds: Set<string>;
  missedIds: Set<string>;
  lowMidi?: number;
  highMidi?: number;
  secondsVisible: number;
  loopRange?: LoopRange;
  noteGlowEnabled?: boolean;
  onLoopRangeSelect?: (range: LoopRange) => void;
  onViewportCursorChange?: (cursorSec: number) => void;
};

type LoopSelectionDrag =
  | { type: "range"; pointerId: number; startSec: number }
  | { type: "rect"; pointerId: number; startX: number; startY: number; startSec: number };

type DraftLoopRect = {
  startX: number;
  endX: number;
  startSec: number;
  endSec: number;
};

const AUTO_SCROLL_EDGE_PX = 72;
const AUTO_SCROLL_MAX_VISIBLE_WINDOWS_PER_SEC = 0.8;
const WHEEL_SCROLL_SCALE = 0.9;
const RECT_SELECTION_MIN_PX = 8;
const SINGLE_TRACK_NOTE_COLOR = "#22d3ee";
const TRACK_NOTE_COLORS = ["#22d3ee", "#fb6fae", "#a78bfa", "#34d399", "#f6c453", "#f472b6"];
const VISIBLE_NOTE_HEADROOM_SEC = 0.3;

export const PracticeCanvas = memo(function PracticeCanvas({
  notes,
  trackIds = [],
  cursorSec,
  durationSec,
  mode,
  activePitches,
  targetIds,
  completedIds,
  missedIds,
  lowMidi = PIANO_LOW_MIDI,
  highMidi = PIANO_HIGH_MIDI,
  secondsVisible,
  loopRange,
  noteGlowEnabled = true,
  onLoopRangeSelect,
  onViewportCursorChange
}: PracticeCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const selectionRef = useRef<LoopSelectionDrag | null>(null);
  const cursorSecRef = useRef(cursorSec);
  const durationSecRef = useRef(durationSec);
  const secondsVisibleRef = useRef(secondsVisible);
  const onViewportCursorChangeRef = useRef(onViewportCursorChange);
  const pointerClientXRef = useRef<number | null>(null);
  const pointerClientYRef = useRef<number | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  const autoScrollLastRef = useRef(0);
  const autoScrollVelocityRef = useRef(0);
  const [draftLoopRange, setDraftLoopRange] = useState<LoopRange | undefined>();
  const [draftLoopRect, setDraftLoopRect] = useState<DraftLoopRect | undefined>();
  const geometry = useMemo(() => buildGeometry(lowMidi, highMidi), [highMidi, lowMidi]);
  const trackColorMap = useMemo(() => buildTrackColorMap(notes, trackIds), [notes, trackIds]);
  const maxNoteDurationSec = useMemo(() => notes.reduce((max, note) => Math.max(max, note.durationSec), 0), [notes]);
  const draftRangeSelectedNoteIds = useMemo(() => {
    if (!draftLoopRange) return new Set<string>();
    const normalizedDraftRange = normalizeLoopRange(draftLoopRange, durationSec);
    return new Set(notesInLoopRange(notes, normalizedDraftRange, LOOP_NOTE_TOLERANCE_SEC).map((note) => note.id));
  }, [draftLoopRange, durationSec, notes]);
  const draftRectSelectedNoteIds = useMemo(() => {
    if (!draftLoopRect) return new Set<string>();
    const hostRect = hostRef.current?.getBoundingClientRect();
    if (!hostRect) return new Set<string>();
    return new Set(
      getNotesInSelectionRect(notes, draftLoopRect, geometry, hostRect.width).map((note) => note.id)
    );
  }, [draftLoopRect, geometry, notes]);
  const draftSelectedNoteIds = draftLoopRect ? draftRectSelectedNoteIds : draftRangeSelectedNoteIds;
  const activeLoopNoteIds = useMemo(() => {
    if (!loopRange) return new Set<string>();
    return new Set(notesInLoopRange(notes, loopRange).map((note) => note.id));
  }, [loopRange, notes]);

  useEffect(() => {
    cursorSecRef.current = cursorSec;
    durationSecRef.current = durationSec;
    secondsVisibleRef.current = secondsVisible;
    onViewportCursorChangeRef.current = onViewportCursorChange;
  }, [cursorSec, durationSec, onViewportCursorChange, secondsVisible]);

  const timeFromClientY = useCallback((clientY: number, host: HTMLDivElement, viewportCursorSec = cursorSecRef.current): number => {
    const rect = host.getBoundingClientRect();
    const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
    const relativeFromBottom = rect.height <= 0 ? 0 : (rect.height - y) / rect.height;
    return Math.max(0, Math.min(durationSecRef.current, viewportCursorSec + relativeFromBottom * secondsVisibleRef.current));
  }, []);

  const timeFromPointer = useCallback(
    (event: PointerEvent<HTMLDivElement>): number => timeFromClientY(event.clientY, event.currentTarget),
    [timeFromClientY]
  );

  const updateDraftEndFromPointer = useCallback(() => {
    const selection = selectionRef.current;
    const host = hostRef.current;
    const pointerClientX = pointerClientXRef.current;
    const pointerClientY = pointerClientYRef.current;
    if (!selection || !host || pointerClientY === null) return;
    const endSec = timeFromClientY(pointerClientY, host);
    if (selection.type === "range") {
      setDraftLoopRange({ startSec: selection.startSec, endSec });
      return;
    }
    if (pointerClientX === null) return;
    const { x } = pointFromClient(pointerClientX, pointerClientY, host);
    setDraftLoopRect({ startX: selection.startX, endX: x, startSec: selection.startSec, endSec });
  }, [timeFromClientY]);

  const scrollViewportBy = useCallback(
    (deltaSec: number): boolean => {
      const onChange = onViewportCursorChangeRef.current;
      if (!onChange || Math.abs(deltaSec) < 0.001) return false;

      const nextCursorSec = Math.max(0, Math.min(durationSecRef.current, cursorSecRef.current + deltaSec));
      if (Math.abs(nextCursorSec - cursorSecRef.current) < 0.001) return false;

      cursorSecRef.current = nextCursorSec;
      onChange(nextCursorSec);
      updateDraftEndFromPointer();
      return true;
    },
    [updateDraftEndFromPointer]
  );

  const stopAutoScroll = useCallback(() => {
    if (autoScrollFrameRef.current !== null) {
      cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    }
    autoScrollLastRef.current = 0;
    autoScrollVelocityRef.current = 0;
  }, []);

  const stepAutoScroll = useCallback(
    (now: number) => {
      const velocity = autoScrollVelocityRef.current;
      if (!selectionRef.current || !velocity || !onViewportCursorChangeRef.current) {
        autoScrollFrameRef.current = null;
        autoScrollLastRef.current = 0;
        return;
      }

      const last = autoScrollLastRef.current || now;
      autoScrollLastRef.current = now;
      const deltaSeconds = Math.min(0.08, (now - last) / 1000);
      const scrollDeltaSec = velocity * deltaSeconds;

      if (Math.abs(scrollDeltaSec) < 0.001) {
        autoScrollFrameRef.current = requestAnimationFrame(stepAutoScroll);
        return;
      }

      const moved = scrollViewportBy(scrollDeltaSec);

      if (!moved) {
        autoScrollFrameRef.current = null;
        autoScrollLastRef.current = 0;
        autoScrollVelocityRef.current = 0;
        return;
      }

      autoScrollFrameRef.current = requestAnimationFrame(stepAutoScroll);
    },
    [scrollViewportBy]
  );

  const startAutoScroll = useCallback(() => {
    if (autoScrollFrameRef.current !== null) return;
    autoScrollLastRef.current = performance.now();
    autoScrollFrameRef.current = requestAnimationFrame(stepAutoScroll);
  }, [stepAutoScroll]);

  const updateAutoScrollVelocity = useCallback(
    (host: HTMLDivElement, clientY: number) => {
      if (!selectionRef.current || !onViewportCursorChangeRef.current) {
        stopAutoScroll();
        return;
      }

      const rect = host.getBoundingClientRect();
      const edgePx = Math.max(24, Math.min(AUTO_SCROLL_EDGE_PX, rect.height / 3));
      const y = clientY - rect.top;
      const maxVelocitySec = Math.max(1.2, secondsVisibleRef.current * AUTO_SCROLL_MAX_VISIBLE_WINDOWS_PER_SEC);
      let velocity = 0;

      if (y < edgePx) {
        const strength = Math.min(1, (edgePx - y) / edgePx);
        velocity = strength * strength * maxVelocitySec;
      } else if (y > rect.height - edgePx) {
        const strength = Math.min(1, (y - (rect.height - edgePx)) / edgePx);
        velocity = -strength * strength * maxVelocitySec;
      }

      autoScrollVelocityRef.current = velocity;
      if (velocity) {
        startAutoScroll();
      } else {
        stopAutoScroll();
      }
    },
    [startAutoScroll, stopAutoScroll]
  );

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!onLoopRangeSelect || (event.button !== 0 && event.button !== 2)) return;
      const startSec = timeFromPointer(event);
      const { x, y } = pointFromClient(event.clientX, event.clientY, event.currentTarget);
      hostRef.current = event.currentTarget;
      pointerClientXRef.current = event.clientX;
      pointerClientYRef.current = event.clientY;
      selectionRef.current =
        event.button === 2
          ? { type: "rect", pointerId: event.pointerId, startX: x, startY: y, startSec }
          : { type: "range", pointerId: event.pointerId, startSec };
      event.currentTarget.setPointerCapture(event.pointerId);
      if (event.button === 2) {
        setDraftLoopRange(undefined);
        setDraftLoopRect({ startX: x, endX: x, startSec, endSec: startSec });
      } else {
        setDraftLoopRect(undefined);
        setDraftLoopRange({ startSec, endSec: startSec });
      }
      event.preventDefault();
    },
    [onLoopRangeSelect, timeFromPointer]
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const selection = selectionRef.current;
      if (!selection || selection.pointerId !== event.pointerId) return;
      pointerClientXRef.current = event.clientX;
      pointerClientYRef.current = event.clientY;
      const endSec = timeFromPointer(event);
      if (selection.type === "range") {
        setDraftLoopRange({ startSec: selection.startSec, endSec });
      } else {
        const { x } = pointFromClient(event.clientX, event.clientY, event.currentTarget);
        setDraftLoopRect({ startX: selection.startX, endX: x, startSec: selection.startSec, endSec });
      }
      updateAutoScrollVelocity(event.currentTarget, event.clientY);
      event.preventDefault();
    },
    [timeFromPointer, updateAutoScrollVelocity]
  );

  const finishSelection = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const selection = selectionRef.current;
      if (!selection || selection.pointerId !== event.pointerId) return;
      const endSec = timeFromPointer(event);
      const endPoint = pointFromClient(event.clientX, event.clientY, event.currentTarget);
      selectionRef.current = null;
      pointerClientXRef.current = null;
      pointerClientYRef.current = null;
      stopAutoScroll();
      setDraftLoopRange(undefined);
      setDraftLoopRect(undefined);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (selection.type === "range" && Math.abs(endSec - selection.startSec) >= 0.12) {
        onLoopRangeSelect?.({ startSec: selection.startSec, endSec });
      } else if (selection.type === "rect") {
        const dragDistance = Math.hypot(endPoint.x - selection.startX, endPoint.y - selection.startY);
        const rect = { startX: selection.startX, endX: endPoint.x, startSec: selection.startSec, endSec };
        const selectedNotes = getNotesInSelectionRect(
          notes,
          rect,
          geometry,
          event.currentTarget.getBoundingClientRect().width
        );
        if (dragDistance >= RECT_SELECTION_MIN_PX && selectedNotes.length > 0) {
          const firstStart = Math.min(...selectedNotes.map((note) => note.startSec));
          const lastEnd = Math.max(...selectedNotes.map((note) => note.startSec + note.durationSec));
          onLoopRangeSelect?.({
            startSec: firstStart,
            endSec: lastEnd,
            noteIds: selectedNotes.map((note) => note.id)
          });
        }
      }
      event.preventDefault();
    },
    [geometry, notes, onLoopRangeSelect, stopAutoScroll, timeFromPointer]
  );

  const handleWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (!onViewportCursorChangeRef.current) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const deltaPixels = normalizeWheelDelta(event.nativeEvent, rect.height);
      if (!Number.isFinite(deltaPixels) || Math.abs(deltaPixels) < 0.5) return;

      const deltaSec = (-deltaPixels / Math.max(1, rect.height)) * secondsVisibleRef.current * WHEEL_SCROLL_SCALE;
      scrollViewportBy(deltaSec);
      event.preventDefault();
    },
    [scrollViewportBy]
  );

  useEffect(() => stopAutoScroll, [stopAutoScroll]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;

    const draw = () => {
      const rect = host.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(260, Math.floor(rect.width));
      const height = Math.max(320, Math.floor(rect.height));

      if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      paintBackground(ctx, width, height, geometry);
      paintLoopRange(ctx, width, height, cursorSec, secondsVisible, draftLoopRange ?? loopRange, Boolean(draftLoopRange));
      paintLoopRect(ctx, width, height, cursorSec, secondsVisible, draftLoopRect);
      paintNotes(
        ctx,
        width,
        height,
        geometry,
        notes,
        cursorSec,
        secondsVisible,
        targetIds,
        completedIds,
        missedIds,
        trackColorMap,
        draftSelectedNoteIds,
        activeLoopNoteIds,
        noteGlowEnabled,
        maxNoteDurationSec
      );
      paintNowLine(ctx, width, height, mode);
      paintActiveKeys(ctx, width, height, geometry, activePitches);
      paintRuler(ctx, width, height, cursorSec, durationSec);
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(host);
    return () => observer.disconnect();
  }, [
    activePitches,
    activeLoopNoteIds,
    completedIds,
    cursorSec,
    draftLoopRange,
    draftLoopRect,
    draftSelectedNoteIds,
    durationSec,
    geometry,
    loopRange,
    maxNoteDurationSec,
    missedIds,
    mode,
    noteGlowEnabled,
    notes,
    secondsVisible,
    targetIds,
    trackColorMap
  ]);

  return (
    <div
      ref={hostRef}
      className={`practiceCanvasWrap ${onLoopRangeSelect ? "selectable" : ""}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishSelection}
      onPointerCancel={finishSelection}
      onContextMenu={(event) => event.preventDefault()}
      onWheel={handleWheel}
    >
      <canvas ref={canvasRef} className="practiceCanvas" />
    </div>
  );
});

type KeyGeometry = {
  xByMidi: Map<number, number>;
  widthByMidi: Map<number, number>;
  blackByMidi: Map<number, boolean>;
  whiteWidth: number;
  totalWhite: number;
};

function buildGeometry(lowMidi: number, highMidi: number): KeyGeometry {
  const keys = buildPianoKeys().filter((key) => key.midi >= lowMidi && key.midi <= highMidi);
  const whiteKeys = keys.filter((key) => !key.black);
  const minWhiteIndex = whiteKeys[0]?.whiteIndex ?? 0;
  const xByMidi = new Map<number, number>();
  const widthByMidi = new Map<number, number>();
  const blackByMidi = new Map<number, boolean>();
  const whiteWidth = 1 / Math.max(1, whiteKeys.length);
  const blackWidth = whiteWidth * 0.64;

  keys.forEach((key) => {
    const black = isBlackKey(key.midi);
    const x = black
      ? (key.whiteIndex - minWhiteIndex + 1) * whiteWidth - blackWidth / 2
      : (key.whiteIndex - minWhiteIndex) * whiteWidth;
    xByMidi.set(key.midi, x);
    widthByMidi.set(key.midi, black ? blackWidth : whiteWidth);
    blackByMidi.set(key.midi, black);
  });

  return { xByMidi, widthByMidi, blackByMidi, whiteWidth, totalWhite: whiteKeys.length };
}

export function buildTrackColorMap(notes: NormalizedNote[], trackIds: string[]): Map<string, string> {
  const noteTrackIds = new Set(notes.map((note) => note.trackId));
  const orderedTrackIds: string[] = [];
  const seen = new Set<string>();

  trackIds.forEach((trackId) => {
    if (!noteTrackIds.has(trackId) || seen.has(trackId)) return;
    seen.add(trackId);
    orderedTrackIds.push(trackId);
  });

  notes.forEach((note) => {
    if (seen.has(note.trackId)) return;
    seen.add(note.trackId);
    orderedTrackIds.push(note.trackId);
  });

  return new Map(
    orderedTrackIds.map((trackId, index) => [
      trackId,
      orderedTrackIds.length <= 1 ? SINGLE_TRACK_NOTE_COLOR : TRACK_NOTE_COLORS[index % TRACK_NOTE_COLORS.length]
    ])
  );
}

function pointFromClient(clientX: number, clientY: number, host: HTMLDivElement) {
  const rect = host.getBoundingClientRect();
  return {
    x: clamp(clientX - rect.left, 0, rect.width),
    y: clamp(clientY - rect.top, 0, rect.height)
  };
}

function getNotesInSelectionRect(
  notes: NormalizedNote[],
  rect: DraftLoopRect,
  geometry: KeyGeometry,
  width: number
): NormalizedNote[] {
  const bounds = normalizeSelectionRect(rect);
  if (bounds.right - bounds.left < 1 || bounds.endSec - bounds.startSec < 0.001) return [];

  return notes.filter((note) => {
    const noteBox = getNoteHorizontalBox(note, geometry, width);
    if (!noteBox) return false;

    const noteStart = note.startSec;
    const noteEnd = note.startSec + Math.max(0.001, note.durationSec);
    return noteBox.right >= bounds.left && noteBox.left <= bounds.right && noteEnd >= bounds.startSec && noteStart <= bounds.endSec;
  });
}

function getNoteHorizontalBox(note: NormalizedNote, geometry: KeyGeometry, width: number) {
  const relativeX = geometry.xByMidi.get(note.midi);
  if (relativeX === undefined) return undefined;

  const keyWidth = Math.max(8, (geometry.widthByMidi.get(note.midi) ?? geometry.whiteWidth) * width - 2);
  const left = relativeX * width + 1;
  return { left, right: left + keyWidth };
}

function normalizeSelectionRect(rect: DraftLoopRect) {
  return {
    left: Math.min(rect.startX, rect.endX),
    right: Math.max(rect.startX, rect.endX),
    startSec: Math.min(rect.startSec, rect.endSec),
    endSec: Math.max(rect.startSec, rect.endSec)
  };
}

function paintBackground(ctx: CanvasRenderingContext2D, width: number, height: number, geometry: KeyGeometry) {
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "#0b0d12");
  gradient.addColorStop(0.48, "#090b10");
  gradient.addColorStop(1, "#050607");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  geometry.xByMidi.forEach((relativeX, midi) => {
    const keyWidth = (geometry.widthByMidi.get(midi) ?? geometry.whiteWidth) * width;
    const x = relativeX * width;
    ctx.fillStyle = geometry.blackByMidi.get(midi) ? "rgba(255,255,255,0.025)" : "rgba(255,255,255,0.052)";
    ctx.fillRect(x, 0, Math.max(1, keyWidth - 1), height);
  });

  for (let beat = 0; beat <= 12; beat += 1) {
    const y = height - (beat / 12) * height;
    ctx.strokeStyle = beat === 0 ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.055)";
    ctx.lineWidth = beat === 0 ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  const glow = ctx.createRadialGradient(width * 0.5, height, 0, width * 0.5, height, width * 0.55);
  glow.addColorStop(0, "rgba(168,85,247,0.16)");
  glow.addColorStop(0.38, "rgba(34,211,238,0.07)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);
}

function paintNotes(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  geometry: KeyGeometry,
  notes: NormalizedNote[],
  cursorSec: number,
  secondsVisible: number,
  targetIds: Set<string>,
  completedIds: Set<string>,
  missedIds: Set<string>,
  trackColorMap: Map<string, string>,
  draftSelectedNoteIds: Set<string>,
  activeLoopNoteIds: Set<string>,
  noteGlowEnabled: boolean,
  maxNoteDurationSec: number
) {
  const pxPerSec = height / secondsVisible;
  const visibleStart = cursorSec - VISIBLE_NOTE_HEADROOM_SEC;
  const visibleEnd = cursorSec + secondsVisible;

  getVisibleNotes(notes, visibleStart, visibleEnd, maxNoteDurationSec).forEach((note) => {
    const relativeX = geometry.xByMidi.get(note.midi);
    if (relativeX === undefined) return;

    const keyWidth = Math.max(8, (geometry.widthByMidi.get(note.midi) ?? geometry.whiteWidth) * width - 2);
    const x = relativeX * width + 1;
    const y = height - (note.startSec - cursorSec) * pxPerSec;
    const noteHeight = Math.max(12, note.durationSec * pxPerSec);
    const top = y - noteHeight;

    const isTarget = targetIds.has(note.id);
    const isCompleted = completedIds.has(note.id);
    const isMissed = missedIds.has(note.id);
    const isDraftSelected = draftSelectedNoteIds.has(note.id);
    const isActiveLoopSelected = activeLoopNoteIds.has(note.id) && !isDraftSelected;
    const trackColor = trackColorMap.get(note.trackId) ?? SINGLE_TRACK_NOTE_COLOR;
    const baseFillColor = isMissed ? "#64748b" : isTarget ? "#f6c453" : trackColor;
    const fillColor =
      isActiveLoopSelected && !isTarget && !isMissed ? activeLoopSelectionColor(baseFillColor) : baseFillColor;

    ctx.save();
    if (noteGlowEnabled && !isCompleted && !isMissed) {
      ctx.shadowColor = fillColor;
      ctx.shadowBlur = isDraftSelected ? 28 : isTarget ? 20 : 14;
    }
    ctx.globalAlpha = isDraftSelected ? 1 : isCompleted ? 0.32 : isMissed ? 0.28 : isActiveLoopSelected ? 0.88 : 0.96;
    ctx.fillStyle = fillColor;
    roundRect(ctx, x, top, keyWidth, noteHeight, 6);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = isDraftSelected
      ? "#fff7ad"
      : isTarget
        ? "#fff7ad"
        : isActiveLoopSelected
          ? "rgba(255,255,255,0.18)"
          : "rgba(255,255,255,0.34)";
    ctx.lineWidth = isDraftSelected ? 3 : isTarget ? 2 : 1;
    ctx.stroke();
    if (isDraftSelected) {
      ctx.strokeStyle = "rgba(246,196,83,0.48)";
      ctx.lineWidth = 6;
      roundRect(ctx, x - 2, top - 2, keyWidth + 4, noteHeight + 4, 8);
      ctx.stroke();
    }
    ctx.restore();
  });
}

export function getVisibleNotes(
  notes: NormalizedNote[],
  visibleStartSec: number,
  visibleEndSec: number,
  maxNoteDurationSec: number
): NormalizedNote[] {
  const startIndex = findFirstNoteStartingAtOrAfter(notes, visibleStartSec - maxNoteDurationSec);
  const visible: NormalizedNote[] = [];

  for (let index = startIndex; index < notes.length; index += 1) {
    const note = notes[index];
    if (note.startSec > visibleEndSec) break;
    if (note.startSec + note.durationSec >= visibleStartSec) visible.push(note);
  }

  return visible;
}

function findFirstNoteStartingAtOrAfter(notes: NormalizedNote[], startSec: number): number {
  let low = 0;
  let high = notes.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (notes[mid].startSec < startSec) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function paintLoopRange(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  cursorSec: number,
  secondsVisible: number,
  range: LoopRange | undefined,
  isDraft: boolean
) {
  if (!range) return;

  const pxPerSec = height / secondsVisible;
  const start = Math.min(range.startSec, range.endSec);
  const end = Math.max(range.startSec, range.endSec);
  const top = height - (end - cursorSec) * pxPerSec;
  const bottom = height - (start - cursorSec) * pxPerSec;
  const visibleTop = Math.max(0, Math.min(height, top));
  const visibleBottom = Math.max(0, Math.min(height, bottom));

  if (visibleBottom < 0 || visibleTop > height || visibleBottom - visibleTop <= 1) return;

  ctx.save();
  ctx.fillStyle = isDraft ? "rgba(125, 211, 252, 0.12)" : "rgba(139, 92, 246, 0.18)";
  ctx.fillRect(0, visibleTop, width, visibleBottom - visibleTop);
  ctx.strokeStyle = isDraft ? "rgba(125, 211, 252, 0.92)" : "rgba(167, 139, 250, 0.95)";
  ctx.lineWidth = 2;
  ctx.setLineDash(isDraft ? [7, 5] : []);
  ctx.strokeRect(1, visibleTop + 1, width - 2, Math.max(2, visibleBottom - visibleTop - 2));
  ctx.setLineDash([]);

  const label = `${formatClock(start)} - ${formatClock(end)}`;
  ctx.fillStyle = "rgba(15,23,42,0.78)";
  roundRect(ctx, width - 126, Math.max(12, visibleTop + 10), 108, 28, 8);
  ctx.fill();
  ctx.fillStyle = "#f5f3ff";
  ctx.font = "700 12px Inter, system-ui, sans-serif";
  ctx.fillText(label, width - 114, Math.max(31, visibleTop + 29));
  ctx.restore();
}

function paintLoopRect(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  cursorSec: number,
  secondsVisible: number,
  rect: DraftLoopRect | undefined
) {
  if (!rect) return;

  const bounds = normalizeSelectionRect(rect);
  const pxPerSec = height / secondsVisible;
  const top = height - (bounds.endSec - cursorSec) * pxPerSec;
  const bottom = height - (bounds.startSec - cursorSec) * pxPerSec;
  const visibleTop = clamp(top, 0, height);
  const visibleBottom = clamp(bottom, 0, height);
  const visibleLeft = clamp(bounds.left, 0, width);
  const visibleRight = clamp(bounds.right, 0, width);

  if (visibleBottom - visibleTop <= 1 || visibleRight - visibleLeft <= 1) return;

  ctx.save();
  ctx.fillStyle = "rgba(125, 211, 252, 0.13)";
  ctx.fillRect(visibleLeft, visibleTop, visibleRight - visibleLeft, visibleBottom - visibleTop);
  ctx.strokeStyle = "rgba(125, 211, 252, 0.96)";
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 5]);
  ctx.strokeRect(
    visibleLeft + 1,
    visibleTop + 1,
    Math.max(2, visibleRight - visibleLeft - 2),
    Math.max(2, visibleBottom - visibleTop - 2)
  );
  ctx.setLineDash([]);
  ctx.restore();
}

function paintNowLine(ctx: CanvasRenderingContext2D, width: number, height: number, mode: PracticeMode) {
  ctx.strokeStyle = mode === "wait" ? "#f6c453" : "#a78bfa";
  ctx.lineWidth = 3;
  ctx.shadowColor = mode === "wait" ? "#f6c453" : "#a78bfa";
  ctx.shadowBlur = 16;
  ctx.beginPath();
  ctx.moveTo(0, height - 2);
  ctx.lineTo(width, height - 2);
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function paintActiveKeys(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  geometry: KeyGeometry,
  activePitches: Set<number>
) {
  activePitches.forEach((midi) => {
    const relativeX = geometry.xByMidi.get(midi);
    if (relativeX === undefined) return;
    const keyWidth = (geometry.widthByMidi.get(midi) ?? geometry.whiteWidth) * width;
    ctx.fillStyle = "rgba(34, 211, 238, 0.18)";
    ctx.fillRect(relativeX * width, height - 44, keyWidth, 42);
  });
}

function paintRuler(ctx: CanvasRenderingContext2D, width: number, height: number, cursorSec: number, durationSec: number) {
  ctx.fillStyle = "rgba(5,6,7,0.68)";
  roundRect(ctx, 14, 14, 144, 34, 8);
  ctx.fill();
  ctx.fillStyle = "#f8f7fb";
  ctx.font = "600 13px Inter, system-ui, sans-serif";
  ctx.fillText(`${formatClock(cursorSec)} / ${formatClock(durationSec)}`, 28, 36);

  ctx.fillStyle = "rgba(255,255,255,0.58)";
  ctx.font = "500 11px Inter, system-ui, sans-serif";
  for (const midi of [24, 36, 48, 60, 72, 84, 96, 108]) {
    const x = geometryXLabel(width, midi);
    if (x > 4 && x < width - 28) ctx.fillText(midiToNoteName(midi), x, height - 56);
  }
}

function geometryXLabel(width: number, midi: number): number {
  const keys = buildPianoKeys();
  const whiteKeys = keys.filter((key) => !key.black);
  const key = keys.find((item) => item.midi === midi);
  if (!key) return 0;
  const minWhiteIndex = whiteKeys[0]?.whiteIndex ?? 0;
  const whiteWidth = width / Math.max(1, whiteKeys.length);
  return (key.whiteIndex - minWhiteIndex) * whiteWidth + 4;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function activeLoopSelectionColor(color: string): string {
  switch (color.toLowerCase()) {
    case "#22d3ee":
      return "#0268a3";
    case "#fb6fae":
    case "#f472b6":
      return "#c73681";
    case "#a78bfa":
      return "#7c3aed";
    case "#34d399":
      return "#15803d";
    case "#f6c453":
      return "#d97706";
    default:
      return darkenHexColor(color, 0.58);
  }
}

function darkenHexColor(color: string, factor: number): string {
  const hex = color.startsWith("#") ? color.slice(1) : color;
  if (!/^[0-9a-f]{6}$/i.test(hex)) return color;

  const value = Number.parseInt(hex, 16);
  const r = Math.round(((value >> 16) & 255) * factor);
  const g = Math.round(((value >> 8) & 255) * factor);
  const b = Math.round((value & 255) * factor);
  return `rgb(${r}, ${g}, ${b})`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeWheelDelta(event: globalThis.WheelEvent, hostHeight: number): number {
  if (event.deltaMode === 1) return event.deltaY * 18;
  if (event.deltaMode === 2) return event.deltaY * hostHeight;
  return event.deltaY;
}

function formatClock(value: number): string {
  const seconds = Math.max(0, Math.round(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
