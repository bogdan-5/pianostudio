import { Midi } from "@tonejs/midi";
import type { NormalizedNote, NormalizedSong, NormalizedTrack, SongSource } from "../../shared/types";
import { PIANO_HIGH_MIDI, PIANO_LOW_MIDI } from "../../shared/music";

type ParseMetadata = {
  id?: string;
  title?: string;
  artist?: string;
  source?: SongSource | "upload";
};

export function parseMidiFile(buffer: ArrayBuffer, metadata: ParseMetadata = {}): NormalizedSong {
  const midi = new Midi(buffer);
  const tracks: NormalizedTrack[] = [];
  const notes: NormalizedNote[] = [];

  midi.tracks.forEach((track, trackIndex) => {
    const playable = track.notes.filter((note) => note.midi >= PIANO_LOW_MIDI && note.midi <= PIANO_HIGH_MIDI);
    if (!playable.length) return;

    const trackId = `track-${trackIndex}`;
    const trackNotes = playable.map((note, noteIndex): NormalizedNote => {
      const midiValue = Math.round(note.midi);
      return {
        id: `${trackId}-${noteIndex}-${midiValue}-${Math.round(note.time * 1000)}`,
        midi: midiValue,
        startSec: roundTime(note.time),
        durationSec: Math.max(0.05, roundTime(note.duration)),
        velocity: clamp01(note.velocity || 0.75),
        trackId,
        hand: midiValue < 60 ? "left" : "right"
      };
    });

    const pitches = trackNotes.map((note) => note.midi);
    tracks.push({
      id: trackId,
      name: track.name || track.instrument.name || `Track ${trackIndex + 1}`,
      instrument: track.instrument.name,
      channel: track.channel,
      noteCount: trackNotes.length,
      pitchMin: Math.min(...pitches),
      pitchMax: Math.max(...pitches)
    });
    notes.push(...trackNotes);
  });

  notes.sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);
  const durationSec = Math.max(midi.duration || 0, ...notes.map((note) => note.startSec + note.durationSec), 1);
  const pitches = notes.map((note) => note.midi);
  const headerName = midi.header.name || midi.name || undefined;
  const firstTempo = midi.header.tempos[0]?.bpm;
  const firstSignature = midi.header.timeSignatures[0]?.timeSignature as [number, number] | undefined;

  return {
    id: metadata.id ?? `midi-${Date.now()}`,
    title: metadata.title || headerName || "Imported MIDI",
    artist: metadata.artist,
    source: metadata.source,
    durationSec: roundTime(durationSec),
    bpm: firstTempo ? Math.round(firstTempo) : undefined,
    timeSignature: firstSignature,
    pitchMin: pitches.length ? Math.min(...pitches) : PIANO_LOW_MIDI,
    pitchMax: pitches.length ? Math.max(...pitches) : PIANO_HIGH_MIDI,
    tracks,
    notes
  };
}

export function filterSongNotes(song: NormalizedSong, selectedTrackIds: string[]): NormalizedNote[] {
  const selected = new Set(selectedTrackIds.length ? selectedTrackIds : song.tracks.map((track) => track.id));
  return song.notes.filter((note) => selected.has(note.trackId));
}

export function createBuiltInLesson(): NormalizedSong {
  const pattern = [
    60, 62, 64, 65, 67, 69, 71, 72, 72, 71, 69, 67, 65, 64, 62, 60,
    55, 60, 64, 67, 72, 67, 64, 60
  ];
  const notes = pattern.map((midi, index): NormalizedNote => {
    const startSec = index * 0.62;
    return {
      id: `starter-${index}-${midi}`,
      midi,
      startSec,
      durationSec: index >= 16 ? 0.74 : 0.48,
      velocity: index >= 16 ? 0.72 : 0.62,
      trackId: "track-starter",
      hand: midi < 60 ? "left" : "right"
    };
  });

  return {
    id: "starter-lesson",
    title: "First Steps in C",
    artist: "Built-in lesson",
    source: "upload",
    durationSec: notes.at(-1)!.startSec + 1.4,
    bpm: 96,
    timeSignature: [4, 4],
    pitchMin: 55,
    pitchMax: 72,
    tracks: [
      {
        id: "track-starter",
        name: "Starter melody",
        instrument: "acoustic grand piano",
        channel: 0,
        noteCount: notes.length,
        pitchMin: 55,
        pitchMax: 72
      }
    ],
    notes
  };
}

function roundTime(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
