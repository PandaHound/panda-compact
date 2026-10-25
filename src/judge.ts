import type { Judge, JudgeAnswer, JudgeQuestions, JudgeResponse, JudgeState } from './types.js';

/** The shape of `$.model.complete` this module needs, so it can be driven without an engine. */
export type CompleteFn = (request: {
  model: string;
  system?: string;
  prompt: string | readonly { text: string; cache?: true }[];
  maxTokens?: number;
  timeoutMs?: number;
}) => Promise<
  | { isAnswered: true; text: string }
  | { isAnswered: false; reason: string; status?: number | null; error?: string }
>;

export const DEFAULT_MODEL = 'haiku';

const SYSTEM =
  'You help a coding assistant free context. You read its conversation and say, for each question, ' +
  'how likely the statement is true. You reply with one JSON object and nothing else.';

/** The questions and the answer format: the part of the prompt that changes per batch. */
export function questionsText(questions: JudgeQuestions): string {
  const lines = Object.entries(questions).map(([name, q]) => `- ${name}: ${q.instructions}`);
  return [
    'QUESTIONS. For each name, give the probability (0 to 1) that the statement is true.',
    'When in doubt, keep: a wrong drop costs more than a wrong keep.',
    ...lines,
    '',
    'Reply with exactly one JSON object mapping every name above to a number, for example',
    '{"call_t1": 0.9, "result_t1": 0.2}. No other text.',
  ].join('\n');
}

/** Reads the JSON object out of the reply; tolerates text or code fences around it. */
export function parseReply(text: string, questions: JudgeQuestions): JudgeResponse {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('the judge replied without a JSON object');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error('the judge replied with malformed JSON');
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('the judge replied with no object');
  }
  const names = Object.keys(questions);
  const answers: Record<string, JudgeAnswer> = {};
  let missing = 0;
  for (const name of names) {
    const value = (parsed as Record<string, unknown>)[name];
    if (typeof value === 'number' && Number.isFinite(value)) {
      answers[name] = { noul: Math.min(1, Math.max(0, value)) };
    } else {
      // A question left unanswered is kept, never dropped.
      answers[name] = { noul: 1 };
      missing += 1;
    }
  }
  if (names.length > 0 && missing * 2 > names.length) {
    throw new Error(`the judge left ${missing} of ${names.length} questions unanswered`);
  }
  return { answers, missing };
}

/** The probability of one answer; throws when it is not there. */
export function noulAnswer(answers: Record<string, JudgeAnswer>, name: string): number {
  const answer = answers[name];
  if (
    !answer ||
    !('noul' in answer) ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul)
  ) {
    throw new Error(`Invalid judge answer for ${name}`);
  }
  return answer.noul;
}

/**
 * A judge over the session's own model client. The conversation state leads
 * the prompt and is marked for the prompt cache, so the batches after the
 * first read it from the cache instead of paying for it again.
 */
export function modelJudge(complete: CompleteFn, model: string, timeoutMs = 180_000): Judge {
  return {
    async ask(state: JudgeState, questions: JudgeQuestions): Promise<JudgeResponse> {
      const count = Object.keys(questions).length;
      const reply = await complete({
        model,
        system: SYSTEM,
        prompt: [
          { text: `CONVERSATION STATE (JSON):\n${JSON.stringify(state)}`, cache: true },
          { text: questionsText(questions) },
        ],
        maxTokens: Math.min(16_000, Math.max(512, count * 14 + 200)),
        timeoutMs,
      });
      if (!reply.isAnswered) {
        const detail = reply.status ? ` ${reply.status}` : '';
        throw new Error(`the judge did not answer (${reply.reason}${detail})`);
      }
      return parseReply(reply.text, questions);
    },
  };
}
