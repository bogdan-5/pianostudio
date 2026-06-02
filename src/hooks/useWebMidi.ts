import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type MidiInputEvent = {
  type: "noteon" | "noteoff" | "pedal";
  midi?: number;
  velocity?: number;
  pedalDown?: boolean;
};

export type MidiDeviceInfo = {
  id: string;
  name: string;
  state: string;
};

export function useWebMidi(onEvent: (event: MidiInputEvent) => void) {
  const [supported] = useState(() => typeof navigator !== "undefined" && Boolean(navigator.requestMIDIAccess));
  const [permissionState, setPermissionState] = useState<"idle" | "connecting" | "ready" | "denied" | "unsupported">(
    supported ? "idle" : "unsupported"
  );
  const [devices, setDevices] = useState<MidiDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const accessRef = useRef<MIDIAccess | null>(null);
  const eventRef = useRef(onEvent);

  useEffect(() => {
    eventRef.current = onEvent;
  }, [onEvent]);

  const refreshDevices = useCallback(() => {
    const access = accessRef.current;
    if (!access) return;
    const next = [...access.inputs.values()].map((input) => ({
      id: input.id,
      name: input.name || input.manufacturer || "MIDI input",
      state: input.state
    }));
    setDevices(next);
    setSelectedDeviceId((current) => current || next[0]?.id || "");
  }, []);

  const connect = useCallback(async () => {
    if (!navigator.requestMIDIAccess) {
      setPermissionState("unsupported");
      return;
    }

    setPermissionState("connecting");
    try {
      const access = await navigator.requestMIDIAccess({ sysex: false });
      accessRef.current = access;
      access.onstatechange = refreshDevices;
      refreshDevices();
      setPermissionState("ready");
    } catch {
      setPermissionState("denied");
    }
  }, [refreshDevices]);

  useEffect(() => {
    const access = accessRef.current;
    if (!access) return;

    access.inputs.forEach((input) => {
      input.onmidimessage = null;
    });

    const target = selectedDeviceId ? access.inputs.get(selectedDeviceId) : [...access.inputs.values()][0];
    if (!target) return;

    target.onmidimessage = (message) => {
      if (!message.data) return;
      const [status, note, rawVelocity] = message.data;
      const command = status & 0xf0;
      const velocity = (rawVelocity ?? 0) / 127;

      if (command === 0x90 && rawVelocity > 0) {
        eventRef.current({ type: "noteon", midi: note, velocity });
      } else if (command === 0x80 || (command === 0x90 && rawVelocity === 0)) {
        eventRef.current({ type: "noteoff", midi: note, velocity: 0 });
      } else if (command === 0xb0 && note === 64) {
        eventRef.current({ type: "pedal", pedalDown: rawVelocity >= 64 });
      }
    };

    return () => {
      target.onmidimessage = null;
    };
  }, [selectedDeviceId, devices]);

  return useMemo(
    () => ({
      supported,
      permissionState,
      devices,
      selectedDeviceId,
      setSelectedDeviceId,
      connect
    }),
    [connect, devices, permissionState, selectedDeviceId, supported]
  );
}
