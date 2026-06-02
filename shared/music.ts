export const PIANO_LOW_MIDI = 21;
export const PIANO_HIGH_MIDI = 108;
export const PIANO_KEY_COUNT = PIANO_HIGH_MIDI - PIANO_LOW_MIDI + 1;

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const COMPUTER_KEYS = [
  "KeyA",
  "KeyW",
  "KeyS",
  "KeyE",
  "KeyD",
  "KeyF",
  "KeyT",
  "KeyG",
  "KeyY",
  "KeyH",
  "KeyU",
  "KeyJ",
  "KeyK",
  "KeyO",
  "KeyL",
  "KeyP",
  "Semicolon",
  "Quote"
];

export function midiToNoteName(midi: number): string {
  const octave = Math.floor(midi / 12) - 1;
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${octave}`;
}

export function noteNameToMidi(note: string): number {
  const match = /^([A-G])(#|b)?(-?\d+)$/.exec(note.trim());
  if (!match) {
    throw new Error(`Invalid note name: ${note}`);
  }

  const [, base, accidental = "", octaveRaw] = match;
  const normalized = `${base}${accidental}`;
  let pitch = NOTE_NAMES.indexOf(normalized);

  if (pitch === -1 && accidental === "b") {
    const natural = NOTE_NAMES.indexOf(base);
    pitch = (natural + 11) % 12;
  }

  if (pitch === -1) {
    throw new Error(`Invalid note name: ${note}`);
  }

  return (Number(octaveRaw) + 1) * 12 + pitch;
}

export function isBlackKey(midi: number): boolean {
  return [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
}

export function clampMidi(midi: number): number {
  return Math.min(PIANO_HIGH_MIDI, Math.max(PIANO_LOW_MIDI, midi));
}

export function keyLabelForMidi(midi: number, baseMidi = 60): string | undefined {
  const index = midi - baseMidi;
  const code = COMPUTER_KEYS[index];
  if (!code) return undefined;
  if (code.startsWith("Key")) return code.slice(3);
  if (code === "Semicolon") return ";";
  if (code === "Quote") return "'";
  return undefined;
}

export function midiForKeyboardCode(code: string, baseMidi = 60): number | undefined {
  const index = COMPUTER_KEYS.indexOf(code);
  if (index < 0) return undefined;
  return clampMidi(baseMidi + index);
}

export function formatDuration(totalSeconds?: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds === undefined) return "--:--";
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function buildPianoKeys(): Array<{ midi: number; note: string; black: boolean; whiteIndex: number }> {
  let whiteIndex = -1;
  return Array.from({ length: PIANO_KEY_COUNT }, (_, index) => {
    const midi = PIANO_LOW_MIDI + index;
    const black = isBlackKey(midi);
    if (!black) whiteIndex += 1;
    return {
      midi,
      note: midiToNoteName(midi),
      black,
      whiteIndex: black ? whiteIndex : whiteIndex
    };
  });
}
