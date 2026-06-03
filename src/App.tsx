import {
  ArrowUpDown,
  Cable,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Gauge,
  Keyboard,
  ListMusic,
  Music2,
  Minus,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Repeat2,
  Search,
  SlidersHorizontal,
  Square,
  Upload,
  Volume2,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { MidiInputEvent } from "./hooks/useWebMidi";
import { useWebMidi } from "./hooks/useWebMidi";
import { audioEngine } from "./lib/audioEngine";
import { createBuiltInLesson, filterSongNotes, parseMidiFile } from "./lib/midiParser";
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
  snapLoopRangeToNotes,
  STRICT_CHORD_GRACE_MS,
  type RecentPitchTouch
} from "./lib/practice";
import { downloadMidi, searchSongs } from "./lib/songApi";
import { PianoKeyboard } from "./components/PianoKeyboard";
import { PracticeCanvas } from "./components/PracticeCanvas";
import type { LoopRange, NormalizedNote, NormalizedSong, PracticeMode, PracticeStats, SongSearchResult } from "../shared/types";
import {
  clampMidi,
  formatDuration,
  midiForKeyboardCode,
  midiToNoteName,
  PIANO_HIGH_MIDI,
  PIANO_LOW_MIDI
} from "../shared/music";

const EMPTY_STATS: PracticeStats = { correct: 0, wrong: 0, missed: 0, streak: 0 };
type SidePanelTab = "songs" | "tracks" | "controls" | "stats";
type AccentThemeId = "purple" | "teal" | "gold" | "blue" | "pink";

const DEFAULT_ACCENT_THEME: AccentThemeId = "gold";
const ACCENT_KEY = "piano-studio-accent-theme";
const ACCENT_THEMES: Array<{
  id: AccentThemeId;
  label: string;
  color: string;
  rgb: string;
  dark: string;
}> = [
    { id: "gold", label: "Yellow", color: "#f6c453", rgb: "246, 196, 83", dark: "#b7791f" },
    { id: "purple", label: "Purple", color: "#a855f7", rgb: "168, 85, 247", dark: "#6d28d9" },
    { id: "teal", label: "Teal", color: "#34d399", rgb: "52, 211, 153", dark: "#047857" },
    { id: "blue", label: "Blue", color: "#38bdf8", rgb: "56, 189, 248", dark: "#0369a1" },
    { id: "pink", label: "Pink", color: "#fb7185", rgb: "251, 113, 133", dark: "#be123c" }
  ];

export function App() {
  const starterSong = useMemo(() => createBuiltInLesson(), []);
  const [song, setSong] = useState<NormalizedSong>(starterSong);
  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>(starterSong.tracks.map((track) => track.id));
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SongSearchResult[]>([]);
  const [searchError, setSearchError] = useState("");
  const [searching, setSearching] = useState(false);
  const [loadingSong, setLoadingSong] = useState("");
  const [mode, setMode] = useState<PracticeMode>("wait");
  const [isPlaying, setIsPlaying] = useState(false);
  const [isDemoPlaying, setIsDemoPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [cursorSec, setCursorSec] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [transpose, setTranspose] = useState(0);
  const [volume, setVolume] = useState(0.82);
  const [secondsVisible, setSecondsVisible] = useState(6);
  const [rangeMode, setRangeMode] = useState<"full" | "song">("full");
  const [keyboardBaseMidi, setKeyboardBaseMidi] = useState(60);
  const [metronome, setMetronome] = useState(false);
  const [sustainPedal, setSustainPedal] = useState(false);
  const [countIn, setCountIn] = useState(true);
  const [noteGlowEnabled, setNoteGlowEnabled] = useState(true);
  const [countdown, setCountdown] = useState(0);
  const [loopRange, setLoopRange] = useState<LoopRange | undefined>();
  const [sequenceRestartToken, setSequenceRestartToken] = useState(0);
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  const [missedIds, setMissedIds] = useState<Set<string>>(new Set());
  const [activePitches, setActivePitches] = useState<Set<number>>(new Set());
  const [stats, setStats] = useState<PracticeStats>(EMPTY_STATS);
  const [audioStatus, setAudioStatus] = useState(audioEngine.status);
  const [sidePanelOpen, setSidePanelOpen] = useState(true);
  const [activeSidePanel, setActiveSidePanel] = useState<SidePanelTab>("songs");
  const [accentThemeId, setAccentThemeId] = useState<AccentThemeId>(() => loadAccentTheme());

  const cursorRef = useSyncedRef(cursorSec);
  const completedRef = useSyncedRef(completedIds);
  const missedRef = useSyncedRef(missedIds);
  const playingRef = useSyncedRef(isPlaying);
  const demoPlayingRef = useSyncedRef(isDemoPlaying);
  const loopRangeRef = useSyncedRef(loopRange);
  const heldPitchesRef = useRef<Set<number>>(new Set());
  const recentPitchTouchesRef = useRef<Map<number, RecentPitchTouch>>(new Map());
  const demoStartedIdsRef = useRef<Set<string>>(new Set());
  const demoPitchCountsRef = useRef<Map<number, number>>(new Map());
  const demoStopTimersRef = useRef<number[]>([]);

  const practiceNotes = useMemo(() => {
    return filterSongNotes(song, selectedTrackIds)
      .map((note): NormalizedNote => ({ ...note, midi: clampMidi(note.midi + transpose) }))
      .sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);
  }, [selectedTrackIds, song, transpose]);
  const selectedTrackOrder = useMemo(
    () => song.tracks.map((track) => track.id).filter((trackId) => selectedTrackIds.includes(trackId)),
    [selectedTrackIds, song.tracks]
  );
  const loopNotes = useMemo(() => notesInLoopRange(practiceNotes, loopRange), [loopRange, practiceNotes]);
  const sessionNotes = loopRange ? loopNotes : practiceNotes;
  const notesRef = useSyncedRef(sessionNotes);

  const visibleRange = useMemo(() => {
    if (rangeMode === "full" || !practiceNotes.length) {
      return { low: PIANO_LOW_MIDI, high: PIANO_HIGH_MIDI };
    }

    const min = Math.min(...practiceNotes.map((note) => note.midi));
    const max = Math.max(...practiceNotes.map((note) => note.midi));
    return {
      low: clampMidi(min - 5),
      high: clampMidi(max + 5)
    };
  }, [practiceNotes, rangeMode]);

  const targetCluster = useMemo(
    () => (mode === "wait" ? getTargetCluster(sessionNotes, cursorSec, completedIds) : undefined),
    [completedIds, cursorSec, mode, sessionNotes]
  );
  const targetIds = useMemo(() => new Set(targetCluster?.notes.map((note) => note.id) ?? []), [targetCluster]);
  const targetPitches = useMemo(() => new Set(targetCluster?.notes.map((note) => note.midi) ?? []), [targetCluster]);
  const timelineStartSec = loopRange?.startSec ?? 0;
  const timelineEndSec = loopRange?.endSec ?? song.durationSec;
  const timelineDurationSec = Math.max(0.1, timelineEndSec - timelineStartSec);
  const timelineCursorSec = Math.min(timelineEndSec, Math.max(timelineStartSec, cursorSec));
  const completionPercent = Math.min(
    100,
    Math.round(((timelineCursorSec - timelineStartSec) / timelineDurationSec) * 100)
  );
  const playableNoteCount = sessionNotes.length || 1;
  const accuracy = Math.round((stats.correct / Math.max(1, stats.correct + stats.wrong + stats.missed)) * 100);
  const accentTheme = ACCENT_THEMES.find((theme) => theme.id === accentThemeId) ?? ACCENT_THEMES[0];
  const accentStyle = useMemo(
    () =>
      ({
        "--accent": accentTheme.color,
        "--accent-rgb": accentTheme.rgb,
        "--accent-dark": accentTheme.dark
      }) as CSSProperties,
    [accentTheme]
  );

  const clearDemoTimers = useCallback(() => {
    demoStopTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    demoStopTimersRef.current = [];
    demoPitchCountsRef.current.clear();
  }, []);

  const stopDemoPlayback = useCallback(() => {
    setIsDemoPlaying(false);
    demoStartedIdsRef.current.clear();
    heldPitchesRef.current.clear();
    recentPitchTouchesRef.current.clear();
    clearDemoTimers();
    audioEngine.allNotesOff();
    setSustainPedal(false);
    setActivePitches(new Set());
  }, [clearDemoTimers]);

  const clearInputMemory = useCallback(() => {
    heldPitchesRef.current.clear();
    recentPitchTouchesRef.current.clear();
  }, []);

  const resetAttemptState = useCallback(() => {
    demoStartedIdsRef.current.clear();
    clearDemoTimers();
    clearInputMemory();
    audioEngine.allNotesOff();
    setSustainPedal(false);
    setActivePitches(new Set());
    setWaiting(false);
    setCountdown(0);
    setCompletedIds(new Set());
    setMissedIds(new Set());
    setStats(EMPTY_STATS);
    metronomeBeatRef.current = -1;
  }, [clearDemoTimers, clearInputMemory]);

  const restartPracticeSequence = useCallback(
    (options: { keepTransport?: boolean; range?: LoopRange | null } = {}) => {
      const range = options.range === undefined ? loopRangeRef.current : options.range;
      const startSec = range?.startSec ?? 0;

      if (!options.keepTransport) {
        setIsPlaying(false);
        setIsDemoPlaying(false);
      }

      resetAttemptState();
      setCursorSec(startSec);
      setSequenceRestartToken((value) => value + 1);
    },
    [loopRangeRef, resetAttemptState]
  );

  const releaseDemoPitch = useCallback((pitch: number) => {
    const currentCount = demoPitchCountsRef.current.get(pitch) ?? 0;
    if (currentCount > 1) {
      demoPitchCountsRef.current.set(pitch, currentCount - 1);
      return;
    }

    demoPitchCountsRef.current.delete(pitch);
    audioEngine.stopNote(pitch);
    setActivePitches((current) => {
      if (!current.has(pitch)) return current;
      const next = new Set(current);
      next.delete(pitch);
      return next;
    });
  }, []);

  const triggerDemoNote = useCallback(
    (note: NormalizedNote, playbackSpeed: number) => {
      const pitch = clampMidi(note.midi);
      const currentCount = demoPitchCountsRef.current.get(pitch) ?? 0;
      demoPitchCountsRef.current.set(pitch, currentCount + 1);
      setActivePitches((current) => new Set(current).add(pitch));
      void audioEngine.playNote(pitch, note.velocity, { retrigger: currentCount > 0 }).finally(() => setAudioStatus(audioEngine.status));

      const holdMs = Math.max(80, (note.durationSec / Math.max(0.2, playbackSpeed)) * 1000);
      const timer = window.setTimeout(() => {
        releaseDemoPitch(pitch);
        demoStopTimersRef.current = demoStopTimersRef.current.filter((timerId) => timerId !== timer);
      }, holdMs);
      demoStopTimersRef.current.push(timer);
    },
    [releaseDemoPitch]
  );

  const handleNoteOn = useCallback(
    (midi: number, velocity = 0.76) => {
      const pitch = clampMidi(midi);
      const nowMs = performance.now();
      const wasHeld = heldPitchesRef.current.has(pitch);
      heldPitchesRef.current.add(pitch);
      recentPitchTouchesRef.current.set(pitch, { pressedAtMs: nowMs });
      setActivePitches((current) => new Set(current).add(pitch));
      audioEngine.playNote(pitch, velocity, { retrigger: wasHeld }).finally(() => setAudioStatus(audioEngine.status));

      const notes = notesRef.current;
      if (!notes.length) return;
      if (demoPlayingRef.current) return;

      if (mode === "wait") {
        const target = getTargetCluster(notes, cursorRef.current, completedRef.current);
        const nearTarget = target && cursorRef.current >= target.time - 0.28;
        const chordPitches = collectStrictChordPitches(heldPitchesRef.current, recentPitchTouchesRef.current, nowMs);
        const judged = judgeStrictInput(pitch, nearTarget ? target : undefined, chordPitches);

        if (judged.judgement === "correct") {
          const nextCompleted = new Set(completedRef.current);
          judged.matchedIds.forEach((id) => nextCompleted.add(id));
          setCompletedIds((current) => withAddedIds(current, judged.matchedIds));
          setStats((current) => applyJudgement(current, "correct", judged.matchedIds.length));
          setWaiting(false);
          if (target) setCursorSec(Math.max(cursorRef.current, target.time));
          if (loopRangeRef.current && notes.every((note) => nextCompleted.has(note.id))) {
            window.setTimeout(() => restartPracticeSequence({ keepTransport: true }), 120);
          }
        } else if (judged.judgement === "wrong" && (isPlaying || waiting)) {
          setStats((current) => applyJudgement(current, "wrong"));
        }
        return;
      }

      if (playingRef.current) {
        const judged = judgeContinuousInput(pitch, notes, cursorRef.current, completedRef.current);
        if (judged.judgement === "correct") {
          setCompletedIds((current) => withAddedIds(current, judged.matchedIds));
          setStats((current) => applyJudgement(current, "correct", judged.matchedIds.length));
        } else {
          setStats((current) => applyJudgement(current, "wrong"));
        }
      }
    },
    [completedRef, cursorRef, demoPlayingRef, isPlaying, loopRangeRef, mode, notesRef, playingRef, restartPracticeSequence, waiting]
  );

  const handleNoteOff = useCallback((midi: number) => {
    const pitch = clampMidi(midi);
    const nowMs = performance.now();
    const touch = recentPitchTouchesRef.current.get(pitch);
    heldPitchesRef.current.delete(pitch);
    recentPitchTouchesRef.current.set(pitch, {
      pressedAtMs: touch?.pressedAtMs ?? nowMs,
      releasedAtMs: nowMs
    });
    window.setTimeout(() => {
      recentPitchTouchesRef.current = pruneRecentPitchTouches(
        heldPitchesRef.current,
        recentPitchTouchesRef.current,
        performance.now()
      );
    }, STRICT_CHORD_GRACE_MS + 20);
    setActivePitches((current) => {
      const next = new Set(current);
      next.delete(pitch);
      return next;
    });
    audioEngine.stopNote(pitch);
  }, []);

  const handleMidiEvent = useCallback(
    (event: MidiInputEvent) => {
      if (event.type === "noteon" && event.midi !== undefined) handleNoteOn(event.midi, event.velocity);
      if (event.type === "noteoff" && event.midi !== undefined) handleNoteOff(event.midi);
      if (event.type === "pedal") {
        const pedalDown = Boolean(event.pedalDown);
        setSustainPedal(pedalDown);
        pedalDown ? audioEngine.pedalDown() : audioEngine.pedalUp();
      }
    },
    [handleNoteOff, handleNoteOn]
  );

  const setSustainPedalDown = useCallback((pedalDown: boolean) => {
    setSustainPedal(pedalDown);
    pedalDown ? audioEngine.pedalDown() : audioEngine.pedalUp();
  }, []);

  const midi = useWebMidi(handleMidiEvent);

  useEffect(() => {
    audioEngine.setVolume(volume);
  }, [volume]);

  useEffect(() => {
    try {
      localStorage.setItem(ACCENT_KEY, accentThemeId);
    } catch {
      // Ignore storage failures; the selected accent still applies for this session.
    }
  }, [accentThemeId]);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.repeat || isEditableTarget(event.target)) return;
      if (event.code === "KeyR") {
        event.preventDefault();
        restartPracticeSequence({ keepTransport: true });
        return;
      }
      const midi = midiForKeyboardCode(event.code, keyboardBaseMidi);
      if (midi === undefined) return;
      event.preventDefault();
      handleNoteOn(midi, 0.72);
    };
    const up = (event: KeyboardEvent) => {
      const midi = midiForKeyboardCode(event.code, keyboardBaseMidi);
      if (midi === undefined) return;
      event.preventDefault();
      handleNoteOff(midi);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [handleNoteOff, handleNoteOn, keyboardBaseMidi, restartPracticeSequence]);

  useEffect(() => {
    if (!isPlaying) return;
    let frame = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const delta = Math.min(0.08, (now - last) / 1000);
      last = now;

      setCursorSec((current) => {
        const notes = notesRef.current;
        if (!notes.length) return current;
        const range = loopRangeRef.current;
        const loopStartSec = range?.startSec ?? 0;
        const loopEndSec = range?.endSec ?? song.durationSec;
        const boundedCurrent = Math.min(loopEndSec, Math.max(loopStartSec, current));

        if (mode === "wait") {
          const target = getTargetCluster(notes, boundedCurrent, completedRef.current);
          if (!target && range) {
            resetAttemptState();
            return loopStartSec;
          }
          if (target && boundedCurrent >= target.time - 0.012) {
            setWaiting(true);
            return target.time;
          }
        }

        setWaiting(false);
        const next = Math.min(loopEndSec, boundedCurrent + delta * speed);

        if (mode === "continuous") {
          const missed = countMissedNotes(notes, next, completedRef.current, missedRef.current);
          if (missed.length) {
            setMissedIds((currentMissed) => withAddedIds(currentMissed, missed));
            setStats((currentStats) => applyMisses(currentStats, missed.length));
          }
        }

        if (next >= loopEndSec) {
          if (range) {
            resetAttemptState();
            return loopStartSec;
          }
          setIsPlaying(false);
        }
        return next;
      });

      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [completedRef, isPlaying, loopRangeRef, missedRef, mode, notesRef, resetAttemptState, song.durationSec, speed]);

  useEffect(() => {
    if (!isDemoPlaying) return;
    let frame = 0;
    let last = performance.now();
    const initialRange = loopRangeRef.current;
    let playhead = Math.min(
      initialRange?.endSec ?? song.durationSec,
      Math.max(initialRange?.startSec ?? 0, cursorRef.current)
    );

    const tick = (now: number) => {
      const delta = Math.min(0.08, (now - last) / 1000);
      last = now;

      const notes = notesRef.current;
      if (!notes.length || song.durationSec <= 0) {
        setIsDemoPlaying(false);
        demoStartedIdsRef.current.clear();
        return;
      }

      const range = loopRangeRef.current;
      const loopStartSec = range?.startSec ?? 0;
      const loopEndSec = range?.endSec ?? song.durationSec;
      const current = Math.min(loopEndSec, Math.max(loopStartSec, playhead));
      const next = Math.min(loopEndSec, current + delta * speed);
      const dueNotes = notesStartingInRange(notes, current - 0.012, next + 0.018).filter(
        (note) => !demoStartedIdsRef.current.has(note.id)
      );

      if (dueNotes.length) {
        dueNotes.forEach((note) => {
          demoStartedIdsRef.current.add(note.id);
          triggerDemoNote(note, speed);
        });
        setCompletedIds((current) => withAddedIds(current, dueNotes.map((note) => note.id)));
      }

      setCursorSec(next);
      playhead = next;

      if (next >= loopEndSec) {
        if (range) {
          resetAttemptState();
          playhead = loopStartSec;
          setCursorSec(loopStartSec);
          frame = requestAnimationFrame(tick);
          return;
        }
        setIsDemoPlaying(false);
        demoStartedIdsRef.current.clear();
        return;
      }

      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [
    cursorRef,
    isDemoPlaying,
    loopRangeRef,
    notesRef,
    resetAttemptState,
    sequenceRestartToken,
    song.durationSec,
    speed,
    triggerDemoNote
  ]);

  useEffect(() => {
    if (!metronome || (!isPlaying && !isDemoPlaying) || !song.bpm) return;
    const beatLength = 60 / song.bpm;
    const beat = Math.floor(cursorSec / beatLength);
    if (beat < 0 || beat === metronomeBeatRef.current) return;
    metronomeBeatRef.current = beat;
    const pitch = beat % 4 === 0 ? 96 : 84;
    audioEngine.playNote(pitch, beat % 4 === 0 ? 0.26 : 0.18).then(() => {
      window.setTimeout(() => audioEngine.stopNote(pitch), 70);
    });
  }, [cursorSec, isDemoPlaying, isPlaying, metronome, song.bpm]);

  const doSearch = useCallback(async () => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      setResults([]);
      setSearchError("");
      return;
    }

    setSearching(true);
    setSearchError("");
    try {
      const response = await searchSongs(trimmedQuery, "bitmidi");
      setResults(response.results);
      setSearchError(response.errors?.join(" | ") ?? "");
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : "Search failed");
    } finally {
      setSearching(false);
    }
  }, [query]);

  const resetPractice = useCallback(
    (duration = song.durationSec, range?: LoopRange | null) => {
      restartPracticeSequence({ range });
      if (duration <= 0) setCursorSec(0);
    },
    [restartPracticeSequence, song.durationSec]
  );

  const loadSong = useCallback(
    (nextSong: NormalizedSong) => {
      setSong(nextSong);
      setSelectedTrackIds(nextSong.tracks.map((track) => track.id));
      setTranspose(0);
      setLoopRange(undefined);
      resetPractice(nextSong.durationSec, null);
    },
    [resetPractice]
  );

  const loadResult = useCallback(
    async (result: SongSearchResult) => {
      setLoadingSong(result.id);
      setSearchError("");
      try {
        const buffer = await downloadMidi(result);
        const parsed = parseMidiFile(buffer, {
          id: result.id,
          title: result.title,
          artist: result.artist,
          source: result.source
        });
        loadSong(parsed);
      } catch (error) {
        setSearchError(error instanceof Error ? error.message : "Could not load song");
      } finally {
        setLoadingSong("");
      }
    },
    [loadSong]
  );

  const seekTo = useCallback(
    (value: number) => {
      const bounded = Math.min(timelineEndSec, Math.max(timelineStartSec, value));
      const completedBefore = new Set(sessionNotes.filter((note) => note.startSec < bounded - 0.04).map((note) => note.id));
      stopDemoPlayback();
      setCursorSec(bounded);
      setCompletedIds(completedBefore);
      setMissedIds(new Set());
      setWaiting(false);
      setStats(EMPTY_STATS);
    },
    [sessionNotes, stopDemoPlayback, timelineEndSec, timelineStartSec]
  );

  const seekCanvasViewport = useCallback(
    (value: number) => {
      const bounded = Math.min(song.durationSec, Math.max(0, value));
      const completedBefore = new Set(practiceNotes.filter((note) => note.startSec < bounded - 0.04).map((note) => note.id));
      stopDemoPlayback();
      setIsPlaying(false);
      setCursorSec(bounded);
      setCompletedIds(completedBefore);
      setMissedIds(new Set());
      setWaiting(false);
      setStats(EMPTY_STATS);
    },
    [practiceNotes, song.durationSec, stopDemoPlayback]
  );

  const selectLoopRange = useCallback(
    (range: LoopRange) => {
      const snapped = snapLoopRangeToNotes(range, practiceNotes, song.durationSec);
      if (!snapped) return;
      setLoopRange(snapped);
      setIsPlaying(false);
      setIsDemoPlaying(false);
      resetAttemptState();
    },
    [practiceNotes, resetAttemptState, song.durationSec]
  );

  const clearLoopRange = useCallback(() => {
    setLoopRange(undefined);
    restartPracticeSequence({ range: null });
  }, [restartPracticeSequence]);

  const startDemoPlayback = useCallback(async () => {
    if (countdown) return;
    stopDemoPlayback();
    clearInputMemory();
    await audioEngine.ensureReady().finally(() => setAudioStatus(audioEngine.status));

    const range = loopRangeRef.current;
    const loopStartSec = range?.startSec ?? 0;
    const loopEndSec = range?.endSec ?? song.durationSec;
    const cursor = cursorRef.current;
    const startAt = cursor >= loopEndSec - 0.04 || cursor < loopStartSec ? loopStartSec : cursor;
    const completedBefore = new Set(sessionNotes.filter((note) => note.startSec < startAt - 0.04).map((note) => note.id));
    demoStartedIdsRef.current = new Set(completedBefore);
    setIsPlaying(false);
    setWaiting(false);
    setCountdown(0);
    setMissedIds(new Set());
    setCompletedIds(completedBefore);
    setCursorSec(startAt);
    metronomeBeatRef.current = -1;
    setIsDemoPlaying(true);
  }, [clearInputMemory, countdown, cursorRef, loopRangeRef, sessionNotes, song.durationSec, stopDemoPlayback]);

  const toggleDemoPlayback = useCallback(() => {
    if (isDemoPlaying) {
      stopDemoPlayback();
      return;
    }
    void startDemoPlayback();
  }, [isDemoPlaying, startDemoPlayback, stopDemoPlayback]);

  const startPlayback = useCallback(async () => {
    if (countdown) return;
    stopDemoPlayback();
    const range = loopRangeRef.current;
    if (range && (cursorRef.current < range.startSec || cursorRef.current >= range.endSec - 0.04)) {
      setCursorSec(range.startSec);
      setCompletedIds(new Set());
      setMissedIds(new Set());
      setStats(EMPTY_STATS);
    }
    await audioEngine.ensureReady().finally(() => setAudioStatus(audioEngine.status));
    if (!countIn) {
      setIsPlaying(true);
      return;
    }

    const beatMs = Math.max(320, Math.min(920, (60 / (song.bpm || 96)) * 1000));
    for (let count = 4; count >= 1; count -= 1) {
      setCountdown(count);
      await delay(beatMs);
    }
    setCountdown(0);
    setIsPlaying(true);
  }, [countIn, countdown, cursorRef, loopRangeRef, song.bpm, stopDemoPlayback]);

  const togglePlay = useCallback(() => {
    if (isPlaying) {
      setIsPlaying(false);
      setWaiting(false);
      return;
    }
    void startPlayback();
  }, [isPlaying, startPlayback]);

  useEffect(() => {
    if (demoPlayingRef.current) stopDemoPlayback();
  }, [demoPlayingRef, selectedTrackIds, stopDemoPlayback, transpose]);

  useEffect(() => {
    if (loopRange && !loopNotes.length) {
      setLoopRange(undefined);
      restartPracticeSequence({ range: null });
    }
  }, [loopNotes.length, loopRange, restartPracticeSequence]);

  const stopTransport = useCallback(() => {
    setIsPlaying(false);
    setWaiting(false);
    setCountdown(0);
    stopDemoPlayback();
    clearInputMemory();
  }, [clearInputMemory, stopDemoPlayback]);

  const onUpload = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setLoadingSong(file.name);
      try {
        const buffer = await file.arrayBuffer();
        const parsed = parseMidiFile(buffer, {
          id: `upload-${file.name}-${file.lastModified}`,
          title: file.name.replace(/\.(mid|midi)$/i, ""),
          source: "upload"
        });
        loadSong(parsed);
      } catch (error) {
        setSearchError(error instanceof Error ? error.message : "Could not parse MIDI file");
      } finally {
        setLoadingSong("");
      }
    },
    [loadSong]
  );

  const toggleTrack = useCallback((trackId: string) => {
    setSelectedTrackIds((current) => {
      if (current.includes(trackId) && current.length > 1) return current.filter((id) => id !== trackId);
      if (current.includes(trackId)) return current;
      return [...current, trackId];
    });
  }, []);

  return (
    <div className="appShell" style={accentStyle}>
      <header className="topBar">
        <div className="brandLockup">
          <div className="appMark">
            <AppLogo />
          </div>
          <div className="brandText">
            <h1>PIANO STUDIO</h1>
          </div>
        </div>
        <div className="topActions">
          <button className="iconTextButton" onClick={midi.connect} disabled={midi.permissionState === "connecting"}>
            {midi.permissionState === "ready" ? <span className="midiStatusDot" aria-hidden="true" /> : null}
            <Cable size={18} />
            {midi.permissionState === "ready" ? "MIDI Ready" : midi.permissionState === "unsupported" ? "No Web MIDI" : "Connect MIDI"}
          </button>
          {midi.devices.length > 1 ? (
            <select
              className="deviceSelect"
              value={midi.selectedDeviceId}
              onChange={(event) => midi.setSelectedDeviceId(event.target.value)}
              aria-label="MIDI input"
            >
              {midi.devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      </header>

      <main className={`studioLayout ${sidePanelOpen ? "" : "sideCollapsed"}`}>
        {sidePanelOpen ? (
          <aside className="sidePanel">
            <div className="sidePanelTop">
              <div className="sidePanelTitle">
                <Music2 size={18} />
                <span>Studio</span>
              </div>
              <button className="collapseButton" onClick={() => setSidePanelOpen(false)} aria-label="Hide side panel">
                <PanelLeftClose size={18} />
              </button>
            </div>

            <div className="sideTabs" role="tablist" aria-label="Practice panels">
              <button
                className={activeSidePanel === "songs" ? "selected" : ""}
                onClick={() => setActiveSidePanel("songs")}
              >
                <Search size={16} />
                Songs
              </button>
              <button
                className={activeSidePanel === "tracks" ? "selected" : ""}
                onClick={() => setActiveSidePanel("tracks")}
              >
                <ListMusic size={16} />
                Tracks
              </button>
              <button
                className={activeSidePanel === "controls" ? "selected" : ""}
                onClick={() => setActiveSidePanel("controls")}
              >
                <SlidersHorizontal size={16} />
                Controls
              </button>
              <button
                className={activeSidePanel === "stats" ? "selected" : ""}
                onClick={() => setActiveSidePanel("stats")}
              >
                <Keyboard size={16} />
                Status
              </button>
            </div>

            <div className={`sidePanelBody ${activeSidePanel === "songs" ? "songsPanelHost" : ""}`}>
              {activeSidePanel === "songs" ? (
                <div className="songsPanelBody">
                  <section className="panelBlock songSearchPanel">
                    <div className="panelTitle">
                      <Search size={18} />
                      <h2>Song Search</h2>
                    </div>
                    <form
                      className="searchForm"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void doSearch();
                      }}
                    >
                      <input
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder="Search"
                      />
                      <button type="submit" disabled={searching}>
                        {searching ? <RefreshCw size={17} className="spin" /> : <Search size={17} />}
                      </button>
                    </form>
                    {searchError ? <p className="inlineWarning">{searchError}</p> : null}
                    <div className="resultList">
                      {results.map((result) => (
                        <button
                          className="resultItem"
                          key={`${result.source}-${result.id}`}
                          onClick={() => void loadResult(result)}
                          disabled={Boolean(loadingSong)}
                        >
                          <span>
                            <strong>{result.title}</strong>
                            <small>{[result.artist, result.difficulty, result.licenseLabel].filter(Boolean).join(" | ")}</small>
                          </span>
                          <em>{loadingSong === result.id ? "Loading" : result.source}</em>
                        </button>
                      ))}
                    </div>
                  </section>

                  <section className="panelBlock importPanel">
                    <div className="panelTitle">
                      <Upload size={18} />
                      <h2>Import</h2>
                    </div>
                    <label className="uploadTarget">
                      <Upload size={19} />
                      <span>
                        <strong>{loadingSong && !results.some((result) => result.id === loadingSong) ? "Loading..." : "Choose MIDI file"}</strong>
                        <small>or drag and drop .mid / .midi</small>
                      </span>
                      <input type="file" accept=".mid,.midi,audio/midi" onChange={(event) => void onUpload(event.target.files?.[0])} />
                    </label>
                  </section>
                </div>
              ) : null}

              {activeSidePanel === "tracks" ? (
                <section className="panelBlock">
                  <div className="panelTitle">
                    <ListMusic size={18} />
                    <h2>Tracks</h2>
                  </div>
                  <div className="trackList">
                    {song.tracks.map((track) => (
                      <label className="trackRow" key={track.id}>
                        <input
                          type="checkbox"
                          checked={selectedTrackIds.includes(track.id)}
                          onChange={() => toggleTrack(track.id)}
                        />
                        <span>
                          <strong>{track.name}</strong>
                          <small>
                            {track.noteCount} notes - {midiToNoteName(track.pitchMin)}-{midiToNoteName(track.pitchMax)}
                          </small>
                        </span>
                      </label>
                    ))}
                  </div>
                </section>
              ) : null}

              {activeSidePanel === "controls" ? (
                <section className="panelBlock controlStack">
                  <div className="panelTitle">
                    <SlidersHorizontal size={18} />
                    <h2>Controls</h2>
                  </div>
                  <ControlSlider icon={<ChevronDown size={17} />} label="Lookahead" value={secondsVisible} min={3} max={10} step={0.5} onChange={setSecondsVisible} suffix="s" />
                  <div className="stepperRow">
                    <span>Typing Octave</span>
                    <div>
                      <button onClick={() => setKeyboardBaseMidi((value) => clampMidi(value - 12))}>
                        <ChevronLeft size={16} />
                      </button>
                      <strong>{midiToNoteName(keyboardBaseMidi)}</strong>
                      <button onClick={() => setKeyboardBaseMidi((value) => clampMidi(value + 12))}>
                        <ChevronRight size={16} />
                      </button>
                    </div>
                  </div>
                  <div className="accentChooser">
                    <span>
                      <Palette size={17} />
                      Accent
                    </span>
                    <div>
                      {ACCENT_THEMES.map((theme) => (
                        <button
                          type="button"
                          className={`accentSwatch ${accentThemeId === theme.id ? "selected" : ""}`}
                          key={theme.id}
                          onClick={() => setAccentThemeId(theme.id)}
                          style={{ "--swatch": theme.color } as CSSProperties}
                          aria-label={`${theme.label} accent`}
                        />
                      ))}
                    </div>
                  </div>
                  <label className="toggleRow">
                    <input type="checkbox" checked={countIn} onChange={(event) => setCountIn(event.target.checked)} />
                    <span>Count-in</span>
                  </label>
                  <label className="toggleRow">
                    <input type="checkbox" checked={rangeMode === "song"} onChange={(event) => setRangeMode(event.target.checked ? "song" : "full")} />
                    <span>Range zoom</span>
                  </label>
                  <label className="toggleRow">
                    <input type="checkbox" checked={noteGlowEnabled} onChange={(event) => setNoteGlowEnabled(event.target.checked)} />
                    <span>Note glow</span>
                  </label>
                </section>
              ) : null}

              {activeSidePanel === "stats" ? (
                <>
                  <section className="panelBlock statsBlock">
                    <div>
                      <strong>{accuracy}%</strong>
                      <span>Accuracy</span>
                    </div>
                    <div>
                      <strong>{stats.streak}</strong>
                      <span>Streak</span>
                    </div>
                    <div>
                      <strong>{stats.correct}</strong>
                      <span>Hit</span>
                    </div>
                    <div>
                      <strong>{stats.wrong + stats.missed}</strong>
                      <span>Miss</span>
                    </div>
                  </section>

                  <section className="panelBlock smallReadout">
                    <div>
                      <Keyboard size={18} />
                      <span>{midi.permissionState === "ready" ? `${midi.devices.length || 1} MIDI input` : "Keyboard fallback"}</span>
                    </div>
                    <div>
                      <Volume2 size={18} />
                      <span>{audioStatus === "fallback" ? "Synth fallback" : audioStatus === "ready" ? "Grand samples" : "Audio idle"}</span>
                    </div>
                    <div>
                      <ListMusic size={18} />
                      <span>
                        {completedIds.size}/{playableNoteCount} notes
                      </span>
                    </div>
                  </section>
                </>
              ) : null}
            </div>
          </aside>
        ) : (
          <button
            className="sideRailToggle"
            onClick={() => setSidePanelOpen(true)}
            aria-label="Show side panel"
          >
            <PanelLeftOpen size={19} />
          </button>
        )}

        <section className="practicePanel">
          <div className="transportBar">
            <div className="transportTop">
              <div className="transportControls">
                <button className="roundButton primary" onClick={togglePlay} disabled={Boolean(countdown)} aria-label={isPlaying ? "Pause" : "Play"}>
                  {isPlaying ? <Pause size={24} /> : <Play size={24} />}
                </button>
                <button className="roundButton" onClick={stopTransport} aria-label="Stop">
                  <Square size={18} fill="currentColor" />
                </button>
                <button className="roundButton" onClick={() => resetPractice()} aria-label="Restart">
                  <RefreshCw size={18} />
                </button>
                <button
                  className={`demoButton ${isDemoPlaying ? "active" : ""}`}
                  onClick={toggleDemoPlayback}
                  disabled={Boolean(countdown)}
                  aria-label={isDemoPlaying ? "Stop demo playback" : "Play demo automatically"}
                >
                  {isDemoPlaying ? <Pause size={16} /> : <Music2 size={16} />}
                  <span>{isDemoPlaying ? "Stop" : "Demo"}</span>
                </button>
              </div>

              <div className="transportSong">
                <strong>{song.title}</strong>
              </div>

              <div className="transportReadout">
                <strong>
                  {formatDuration(timelineCursorSec)}
                  <span>/ {formatDuration(timelineEndSec)}</span>
                </strong>
                <small>{completionPercent}% Complete</small>
              </div>

              <div className="modeSwitch" role="group" aria-label="Practice mode">
                <button className={mode === "wait" ? "selected" : ""} onClick={() => setMode("wait")}>
                  Wait
                </button>
                <button className={mode === "continuous" ? "selected" : ""} onClick={() => setMode("continuous")}>
                  Flow
                </button>
              </div>
            </div>

            <div className="transportProgress">
              <span>{formatDuration(timelineStartSec)}</span>
              <input
                type="range"
                min={timelineStartSec}
                max={Math.max(timelineStartSec + 0.1, timelineEndSec)}
                step={0.01}
                value={timelineCursorSec}
                onChange={(event) => seekTo(Number(event.target.value))}
              />
              <span>{formatDuration(timelineEndSec)}</span>
            </div>
          </div>

          {loopRange ? (
            <div className="loopBar">
              <div>
                <Repeat2 size={17} />
                <strong>
                  {formatDuration(loopRange.startSec)} - {formatDuration(loopRange.endSec)}
                </strong>
                <span>{loopNotes.length} notes</span>
              </div>
              <div>
                <button onClick={() => restartPracticeSequence({ keepTransport: true })}>
                  <RefreshCw size={16} />
                  Restart
                </button>
                <button onClick={clearLoopRange}>
                  <X size={16} />
                  Clear
                </button>
              </div>
            </div>
          ) : null}

          <div className="instrumentDeck">
            <div className="canvasStage">
              <PracticeCanvas
                notes={practiceNotes}
                trackIds={selectedTrackOrder}
                cursorSec={cursorSec}
                durationSec={song.durationSec}
                mode={mode}
                activePitches={activePitches}
                targetIds={targetIds}
                completedIds={completedIds}
                missedIds={missedIds}
                lowMidi={visibleRange.low}
                highMidi={visibleRange.high}
                secondsVisible={secondsVisible}
                loopRange={loopRange}
                noteGlowEnabled={noteGlowEnabled}
                onLoopRangeSelect={selectLoopRange}
                onViewportCursorChange={seekCanvasViewport}
              />
              {isDemoPlaying ? (
                <div className="statusPill demoStatus">Demo playback</div>
              ) : waiting ? (
                <div className="statusPill">Waiting for {targetCluster?.notes.map((note) => midiToNoteName(note.midi)).join(" + ")}</div>
              ) : null}
              {countdown ? <div className="countdown">{countdown}</div> : null}
            </div>

            <PianoKeyboard
              activePitches={activePitches}
              targetPitches={targetPitches}
              lowMidi={visibleRange.low}
              highMidi={visibleRange.high}
              keyboardBaseMidi={keyboardBaseMidi}
              onPress={handleNoteOn}
              onRelease={handleNoteOff}
            />
          </div>

          <div className="bottomControlStrip">
            <label className="bottomSlider">
              <Volume2 size={17} />
              <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(event) => setVolume(Number(event.target.value))} />
              <strong>{Math.round(volume * 100)}%</strong>
            </label>
            <div className="bottomStepper">
              <Gauge size={17} />
              <span>Speed</span>
              <strong>{Number(speed.toFixed(2))}x</strong>
              <button onClick={() => setSpeed((value) => Math.max(0.35, Number((value - 0.05).toFixed(2))))} aria-label="Decrease speed">
                <Minus size={15} />
              </button>
              <button onClick={() => setSpeed((value) => Math.min(1.5, Number((value + 0.05).toFixed(2))))} aria-label="Increase speed">
                <Plus size={15} />
              </button>
            </div>
            <div className="bottomStepper">
              <ArrowUpDown size={17} />
              <span>Transpose</span>
              <strong>{transpose > 0 ? `+${transpose}` : transpose}</strong>
              <button onClick={() => setTranspose((value) => Math.max(-12, value - 1))} aria-label="Transpose down">
                <Minus size={15} />
              </button>
              <button onClick={() => setTranspose((value) => Math.min(12, value + 1))} aria-label="Transpose up">
                <Plus size={15} />
              </button>
            </div>
            <label className="bottomToggle">
              <MetronomeIcon />
              <span>Metronome</span>
              <input type="checkbox" checked={metronome} onChange={(event) => setMetronome(event.target.checked)} />
            </label>
            <label className="bottomToggle">
              <SustainIcon />
              <span>Sustain</span>
              <input type="checkbox" checked={sustainPedal} onChange={(event) => setSustainPedalDown(event.target.checked)} />
            </label>
          </div>
        </section>
      </main>
    </div>
  );
}

function MetronomeIcon() {
  return (
    <svg className="metronomeIcon" viewBox="0 0 24 24" role="img" aria-label="Metronome" aria-hidden="true">
      <path d="M8.5 3.5h7l3 16h-13l3-16Z" />
      <path d="M12 5.3v8.2" />
      <path d="M12 13.5l4.2-5.2" />
      <path d="M7.4 19.5h9.2" />
      <path d="M10 16h4" />
    </svg>
  );
}

function SustainIcon() {
  return (
    <svg className="sustainIcon" viewBox="0 0 24 24" role="img" aria-label="Sustain" aria-hidden="true">
      <path d="M5 17.5h14" />
      <path d="M7 17.5c.6-5.7 2.2-9.5 5-12.5 2.8 3 4.4 6.8 5 12.5" />
      <path d="M9.5 17.5c.3-2.8 1.1-5 2.5-6.7 1.4 1.7 2.2 3.9 2.5 6.7" />
      <path d="M8 20h8" />
    </svg>
  );
}

function AppLogo() {
  return (
    <svg className="logo" viewBox="-128 -128 256 256" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Logo">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      >
        <path d="M 0 -24 L 24 0 L 0 24 L -24 0 Z" />
        <g id="logo-arm">
          <path d="M 0 -114 L 42 -60 L 0 -24 L -42 -60 Z" />
          <path d="M 0 -114 L 0 -24" />
          <path d="M -42 -60 L 42 -60" />
          <path d="M -42 -60 L 0 -78 L 42 -60" />
        </g>
        <use href="#logo-arm" transform="rotate(90)" />
        <use href="#logo-arm" transform="rotate(180)" />
        <use href="#logo-arm" transform="rotate(270)" />
      </g>
    </svg>
  );
}

function ControlSlider({
  icon,
  label,
  value,
  min,
  max,
  step,
  suffix = "",
  onChange
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="controlSlider">
      <span>
        {icon}
        {label}
        <strong>
          {Number(value.toFixed(2))}
          {suffix}
        </strong>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function withAddedIds(current: Set<string>, ids: string[]): Set<string> {
  const next = new Set(current);
  ids.forEach((id) => next.add(id));
  return next;
}

function notesStartingInRange(notes: NormalizedNote[], startSec: number, endSec: number): NormalizedNote[] {
  const startIndex = findFirstNoteStartingAtOrAfter(notes, startSec);
  const matches: NormalizedNote[] = [];

  for (let index = startIndex; index < notes.length; index += 1) {
    const note = notes[index];
    if (note.startSec > endSec) break;
    matches.push(note);
  }

  return matches;
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

function useSyncedRef<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

const metronomeBeatRef = { current: -1 };

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) || element.isContentEditable;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function loadAccentTheme(): AccentThemeId {
  try {
    const stored = localStorage.getItem(ACCENT_KEY);
    return ACCENT_THEMES.some((theme) => theme.id === stored) ? (stored as AccentThemeId) : DEFAULT_ACCENT_THEME;
  } catch {
    return DEFAULT_ACCENT_THEME;
  }
}
