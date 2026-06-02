import { Midi } from "@tonejs/midi";
import { describe, expect, it } from "vitest";
import { createBuiltInLesson, filterSongNotes, parseMidiFile } from "../src/lib/midiParser";

describe("midiParser", () => {
  it("normalizes MIDI notes, tempo, tracks, and piano pitch bounds", () => {
    const midi = new Midi();
    midi.header.setTempo(120);
    midi.header.timeSignatures.push({
      ticks: 0,
      timeSignature: [3, 4],
      measures: 0
    });
    const melody = midi.addTrack();
    melody.name = "Melody";
    melody.addNote({ midi: 60, time: 0, duration: 0.5, velocity: 0.8 });
    melody.addNote({ midi: 64, time: 1, duration: 0.5, velocity: 0.7 });
    melody.addNote({ midi: 8, time: 2, duration: 0.5, velocity: 0.7 });
    const bass = midi.addTrack();
    bass.name = "Bass";
    bass.addNote({ midi: 48, time: 0.25, duration: 0.75, velocity: 0.6 });

    const bytes = midi.toArray();
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const song = parseMidiFile(copy.buffer as ArrayBuffer, {
      title: "Specimen"
    });

    expect(song.title).toBe("Specimen");
    expect(song.bpm).toBe(120);
    expect(song.timeSignature).toEqual([3, 4]);
    expect(song.tracks).toHaveLength(2);
    expect(song.notes.map((note) => note.midi)).toEqual([60, 48, 64]);
    expect(song.pitchMin).toBe(48);
    expect(song.pitchMax).toBe(64);
  });

  it("filters notes by selected track ids", () => {
    const song = createBuiltInLesson();
    const filtered = filterSongNotes(song, ["track-starter"]);
    expect(filtered).toHaveLength(song.notes.length);
    expect(filterSongNotes(song, ["missing"])).toHaveLength(0);
  });

  it("ships a playable built-in starter lesson", () => {
    const lesson = createBuiltInLesson();
    expect(lesson.notes.length).toBeGreaterThan(8);
    expect(lesson.durationSec).toBeGreaterThan(lesson.notes.at(-1)!.startSec);
    expect(lesson.tracks[0].noteCount).toBe(lesson.notes.length);
  });
});
