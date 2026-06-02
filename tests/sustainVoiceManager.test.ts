import { describe, expect, it } from "vitest";
import { SustainVoiceManager } from "../src/lib/sustainVoiceManager";

describe("sustain voice manager", () => {
  it("bounds sustained voices and steals old released voices first", () => {
    const manager = new SustainVoiceManager(4, 10000);
    let now = 0;

    manager.pedalDown(now);

    for (const midi of [60, 62, 64, 65]) {
      expect(manager.noteOn(midi, now += 10).some((action) => action.type === "attack")).toBe(true);
      expect(manager.noteOff(midi, now += 10)).toEqual([]);
    }

    expect(manager.diagnostics()).toMatchObject({
      activeVoices: 4,
      keyHeldVoices: 0,
      sustainedVoices: 4,
      sustainDown: true
    });

    const actions = manager.noteOn(67, now += 10);
    expect(actions).toEqual([
      { type: "release", midi: 60, reason: "stolen" },
      { type: "attack", midi: 67 }
    ]);
    expect(manager.diagnostics()).toMatchObject({
      activeVoices: 4,
      sustainedVoices: 3,
      keyHeldVoices: 1
    });
  });

  it("releases sustained notes when the pedal comes up but keeps physically held notes", () => {
    const manager = new SustainVoiceManager(8, 10000);

    manager.pedalDown(0);
    manager.noteOn(60, 10);
    manager.noteOn(64, 20);
    manager.noteOff(60, 30);

    expect(manager.pedalUp(40)).toEqual([{ type: "release", midi: 60, reason: "pedal-up" }]);
    expect(manager.diagnostics()).toMatchObject({
      activeVoices: 1,
      keyHeldVoices: 1,
      sustainedVoices: 0,
      sustainDown: false
    });
  });

  it("expires excessive sustained voices and retriggers the same pitch without growing", () => {
    const manager = new SustainVoiceManager(4, 100);

    manager.pedalDown(0);
    manager.noteOn(60, 10);
    manager.noteOff(60, 20);
    expect(manager.diagnostics().activeVoices).toBe(1);

    expect(manager.noteOn(62, 140)).toEqual([
      { type: "release", midi: 60, reason: "expired" },
      { type: "attack", midi: 62 }
    ]);

    expect(manager.noteOn(62, 150)).toEqual([
      { type: "release", midi: 62, reason: "retrigger" },
      { type: "attack", midi: 62 }
    ]);
    expect(manager.diagnostics()).toMatchObject({
      activeVoices: 1,
      keyHeldVoices: 1
    });
  });
});
