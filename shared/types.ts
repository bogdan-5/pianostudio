export type PracticeMode = "wait" | "continuous";

export type LoopRange = {
  startSec: number;
  endSec: number;
  noteIds?: string[];
};

export type SongSource = "bitmidi" | "mutopia" | "direct";

export type SongSearchResult = {
  id: string;
  source: SongSource;
  title: string;
  artist?: string;
  durationSec?: number;
  difficulty?: string;
  licenseLabel?: string;
  detailUrl?: string;
  midiUrl?: string;
};

export type SearchResponse = {
  results: SongSearchResult[];
  source: SongSource | "all";
  query: string;
  page: number;
  errors?: string[];
};

export type NormalizedTrack = {
  id: string;
  name: string;
  instrument?: string;
  channel?: number;
  noteCount: number;
  pitchMin: number;
  pitchMax: number;
};

export type NormalizedNote = {
  id: string;
  midi: number;
  startSec: number;
  durationSec: number;
  velocity: number;
  trackId: string;
  hand?: "left" | "right";
};

export type NormalizedSong = {
  id: string;
  title: string;
  artist?: string;
  source?: SongSource | "upload";
  durationSec: number;
  bpm?: number;
  timeSignature?: [number, number];
  pitchMin: number;
  pitchMax: number;
  tracks: NormalizedTrack[];
  notes: NormalizedNote[];
};

export type PracticeStats = {
  correct: number;
  wrong: number;
  missed: number;
  streak: number;
};
