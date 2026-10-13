import type { z } from 'zod';
import type { EvidenceReference } from '@bid/shared';
import type { ExecutionContext } from '../domain/interfaces.js';

export interface ToolExecutionResult<T> {
  readonly data: T;
  readonly evidence: readonly EvidenceReference[];
}

// Concrete registry, schemas and dispatcher are Phase 1. Dispatch validates schemas,
// supplies authorized context, enforces maxOutputBytes, and forwards cancellation.
export interface ReadOnlyToolDefinition<Input, Output> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<Input>;
  readonly outputSchema: z.ZodType<Output>;
  readonly maxOutputBytes: number;
  readonly readOnly: true;
  execute(input: Input, context: ExecutionContext): Promise<ToolExecutionResult<Output>>;
}
