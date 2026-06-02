declare module "@tonejs/piano/build/piano/Piano.js" {
  export class Piano {
    constructor(options?: unknown);
    toDestination(): this;
    load(): Promise<unknown>;
    keyDown(options: { note?: string; midi?: number; velocity?: number; time?: number | string }): this;
    keyUp(options: { note?: string; midi?: number; velocity?: number; time?: number | string }): this;
    pedalDown(options?: { time?: number | string }): this;
    pedalUp(options?: { time?: number | string }): this;
    stopAll(): this;
  }
}
