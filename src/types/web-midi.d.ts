type MIDIConnectionEvent = Event & {
  port?: MIDIPort;
};

type MIDIMessageEvent = Event & {
  data: Uint8Array;
};

interface MIDIPort {
  id: string;
  manufacturer?: string;
  name?: string;
  state: "connected" | "disconnected";
  type: "input" | "output";
}

interface MIDIInput extends MIDIPort {
  onmidimessage: ((event: MIDIMessageEvent) => void) | null;
}

interface MIDIInputMap extends Map<string, MIDIInput> {}

interface MIDIAccess {
  inputs: MIDIInputMap;
  onstatechange: ((event: MIDIConnectionEvent) => void) | null;
}

interface Navigator {
  requestMIDIAccess?: (options?: { sysex?: boolean }) => Promise<MIDIAccess>;
}
