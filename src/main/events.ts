type Emitter = (channel: string, ...args: unknown[]) => void;

let emitter: Emitter = () => undefined;

export function setRendererEmitter(fn: Emitter): void {
  emitter = fn;
}

export function emit(channel: string, ...args: unknown[]): void {
  try {
    emitter(channel, ...args);
  } catch (err) {
    console.error('[events] emit failed', channel, err);
  }
}
