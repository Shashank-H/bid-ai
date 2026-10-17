import type { State } from './state.js';
import { HttpError } from '../errors.js';

export const FIXED_RESPONSES = {
  out_of_scope:
    'I can help investigate publisher auction performance and assist with publisher configurations. Please ask a question within that scope.',
  clarify:
    'Would you like me to investigate publisher performance or help with a particular configuration setting or change?',
} as const;

export const INSUFFICIENT_EVIDENCE =
  'Insufficient evidence: No authorized observations were retrieved for this investigation.';

function citationIds(text: string): string[] {
  return [...text.matchAll(/\[([A-Za-z0-9._:,\s-]+)\]/g)].flatMap((match) =>
    match[1]!.split(',').map((id) => id.trim()),
  );
}

export function validateAnswer(state: State): void {
  const ids = new Set(state.evidence.map((entry) => entry.evidenceId));
  const text = state.answer.trim();

  if (state.responseMode === 'out_of_scope' || state.responseMode === 'clarify') {
    const decision = state.decisions?.at(-1);
    if (text !== FIXED_RESPONSES[state.responseMode] || decision?.route !== state.responseMode) {
      throw new HttpError(502, 'EVIDENCE_INVALID', 'The fixed scope response was not validated.');
    }

    return;
  }

  if (!ids.size) {
    if (text !== INSUFFICIENT_EVIDENCE)
      throw new HttpError(
        502,
        'EVIDENCE_INVALID',
        'The answer has no supporting observations and was not validated.',
      );
    return;
  }

  const citations = citationIds(text);
  if (!citations.length || citations.some((id) => !ids.has(id))) {
    throw new HttpError(
      502,
      'EVIDENCE_INVALID',
      'The answer contains missing or unknown evidence references.',
    );
  }

  const plain = text.replaceAll('**', '');
  const sections = [
    ...plain.matchAll(
      /(?:^|\n)\s*(?:#{1,4}\s*)?(Observations?|Hypothes(?:is|es)|Recommendations?)\s*:?/gi,
    ),
  ];
  const expected = ['observation', 'hypothes', 'recommendation'];

  if (
    sections.length !== 3 ||
    sections.some((match, index) => !match[1]!.toLowerCase().startsWith(expected[index]!))
  ) {
    throw new HttpError(
      502,
      'EVIDENCE_INVALID',
      'The answer must distinguish observations, hypotheses and recommendations.',
    );
  }

  const start = sections[0]!.index! + sections[0]![0].length;
  const end = sections[1]!.index!;
  const observationCitations = citationIds(plain.slice(start, end));

  if (!observationCitations.some((id) => ids.has(id))) {
    throw new HttpError(502, 'EVIDENCE_INVALID', 'The observations have no supporting evidence.');
  }
}
