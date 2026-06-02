import * as Tone from "tone";
import { midiToNoteName } from "../../shared/music";
import { SustainVoiceManager, type VoiceAction, type VoiceDiagnostics } from "./sustainVoiceManager";

type PianoInstance = {
  toDestination?: () => unknown;
  load?: () => Promise<unknown>;
  keyDown?: (options: { note: string; velocity?: number; time?: number | string }) => void;
  keyUp?: (options: { note: string; time?: number | string }) => void;
  pedalDown?: (options?: { time?: number | string }) => void;
  pedalUp?: (options?: { time?: number | string }) => void;
};

type PlayNoteOptions = {
  retrigger?: boolean;
};

const MAX_AUDIO_VOICES = 32;
const MAX_SUSTAIN_MS = 14000;

class AudioEngine {
  private readyPromise?: Promise<void>;
  private piano?: PianoInstance;
  private fallback?: Tone.PolySynth;
  private voices = new SustainVoiceManager(MAX_AUDIO_VOICES, MAX_SUSTAIN_MS);
  private volume = 0.82;
  status: "idle" | "loading" | "ready" | "fallback" | "error" = "idle";

  async ensureReady(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;

    this.status = "loading";
    this.readyPromise = this.initialize();
    return this.readyPromise;
  }

  async playNote(midi: number, velocity = 0.75, options: PlayNoteOptions = {}): Promise<void> {
    await this.ensureReady();
    const normalizedVelocity = Math.min(1, Math.max(0.08, velocity));
    const actions = this.voices.noteOn(midi, this.nowMs());
    this.applyActions(actions, normalizedVelocity, options);
  }

  stopNote(midi: number): void {
    this.applyActions(this.voices.noteOff(midi, this.nowMs()));
  }

  allNotesOff(): void {
    this.applyActions(this.voices.allOff());
    this.fallback?.releaseAll();
  }

  pedalDown(): void {
    this.applyActions(this.voices.pedalDown(this.nowMs()));
  }

  pedalUp(): void {
    this.applyActions(this.voices.pedalUp(this.nowMs()));
  }

  getDiagnostics(): VoiceDiagnostics {
    return this.voices.diagnostics();
  }

  setVolume(value: number): void {
    this.volume = Math.min(1, Math.max(0, value));
    if (Tone.Destination?.volume) {
      Tone.Destination.volume.value = this.volume <= 0 ? -48 : Tone.gainToDb(this.volume);
    }
  }

  private applyActions(actions: VoiceAction[], velocity = 0.75, options: PlayNoteOptions = {}): void {
    const released = new Set<number>();

    actions.forEach((action) => {
      if (action.type !== "release") return;
      released.add(action.midi);
      this.releaseNote(midiToNoteName(action.midi));
    });

    actions.forEach((action) => {
      if (action.type !== "attack") return;
      const retriggering = released.has(action.midi) || options.retrigger;
      this.attackNote(midiToNoteName(action.midi), velocity, retriggering && !this.piano ? Tone.now() + 0.003 : undefined);
    });
  }

  private attackNote(note: string, velocity: number, time?: number): void {
    if (this.piano?.keyDown) {
      this.piano.keyDown(time === undefined ? { note, velocity } : { note, velocity, time });
      return;
    }

    this.fallback?.triggerAttack(note, time ?? Tone.now(), velocity);
  }

  private releaseNote(note: string, time?: number): void {
    if (this.piano?.keyUp) {
      this.piano.keyUp(time === undefined ? { note } : { note, time });
      return;
    }

    this.fallback?.triggerRelease(note, time ?? Tone.now());
  }

  private nowMs(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  private async initialize(): Promise<void> {
    await Tone.start();
    this.setVolume(this.volume);

    try {
      const module = (await import("@tonejs/piano/build/piano/Piano.js")) as unknown as {
        Piano: new (options?: unknown) => PianoInstance;
      };
      const piano = new module.Piano({ velocities: 4, maxPolyphony: MAX_AUDIO_VOICES });
      piano.toDestination?.();
      await piano.load?.();
      this.piano = piano;
      this.status = "ready";
    } catch (error) {
      console.warn("Falling back to synthesized piano", error);
      const synth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: "triangle8" },
        envelope: {
          attack: 0.006,
          decay: 0.28,
          sustain: 0.28,
          release: 1.8
        }
      });
      const reverb = new Tone.Reverb({ decay: 2.8, wet: 0.18 }).toDestination();
      synth.connect(reverb);
      this.fallback = synth;
      this.status = "fallback";
    }
  }
}

export const audioEngine = new AudioEngine();
