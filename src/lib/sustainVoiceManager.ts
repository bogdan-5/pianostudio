export type VoiceReleaseReason = "note-off" | "pedal-up" | "stolen" | "expired" | "all-off" | "retrigger";

export type VoiceAction =
  | { type: "attack"; midi: number }
  | { type: "release"; midi: number; reason: VoiceReleaseReason };

export type VoiceDiagnostics = {
  activeVoices: number;
  keyHeldVoices: number;
  sustainedVoices: number;
  sustainDown: boolean;
  maxVoices: number;
};

type ManagedVoice = {
  midi: number;
  keyHeld: boolean;
  sustained: boolean;
  startedAtMs: number;
  lastChangedAtMs: number;
  releasedAtMs?: number;
};

export class SustainVoiceManager {
  private voices = new Map<number, ManagedVoice>();
  private sustainDown = false;

  constructor(
    private readonly maxVoices = 32,
    private readonly maxSustainMs = 14000
  ) {}

  noteOn(midi: number, nowMs: number): VoiceAction[] {
    const actions: VoiceAction[] = [];

    if (this.voices.has(midi)) {
      this.releaseVoice(midi, "retrigger", actions);
    }

    this.cleanupExpired(nowMs, actions);
    this.ensureCapacity(nowMs, actions);

    this.voices.set(midi, {
      midi,
      keyHeld: true,
      sustained: false,
      startedAtMs: nowMs,
      lastChangedAtMs: nowMs
    });
    actions.push({ type: "attack", midi });
    return actions;
  }

  noteOff(midi: number, nowMs: number): VoiceAction[] {
    const voice = this.voices.get(midi);
    if (!voice) return [];

    voice.keyHeld = false;
    voice.lastChangedAtMs = nowMs;

    if (this.sustainDown) {
      voice.sustained = true;
      voice.releasedAtMs = nowMs;
      return this.cleanupExpired(nowMs, []);
    }

    const actions: VoiceAction[] = [];
    this.releaseVoice(midi, "note-off", actions);
    return actions;
  }

  pedalDown(nowMs: number): VoiceAction[] {
    this.sustainDown = true;
    return this.cleanupExpired(nowMs, []);
  }

  pedalUp(nowMs: number): VoiceAction[] {
    this.sustainDown = false;
    const actions: VoiceAction[] = [];

    [...this.voices.values()]
      .filter((voice) => !voice.keyHeld)
      .forEach((voice) => this.releaseVoice(voice.midi, "pedal-up", actions));

    return actions;
  }

  allOff(): VoiceAction[] {
    this.sustainDown = false;
    const actions: VoiceAction[] = [];
    [...this.voices.keys()].forEach((midi) => this.releaseVoice(midi, "all-off", actions));
    return actions;
  }

  diagnostics(): VoiceDiagnostics {
    const voices = [...this.voices.values()];
    return {
      activeVoices: voices.length,
      keyHeldVoices: voices.filter((voice) => voice.keyHeld).length,
      sustainedVoices: voices.filter((voice) => voice.sustained && !voice.keyHeld).length,
      sustainDown: this.sustainDown,
      maxVoices: this.maxVoices
    };
  }

  private cleanupExpired(nowMs: number, actions: VoiceAction[]): VoiceAction[] {
    [...this.voices.values()]
      .filter((voice) => voice.sustained && !voice.keyHeld && nowMs - (voice.releasedAtMs ?? voice.startedAtMs) > this.maxSustainMs)
      .forEach((voice) => this.releaseVoice(voice.midi, "expired", actions));
    return actions;
  }

  private ensureCapacity(nowMs: number, actions: VoiceAction[]): void {
    this.cleanupExpired(nowMs, actions);

    while (this.voices.size >= this.maxVoices) {
      const voiceToSteal = this.pickVoiceToSteal();
      if (!voiceToSteal) break;
      this.releaseVoice(voiceToSteal.midi, "stolen", actions);
    }
  }

  private pickVoiceToSteal(): ManagedVoice | undefined {
    const voices = [...this.voices.values()];
    const sustained = voices
      .filter((voice) => voice.sustained && !voice.keyHeld)
      .sort((a, b) => (a.releasedAtMs ?? a.lastChangedAtMs) - (b.releasedAtMs ?? b.lastChangedAtMs));

    if (sustained[0]) return sustained[0];

    return voices.sort((a, b) => a.startedAtMs - b.startedAtMs)[0];
  }

  private releaseVoice(midi: number, reason: VoiceReleaseReason, actions: VoiceAction[]): void {
    if (!this.voices.has(midi)) return;
    this.voices.delete(midi);
    actions.push({ type: "release", midi, reason });
  }
}
