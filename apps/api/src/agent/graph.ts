import { END, START, StateGraph } from '@langchain/langgraph';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { SafeError, StreamEvent } from '@bid/shared';
import type { ExecutionContext } from '../domain/interfaces.js';
import { HttpError } from '../errors.js';
import { dispatchTool } from '../tools/dispatch.js';
import type { TracingRuntime } from '../observability/tracing.js';
import { AgentState } from './state.js';
import type { SavedToolExecution, State, ToolCall } from './state.js';

export interface ModelStep {
  message: ChatCompletionMessageParam;
  calls: ToolCall[];
  text: string;
}

export interface GraphDependencies {
  context: ExecutionContext;
  tracing: TracingRuntime;
  guard: () => Promise<void>;
  reserve: (kind: 'model' | 'tool') => Promise<void>;
  model: (state: State) => Promise<ModelStep>;
  finalize: (state: State) => Promise<void>;
  saveTool: (state: State) => Promise<void>;
  loadTool: (call: ToolCall) => Promise<SavedToolExecution | null>;
  emit: (event: StreamEvent) => void;
  conversationId: string;
  turnId: string;
}

export function buildAgentGraph(saver: PostgresSaver, deps: GraphDependencies) {
  const fields = { conversationId: deps.conversationId, turnId: deps.turnId, correlationId: deps.context.correlationId };

  return new StateGraph(AgentState)
    .addNode('model', async (state) => {
      await deps.guard();
      if (state.rounds >= 6) throw new HttpError(429, 'BUDGET_EXCEEDED', 'The model round budget was reached.');

      await deps.reserve('model');
      const next = await deps.model(state);

      const messages = [...state.messages, next.message];
      if (Buffer.byteLength(JSON.stringify({ ...state, messages })) > 262_144) {
        throw new HttpError(429, 'BUDGET_EXCEEDED', 'The saved turn byte budget was reached.');
      }

      return { messages, pending: next.calls, answer: next.calls.length ? '' : next.text, rounds: state.rounds + 1 };
    })
    .addNode('tool', async (state) => {
      await deps.guard();
      if (state.toolCount >= 12) throw new HttpError(429, 'BUDGET_EXCEEDED', 'The tool budget was reached.');

      const call = state.pending[0];
      if (!call) throw new HttpError(502, 'MODEL_INCOMPATIBLE', 'The model returned an invalid tool continuation.');

      deps.emit({ ...fields, type: 'tool-start', toolCallId: call.id, toolName: call.name, argumentsJson: call.argumentsJson });
      const saved = await deps.loadTool(call);
      let result = saved?.result ?? null;
      let error: SafeError | null = saved?.error ?? null;

      try {
        if (!saved) {
          await deps.reserve('tool');
          result = await deps.tracing.tool({ name: call.name, argumentsJson: call.argumentsJson },
            () => dispatchTool(call.name, call.argumentsJson, deps.context), 'investigation-tool');
        }
        if (result) deps.emit({ ...fields, type: 'tool-result', toolCallId: call.id, result });
        else if (error) deps.emit({ ...fields, type: 'tool-error', toolCallId: call.id, error });
      } catch (cause) {
        deps.context.signal.throwIfAborted();
        error = cause instanceof HttpError ? { code: cause.code, message: cause.message }
          : { code: 'TOOL_FAILED', message: 'The tool could not be completed.' };
        deps.emit({ ...fields, type: 'tool-error', toolCallId: call.id, error });
      }

      const evidence = [...new Map([...state.evidence, ...(result?.evidence ?? [])].map((entry) => [entry.evidenceId, entry])).values()];
      const execution = { ...call, result, error };
      const content = JSON.stringify(result ?? { error });

      const next: State = { ...state, pending: state.pending.slice(1), toolCount: state.toolCount + 1,
        evidence, executions: [...state.executions, execution],
        messages: [...state.messages, { role: 'tool', tool_call_id: call.id, content }] };
      if (Buffer.byteLength(JSON.stringify(next)) > 262_144) {
        throw new HttpError(429, 'BUDGET_EXCEEDED', 'The saved turn byte budget was reached.');
      }
      await deps.saveTool(next);

      return next;
    })
    .addNode('finalize', async (state) => {
      await deps.guard();
      await deps.finalize(state);

      return { done: true };
    })
    .addEdge(START, 'model')
    .addConditionalEdges('model', (state) => state.pending.length ? 'tool' : 'finalize')
    .addConditionalEdges('tool', (state) => state.pending.length ? 'tool' : 'model')
    .addEdge('finalize', END)
    .compile({ checkpointer: saver });
}
