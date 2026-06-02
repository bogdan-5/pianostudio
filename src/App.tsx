import {
  Cable,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Gauge,
  Keyboard,
  ListMusic,
  Music2,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  RefreshCw,
  Repeat2,
  Search,
  SlidersHorizontal,
  Upload,
  Volume2,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
const RECENT_KEY = "piano-learning-recent-songs";
type SidePanelTab = "songs" | "tracks" | "controls" | "stats";

export function App() {
  const starterSong = useMemo(() => createBuiltInLesson(), []);
  const [song, setSong] = useState<NormalizedSong>(starterSong);
  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>(starterSong.tracks.map((track) => track.id));
  const [query, setQuery] = useState("moonlight sonata");
  const [source, setSource] = useState("all");
  const [results, setResults] = useState<SongSearchResult[]>([]);
  const [recent, setRecent] = useState<SongSearchResult[]>(() => loadRecentSongs());
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
  const [countIn, setCountIn] = useState(true);
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
      if (event.type === "pedal") event.pedalDown ? audioEngine.pedalDown() : audioEngine.pedalUp();
    },
    [handleNoteOff, handleNoteOn]
  );

  const midi = useWebMidi(handleMidiEvent);

  useEffect(() => {
    audioEngine.setVolume(volume);
  }, [volume]);

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
      const dueNotes = notes.filter(
        (note) =>
          !demoStartedIdsRef.current.has(note.id) &&
          note.startSec >= current - 0.012 &&
          note.startSec <= next + 0.018
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
    setSearching(true);
    setSearchError("");
    try {
      const response = await searchSongs(query, source);
      setResults(response.results);
      setSearchError(response.errors?.join(" | ") ?? "");
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : "Search failed");
    } finally {
      setSearching(false);
    }
  }, [query, source]);

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
        rememberSong(result, setRecent);
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
      restartPracticeSequence({ range: snapped });
    },
    [practiceNotes, restartPracticeSequence, song.durationSec]
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
    <div className="appShell">
      <header className="topBar">
        <div>
          <p className="eyebrow">Piano Practice Studio</p>
          <h1>{song.title}</h1>
        </div>
        <div className="topActions">
          <button className="iconTextButton" onClick={midi.connect} disabled={midi.permissionState === "connecting"}>
            <Cable size={18} />
            {midi.permissionState === "ready" ? "MIDI Ready" : midi.permissionState === "unsupported" ? "No Web MIDI" : "Connect MIDI"}
          </button>
          <select
            className="deviceSelect"
            value={midi.selectedDeviceId}
            onChange={(event) => midi.setSelectedDeviceId(event.target.value)}
            aria-label="MIDI input"
          >
            {midi.devices.length ? (
              midi.devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                </option>
              ))
            ) : (
              <option value="">No device selected</option>
            )}
          </select>
        </div>
      </header>

      <main className={`studioLayout ${sidePanelOpen ? "" : "sideCollapsed"}`}>
        {sidePanelOpen ? (
          <aside className="sidePanel">
            <div className="sidePanelChrome">
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
              <button className="collapseButton" onClick={() => setSidePanelOpen(false)} aria-label="Hide side panel">
                <PanelLeftClose size={18} />
              </button>
            </div>

            <div className="sidePanelBody">
              {activeSidePanel === "songs" ? (
                <>
                  <section className="panelBlock">
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
                        placeholder="Search title, artist, or paste a MIDI URL"
                      />
                      <select value={source} onChange={(event) => setSource(event.target.value)} aria-label="Search source">
                        <option value="all">All</option>
                        <option value="bitmidi">BitMidi</option>
                        <option value="midishare">Midishare</option>
                        <option value="mutopia">Public Domain</option>
                      </select>
                      <button type="submit" disabled={searching}>
                        {searching ? <RefreshCw size={17} className="spin" /> : <Search size={17} />}
                      </button>
                    </form>
                    {searchError ? <p className="inlineWarning">{searchError}</p> : null}
                    <div className="resultList">
                      {(results.length ? results : recent).map((result) => (
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

                  <section className="panelBlock">
                    <div className="panelTitle">
                      <Upload size={18} />
                      <h2>Import</h2>
                    </div>
                    <label className="uploadTarget">
                      <Upload size={19} />
                      <span>{loadingSong && !results.some((result) => result.id === loadingSong) ? "Loading..." : "Choose MIDI file"}</span>
                      <input type="file" accept=".mid,.midi,audio/midi" onChange={(event) => void onUpload(event.target.files?.[0])} />
                    </label>
                  </section>
                </>
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
                  <ControlSlider icon={<Gauge size={17} />} label="Speed" value={speed} min={0.35} max={1.5} step={0.05} onChange={setSpeed} suffix="x" />
                  <ControlSlider icon={<Volume2 size={17} />} label="Volume" value={volume} min={0} max={1} step={0.01} onChange={setVolume} />
                  <ControlSlider icon={<ChevronDown size={17} />} label="Lookahead" value={secondsVisible} min={3} max={10} step={0.5} onChange={setSecondsVisible} suffix="s" />
                  <div className="stepperRow">
                    <span>Transpose</span>
                    <div>
                      <button onClick={() => setTranspose((value) => Math.max(-12, value - 1))}>
                        <ChevronLeft size={16} />
                      </button>
                      <strong>{transpose > 0 ? `+${transpose}` : transpose}</strong>
                      <button onClick={() => setTranspose((value) => Math.min(12, value + 1))}>
                        <ChevronRight size={16} />
                      </button>
                    </div>
                  </div>
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
                  <label className="toggleRow">
                    <input type="checkbox" checked={metronome} onChange={(event) => setMetronome(event.target.checked)} />
                    <span>Metronome</span>
                  </label>
                  <label className="toggleRow">
                    <input type="checkbox" checked={countIn} onChange={(event) => setCountIn(event.target.checked)} />
                    <span>Count-in</span>
                  </label>
                  <label className="toggleRow">
                    <input type="checkbox" checked={rangeMode === "song"} onChange={(event) => setRangeMode(event.target.checked ? "song" : "full")} />
                    <span>Range zoom</span>
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
            <div className="transportMain">
              <button className="roundButton primary" onClick={togglePlay} disabled={Boolean(countdown)}>
                {isPlaying ? <Pause size={22} /> : <Play size={22} />}
              </button>
              <button className="roundButton" onClick={stopTransport}>
                <CircleStop size={20} />
              </button>
              <button className="roundButton" onClick={() => resetPractice()}>
                <RefreshCw size={19} />
              </button>
              <button
                className={`demoButton ${isDemoPlaying ? "active" : ""}`}
                onClick={toggleDemoPlayback}
                disabled={Boolean(countdown)}
                aria-label={isDemoPlaying ? "Stop demo playback" : "Play demo automatically"}
              >
                {isDemoPlaying ? <Pause size={17} /> : <Music2 size={17} />}
                <span>{isDemoPlaying ? "Stop Demo" : "Demo"}</span>
              </button>
              <div className="songMeta">
                <strong>{isDemoPlaying ? "Demo playback" : loopRange ? "Loop practice" : song.artist || song.source || "Practice"}</strong>
                <span>
                  {formatDuration(timelineCursorSec)} / {formatDuration(timelineEndSec)} - {completionPercent}%
                </span>
              </div>
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

          <div className="progressStack">
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

            <div className="timelineRow">
              <span>{formatDuration(timelineCursorSec)}</span>
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

          <div className="canvasStage">
            <PracticeCanvas
              notes={practiceNotes}
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
        </section>
      </main>
    </div>
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

function loadRecentSongs(): SongSearchResult[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.slice(0, 5) : [];
  } catch {
    return [];
  }
}

function rememberSong(result: SongSearchResult, setRecent: (updater: (current: SongSearchResult[]) => SongSearchResult[]) => void) {
  setRecent((current) => {
    const next = [result, ...current.filter((item) => `${item.source}:${item.id}` !== `${result.source}:${result.id}`)].slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    return next;
  });
}
