import { END, START, StateGraph } from '@langchain/langgraph';
import type { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { SafeError, StreamEvent } from '@bid/shared';
import type { ExecutionContext } from '../domain/interfaces.js';
import { HttpError } from '../errors.js';
import type { ToolDispatcher } from '../tools/dispatch.js';
import type { TracingRuntime } from '../observability/tracing.js';
import { AgentState, HandoffSchema } from './state.js';
import type { DecisionRunner } from './decision-model.js';
import { AGENT_LIMITS, allowedToolNames } from './policy.js';
import { FIXED_RESPONSES } from './evidence.js';
import type { SavedToolExecution, SpecialistHandoff, State, ToolCall } from './state.js';

export interface ModelStep {
  message: ChatCompletionMessageParam;
  calls: ToolCall[];
  text: string;
  handoff?: SpecialistHandoff;
}

export interface GraphDependencies {
  context: ExecutionContext;
  dispatchTool: ToolDispatcher;
  tracing: TracingRuntime;
  guard: () => Promise<void>;
  reserve: (kind: 'model' | 'specialist' | 'decision' | 'tool') => Promise<void>;
  model: (state: State) => Promise<ModelStep>;
  decision: DecisionRunner;
  finalize: (state: State) => Promise<void>;
  saveTool: (state: State) => Promise<void>;
  loadTool: (call: ToolCall) => Promise<SavedToolExecution | null>;
  emit: (event: StreamEvent) => void;
  conversationId: string;
  turnId: string;
  allowConfigurationNavigation?: boolean;
}

export function buildAgentGraph(saver: PostgresSaver, deps: GraphDependencies) {
  const fields = {
    conversationId: deps.conversationId,
    turnId: deps.turnId,
    correlationId: deps.context.correlationId,
  };

  const checked = (state: State): State => {
    if (Buffer.byteLength(JSON.stringify(state)) > 262_144) {
      throw new HttpError(429, 'BUDGET_EXCEEDED', 'The saved turn byte budget was reached.');
    }

    return state;
  };
  const gate = async (state: State): Promise<State> => {
    await deps.guard();
    const stage = state.routingStage;
    if (state.decisionCount >= AGENT_LIMITS.decisions) {
      throw new HttpError(429, 'BUDGET_EXCEEDED', 'The decision-call budget was reached.');
    }
    const allowConfiguration =
      (stage === 'entry' || state.intent === 'mixed' || state.intent === 'configuration') &&
      state.rounds < AGENT_LIMITS.specialists - 1;
    const dialogue = state.messages
      .filter(
        (message) =>
          (message.role === 'user' || message.role === 'assistant') &&
          typeof message.content === 'string',
      )
      .slice(-6)
      .map((message) => ({ role: message.role, text: (message.content as string).slice(0, 2048) }));
    const latestRequest = state.messages.findLast((message) => message.role === 'user');

    const permitted =
      stage === 'entry'
        ? ['read', 'configuration', 'out_of_scope', 'clarify']
        : stage === 'after_read' && allowConfiguration
          ? ['configuration', 'response', 'clarify']
          : ['response', 'clarify'];

    await deps.reserve('decision');
    const decision = await deps.decision(
      {
        stage,
        allowConfiguration,
        state: {
          request:
            typeof latestRequest?.content === 'string' ? latestRequest.content.slice(0, 8192) : '',
          dialogue,
          stage,
          permittedRoutes: permitted,
          intent: state.intent,
          handoffs: state.handoffs,
          evidence: state.evidence
            .slice(-30)
            .map(({ evidenceId, source }) => ({ evidenceId, source })),
          tools: state.executions.slice(-12).map((execution) => ({
            name: execution.name,
            succeeded: !!execution.result,
            error: execution.error?.code,
          })),
        },
      },
      deps.context.signal,
    );
    if (decision.stage !== stage || !permitted.includes(decision.route)) {
      throw new HttpError(
        503,
        'DEPENDENCY_UNAVAILABLE',
        'The decision model returned an invalid transition.',
      );
    }
    const fixed =
      decision.route === 'out_of_scope' || decision.route === 'clarify' ? decision.route : null;

    return checked({
      ...state,
      decisions: [...state.decisions, decision],
      decisionCount: state.decisionCount + 1,
      intent: stage === 'entry' ? decision.intent : state.intent,
      routingStage: stage,
      specialist: fixed ? state.specialist : (decision.route as State['specialist']),
      responseMode: fixed ?? 'investigate',
      answer: fixed ? FIXED_RESPONSES[fixed] : '',
      pending: fixed ? [] : state.pending,
      handoffPending: false,
    });
  };
  const budgetHandoff = (state: State): State =>
    checked({
      ...state,
      // Failed/replayed private attempts can exhaust the durable budget before rounds catches up.
      rounds: Math.max(state.rounds, AGENT_LIMITS.specialists - 1),
      pending: [],
      handoffPending: false,
      handoffs: {
        ...state.handoffs,
        [state.specialist]: {
          summary: 'Investigation call allowance exhausted.',
          evidenceIds: [],
          limitations: ['Use only retrieved observations; further queries were not run.'],
        },
      },
      routingStage: state.specialist === 'read' ? 'after_read' : 'after_configuration',
    });
  const specialist = async (state: State): Promise<State> => {
    await deps.guard();
    if (state.responseMode !== 'investigate') return state;
    const role = state.specialist;
    if (role !== 'response' && state.rounds >= AGENT_LIMITS.specialists - 1)
      return budgetHandoff(state);
    if (state.rounds >= AGENT_LIMITS.specialists)
      throw new HttpError(429, 'BUDGET_EXCEEDED', 'The model round budget was reached.');

    try {
      await deps.reserve(role === 'response' ? 'model' : 'specialist');
    } catch (error) {
      if (role !== 'response' && error instanceof HttpError && error.code === 'BUDGET_EXCEEDED')
        return budgetHandoff(state);
      throw error;
    }
    const next = await deps.model(state);
    if (role === 'response' && next.calls.length) {
      throw new HttpError(502, 'MODEL_INCOMPATIBLE', 'The response specialist cannot call tools.');
    }
    let handoff: SpecialistHandoff | undefined;
    if (role !== 'response' && (next.handoff || !next.calls.length)) {
      handoff = HandoffSchema.parse(next.handoff);
      const known = new Set(state.evidence.map((entry) => entry.evidenceId));
      if (handoff.evidenceIds.some((id) => !known.has(id))) {
        throw new HttpError(502, 'EVIDENCE_INVALID', 'The specialist referenced unknown evidence.');
      }
    }

    return checked({
      ...state,
      messages: [...state.messages, next.message],
      pending: next.calls,
      answer: role === 'response' ? next.text : '',
      rounds: state.rounds + 1,
      handoffs: handoff ? { ...state.handoffs, [role]: handoff } : state.handoffs,
      handoffPending: !!handoff && next.calls.length > 0,
      routingStage: role === 'read' ? 'after_read' : 'after_configuration',
    });
  };
  const afterSpecialist = (state: State) =>
    state.responseMode !== 'investigate' || state.specialist === 'response'
      ? 'finalize'
      : state.pending.length
        ? 'tool'
        : 'decision';
  const selectedSpecialist = (state: State) =>
    state.responseMode !== 'investigate' ? 'finalize' : state.specialist;

  return new StateGraph(AgentState)
    .addNode('decision', gate)
    .addNode('read', specialist)
    .addNode('configuration', specialist)
    .addNode('response', specialist)
    .addNode('tool', async (state) => {
      await deps.guard();
      if (state.responseMode !== 'investigate') return state;
      if (state.toolCount >= AGENT_LIMITS.tools)
        throw new HttpError(429, 'BUDGET_EXCEEDED', 'The tool budget was reached.');

      const call = state.pending[0];
      if (!call)
        throw new HttpError(
          502,
          'MODEL_INCOMPATIBLE',
          'The model returned an invalid tool continuation.',
        );

      if (!allowedToolNames(state.specialist).includes(call.name)) {
        throw new HttpError(
          409,
          'CONFLICT',
          'The pending tool is not permitted for this specialist. Start a new request.',
        );
      }

      deps.emit({
        ...fields,
        type: 'tool-start',
        toolCallId: call.id,
        toolName: call.name,
        argumentsJson: call.argumentsJson,
      });
      const saved = await deps.loadTool(call);
      let result = saved?.result ?? null;
      let error: SafeError | null = saved?.error ?? null;

      try {
        if (!saved) {
          await deps.reserve('tool');
          result = await deps.tracing.tool(
            { name: call.name, argumentsJson: call.argumentsJson },
            () =>
              deps.dispatchTool(call.name, call.argumentsJson, {
                ...deps.context,
                invocation: {
                  conversationId: deps.conversationId,
                  turnId: deps.turnId,
                  toolCallId: call.id,
                  evidence: state.evidence,
                  allowNavigation: deps.allowConfigurationNavigation === true,
                },
              }),
            'investigation-tool',
          );
        }
        if (result && !saved) {
          const used = new Set(state.evidence.map((entry) => entry.evidenceId));
          const mapping = new Map<string, string>();
          let nextId = 1;

          for (const entry of result.evidence) {
            while (used.has(`e${nextId}`)) nextId++;
            const id = `e${nextId++}`;
            used.add(id);
            mapping.set(entry.evidenceId, id);
          }

          result = {
            ...result,
            evidence: result.evidence.map((entry) => ({
              ...entry,
              evidenceId: mapping.get(entry.evidenceId)!,
            })),
            findings: result.findings.map((finding) => ({
              ...finding,
              evidenceIds: finding.evidenceIds.map((id) => mapping.get(id)!),
            })),
          };
        }

        if (
          result?.data?.kind === 'configuration-navigation' &&
          !saved &&
          deps.allowConfigurationNavigation
        ) {
          deps.emit({ ...fields, type: 'configuration-navigation', target: result.data.target });
        }
        if (result) deps.emit({ ...fields, type: 'tool-result', toolCallId: call.id, result });
        else if (error) deps.emit({ ...fields, type: 'tool-error', toolCallId: call.id, error });
      } catch (cause) {
        deps.context.signal.throwIfAborted();
        error =
          cause instanceof HttpError
            ? { code: cause.code, message: cause.message }
            : { code: 'TOOL_FAILED', message: 'The tool could not be completed.' };
        deps.emit({ ...fields, type: 'tool-error', toolCallId: call.id, error });
      }

      const evidence = [
        ...new Map(
          [...state.evidence, ...(result?.evidence ?? [])].map((entry) => [
            entry.evidenceId,
            entry,
          ]),
        ).values(),
      ];
      if (evidence.length > 100) {
        throw new HttpError(429, 'BUDGET_EXCEEDED', 'The turn evidence budget was reached.');
      }
      const execution = { ...call, result, error };
      const content = JSON.stringify(result ?? { error });

      const next: State = {
        ...state,
        pending: state.pending.slice(1),
        toolCount: state.toolCount + 1,
        evidence,
        executions: [...state.executions, execution],
        messages: [...state.messages, { role: 'tool', tool_call_id: call.id, content }],
      };
      if (Buffer.byteLength(JSON.stringify(next)) > 262_144) {
        throw new HttpError(429, 'BUDGET_EXCEEDED', 'The saved turn byte budget was reached.');
      }
      if (next.handoffPending && !next.pending.length) {
        const handoff = next.handoffs[next.specialist]!;
        next.handoffs = {
          ...next.handoffs,
          [next.specialist]: {
            ...handoff,
            evidenceIds: next.evidence.map((entry) => entry.evidenceId),
            limitations: [
              ...handoff.limitations,
              ...next.executions
                .filter((entry) => entry.error)
                .map((entry) => `${entry.name}: ${entry.error!.message}`),
            ].slice(0, 10),
          },
        };
      }
      checked(next);
      await deps.saveTool(next);

      return next;
    })
    .addNode('finalize', async (state) => {
      await deps.guard();
      await deps.finalize(state);

      return { done: true };
    })
    .addEdge(START, 'decision')
    .addConditionalEdges('decision', selectedSpecialist)
    .addConditionalEdges('read', afterSpecialist)
    .addConditionalEdges('configuration', afterSpecialist)
    .addConditionalEdges('response', afterSpecialist)
    .addConditionalEdges('tool', (state) =>
      state.responseMode !== 'investigate'
        ? 'finalize'
        : state.pending.length
          ? 'tool'
          : state.handoffPending
            ? 'decision'
            : state.specialist,
    )
    .addEdge('finalize', END)
    .compile({ checkpointer: saver });
}
