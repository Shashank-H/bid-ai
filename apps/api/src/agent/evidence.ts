import type { State } from './state.js';
import { HttpError } from '../errors.js';

export const INSUFFICIENT_EVIDENCE = 'Insufficient evidence: No authorized observations were retrieved for this investigation.';

export function validateAnswer(state: State): void {
  const ids = new Set(state.evidence.map((entry) => entry.evidenceId));
  const text = state.answer.trim();

  if (!ids.size) {
    if (text !== INSUFFICIENT_EVIDENCE) throw new HttpError(502, 'EVIDENCE_INVALID', 'The answer has no supporting observations and was not validated.');
    return;
  }

  const citations = [...text.matchAll(/\[([A-Za-z0-9._:-]+)\]/g)].map((match) => match[1]!);
  if (!citations.length || citations.some((id) => !ids.has(id))) {
    throw new HttpError(502, 'EVIDENCE_INVALID', 'The answer contains missing or unknown evidence references.');
  }

  const plain = text.replaceAll('**', '');
  const sections = [...plain.matchAll(/(?:^|\n)\s*(?:#{1,4}\s*)?(Observations?|Hypothes(?:is|es)|Recommendations?)\s*:?/gi)];
  const expected = ['observation', 'hypothes', 'recommendation'];

  if (sections.length !== 3 || sections.some((match, index) => !match[1]!.toLowerCase().startsWith(expected[index]!))) {
    throw new HttpError(502, 'EVIDENCE_INVALID', 'The answer must distinguish observations, hypotheses and recommendations.');
  }

  for (let index = 0; index < sections.length; index++) {
    const start = sections[index]!.index! + sections[index]![0].length;
    const end = sections[index + 1]?.index ?? plain.length;
    const sectionCitations = [...plain.slice(start, end).matchAll(/\[([A-Za-z0-9._:-]+)\]/g)];

    if (!sectionCitations.some((match) => ids.has(match[1]!))) {
      throw new HttpError(502, 'EVIDENCE_INVALID', 'An answer section has no supporting evidence.');
    }
  }
}
