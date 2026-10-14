export const deferredCommands = {
  'data:seed': 2,
  'data:reconcile': 2,
  'data:generate': 3,
} as const;

export class NotImplementedError extends Error {
  constructor(command: keyof typeof deferredCommands) {
    super(`NOT_IMPLEMENTED: ${command} belongs to Phase ${deferredCommands[command]}; no data was written`);

    this.name = 'NotImplementedError';
  }
}

/** Explicit command wiring, not a hidden seed operation or fake-success implementation. */
export function executeDeferredCommand(command: keyof typeof deferredCommands): never {
  throw new NotImplementedError(command);
}
