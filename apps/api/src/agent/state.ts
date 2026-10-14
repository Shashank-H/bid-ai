import { Annotation } from '@langchain/langgraph';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { EvidenceReference, SafeError, ToolResult } from '@bid/shared';

export interface ToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface SavedToolExecution extends ToolCall {
  result: ToolResult | null;
  error: SafeError | null;
}

export const AgentState = Annotation.Root({
  turnId: Annotation<string>(),
  messages: Annotation<ChatCompletionMessageParam[]>(),
  pending: Annotation<ToolCall[]>(),
  executions: Annotation<SavedToolExecution[]>(),
  evidence: Annotation<EvidenceReference[]>(),
  rounds: Annotation<number>(),
  toolCount: Annotation<number>(),
  answer: Annotation<string>(),
  done: Annotation<boolean>(),
});

export type State = typeof AgentState.State;

export function initialState(turnId: string, messages: ChatCompletionMessageParam[]): State {
  return {
    turnId,
    messages,
    pending: [],
    executions: [],
    evidence: [],
    rounds: 0,
    toolCount: 0,
    answer: '',
    done: false,
  };
}
