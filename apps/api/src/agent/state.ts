import { Annotation } from '@langchain/langgraph';
import { z } from 'zod';
import type { SpecialistRole } from './policy.js';
import type { DecisionIntent, DecisionResult, DecisionStage } from './decision-model.js';

export const HandoffSchema = z.object({
  summary: z.string().max(8192),
  evidenceIds: z.array(z.string().max(128)).max(100),
  limitations: z.array(z.string().max(1024)).max(10),
});

export type SpecialistHandoff = z.infer<typeof HandoffSchema>;
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
  specialist: Annotation<SpecialistRole>(),
  routingStage: Annotation<DecisionStage>(),
  intent: Annotation<DecisionIntent>(),
  decisions: Annotation<DecisionResult[]>(),
  decisionCount: Annotation<number>(),
  handoffs: Annotation<Partial<Record<SpecialistRole, SpecialistHandoff>>>(),
  handoffPending: Annotation<boolean>(),
  responseMode: Annotation<'investigate' | 'out_of_scope' | 'clarify'>(),
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
    specialist: 'read',
    routingStage: 'entry',
    intent: 'uncertain',
    decisions: [],
    decisionCount: 0,
    handoffs: {},
    handoffPending: false,
    responseMode: 'investigate',
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
