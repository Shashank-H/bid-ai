import type { ToolResult } from '@bid/shared';
import type { ExecutionContext } from '../domain/interfaces.js';
import { HttpError } from '../errors.js';
import { readOnlyTools } from './registry.js';
import type { ReadOnlyToolDefinition } from './types.js';

export type ToolDispatcher = (
  name: string,
  argumentsJson: string,
  context: ExecutionContext,
) => Promise<ToolResult>;

type ToolRegistry = readonly ReadOnlyToolDefinition<unknown, ToolResult>[];

export function createToolDispatcher(tools: ToolRegistry): ToolDispatcher {
  return (name, argumentsJson, context) => dispatchTool(name, argumentsJson, context, tools);
}

export async function dispatchTool(
  name: string,
  argumentsJson: string,
  context: ExecutionContext,
  tools: ToolRegistry = readOnlyTools,
): Promise<ToolResult> {
  context.signal.throwIfAborted();

  const tool = tools.find((entry) => entry.name === name);

  if (!tool || Buffer.byteLength(argumentsJson) > 16_384)
    throw new HttpError(400, 'INVALID_INPUT', 'Unknown tool or oversized arguments.');

  let input: unknown;

  try {
    input = JSON.parse(argumentsJson);
  } catch {
    throw new HttpError(400, 'INVALID_INPUT', 'Tool arguments must be valid JSON.');
  }

  if (!tool.inputSchema.safeParse(input).success)
    throw new HttpError(400, 'INVALID_INPUT', 'Tool arguments do not match the allowed schema.');

  const result = await tool.execute(input, context);
  const parsed = tool.outputSchema.safeParse(result.data);

  if (
    !parsed.success ||
    !parsed.data.data ||
    parsed.data.evidence.some((entry) => entry.publisherId !== context.identity.publisherId) ||
    Buffer.byteLength(JSON.stringify(parsed.data)) > tool.maxOutputBytes
  ) {
    throw new HttpError(502, 'TOOL_FAILED', 'Tool output failed validation.');
  }

  context.signal.throwIfAborted();

  return parsed.data;
}
