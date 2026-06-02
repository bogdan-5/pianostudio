import { memo, useMemo } from "react";
import { buildPianoKeys, isBlackKey, keyLabelForMidi, midiToNoteName, PIANO_HIGH_MIDI, PIANO_LOW_MIDI } from "../../shared/music";

type PianoKeyboardProps = {
  activePitches: Set<number>;
  targetPitches: Set<number>;
  completedPitches?: Set<number>;
  lowMidi?: number;
  highMidi?: number;
  keyboardBaseMidi: number;
  onPress: (midi: number, velocity?: number) => void;
  onRelease: (midi: number) => void;
};

const BLACK_KEY_WIDTH_RATIO = 0.64;

export const PianoKeyboard = memo(function PianoKeyboard({
  activePitches,
  targetPitches,
  completedPitches,
  lowMidi = PIANO_LOW_MIDI,
  highMidi = PIANO_HIGH_MIDI,
  keyboardBaseMidi,
  onPress,
  onRelease
}: PianoKeyboardProps) {
  const keys = useMemo(
    () => buildPianoKeys().filter((key) => key.midi >= lowMidi && key.midi <= highMidi),
    [highMidi, lowMidi]
  );
  const whiteKeys = keys.filter((key) => !key.black);
  const minWhiteIndex = whiteKeys[0]?.whiteIndex ?? 0;
  const whiteKeyWidth = 100 / Math.max(1, whiteKeys.length);
  const blackKeyWidth = whiteKeyWidth * BLACK_KEY_WIDTH_RATIO;
  const showTypingLabels = whiteKeys.length <= 34;

  return (
    <div className="keyboardShell">
      <div className="keyboard">
        {whiteKeys.map((key) => {
          const typingLabel = showTypingLabels ? keyLabelForMidi(key.midi, keyboardBaseMidi) : undefined;
          const label = key.midi % 12 === 0 ? midiToNoteName(key.midi) : typingLabel;
          return (
            <button
              className={keyClassName(key.midi, activePitches, targetPitches, completedPitches)}
              key={key.midi}
              style={{
                left: `${(key.whiteIndex - minWhiteIndex) * whiteKeyWidth}%`,
                width: `${whiteKeyWidth}%`
              }}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                onPress(key.midi, event.pressure > 0 ? event.pressure : 0.78);
              }}
              onPointerUp={(event) => {
                event.currentTarget.releasePointerCapture(event.pointerId);
                onRelease(key.midi);
              }}
              onPointerCancel={() => onRelease(key.midi)}
              onPointerLeave={(event) => {
                if (event.buttons) onRelease(key.midi);
              }}
              aria-label={midiToNoteName(key.midi)}
            >
              <span>{label}</span>
            </button>
          );
        })}

        {keys.filter((key) => isBlackKey(key.midi)).map((key) => {
          const left = (key.whiteIndex - minWhiteIndex + 1) * whiteKeyWidth - blackKeyWidth / 2;
          const label = showTypingLabels ? keyLabelForMidi(key.midi, keyboardBaseMidi) : undefined;
          return (
            <button
              className={keyClassName(key.midi, activePitches, targetPitches, completedPitches)}
              key={key.midi}
              style={{
                left: `${left}%`,
                width: `${blackKeyWidth}%`
              }}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                onPress(key.midi, event.pressure > 0 ? event.pressure : 0.76);
              }}
              onPointerUp={(event) => {
                event.currentTarget.releasePointerCapture(event.pointerId);
                onRelease(key.midi);
              }}
              onPointerCancel={() => onRelease(key.midi)}
              onPointerLeave={(event) => {
                if (event.buttons) onRelease(key.midi);
              }}
              aria-label={midiToNoteName(key.midi)}
            >
              <span>{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
});

function keyClassName(
  midi: number,
  activePitches: Set<number>,
  targetPitches: Set<number>,
  completedPitches?: Set<number>
): string {
  const classes = ["pianoKey", isBlackKey(midi) ? "black" : "white"];
  if (activePitches.has(midi)) classes.push("active");
  if (targetPitches.has(midi)) classes.push("target");
  if (completedPitches?.has(midi)) classes.push("completed");
  return classes.join(" ");
}
