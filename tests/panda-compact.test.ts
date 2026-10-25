import { expect, test } from 'claude-code/testing';

type Msg = {
  role: 'user' | 'assistant';
  text: string;
  toolUses: { tool_use_id: string; tool: string; input: Record<string, unknown>; text?: string }[];
  toolResults?: { tool_use_id: string; text: string; isError: boolean }[];
  handle?: string;
};

const big = 'export const a = 1;\n'.repeat(400);

function msg(role: Msg['role'], text: string, extra: Partial<Msg> = {}): Msg {
  return { role, text, toolUses: [], ...extra };
}
function call(id: string, tool: string, input: Record<string, unknown>, out: string): Msg {
  return msg('assistant', '', { toolUses: [{ tool_use_id: id, tool, input, text: out }], handle: `c-${id}` });
}
function result(id: string, out: string): Msg {
  return msg('user', '', { toolResults: [{ tool_use_id: id, text: out, isError: false }], handle: `r-${id}` });
}

/** A session: two old reads (one stale), then six recent messages the mod never touches. */
function transcript(): Msg[] {
  return [
    msg('user', 'Fix the failing test in b.ts.', { handle: 'h0' }),
    call('u1', 'Read', { file_path: 'src/a.ts' }, big),
    result('u1', big),
    call('u2', 'Read', { file_path: 'src/b.ts' }, big),
    result('u2', big),
    msg('assistant', 'b.ts is the one that matters.', { handle: 'h5' }),
    msg('user', 'ok', { handle: 'h6' }),
    msg('assistant', 'Editing b.ts.', { handle: 'h7' }),
    msg('user', 'go', { handle: 'h8' }),
    msg('assistant', 'Done.', { handle: 'h9' }),
    msg('user', 'thanks', { handle: 'h10' }),
  ];
}

const SUMMARY = [{ role: 'user' as const, text: 'built-in summary', toolUses: [] }];

test('the judge drops a stale result and keeps every text verbatim', async ($, on) => {
  const asked: string[] = [];
  on('model.complete', (_, e) => {
    asked.push(`${e.model}|${e.prompt}`);
    // a.ts no longer matters at all; b.ts's call matters but its full text does not
    return { value: { isAnswered: true, text: '{"call_t1":0.1,"result_t1":0.1,"call_t2":0.9,"result_t2":0.2}', usage: { input_tokens: 1, output_tokens: 1 } } };
  });
  on('session.compact', () => ({ messages: SUMMARY }));

  const out = await $.session.compact({ trigger: 'manual', messages: transcript() });
  const messages = out.messages ?? [];

  expect(asked.length).toBe(1);
  expect(asked[0]?.startsWith('haiku|')).toBe(true);
  // the a.ts call and its result are gone, b.ts stays with a cut result
  expect(messages.length).toBe(9);
  expect(messages.some((m) => m.toolUses.some((t) => t.tool_use_id === 'u1'))).toBe(false);
  const b = messages.find((m) => m.toolResults?.some((r) => r.tool_use_id === 'u2'));
  expect(b?.toolResults?.[0]?.text.includes('panda-compact truncated')).toBe(true);
  // every prompt and reply is still there, word for word
  for (const text of ['Fix the failing test in b.ts.', 'b.ts is the one that matters.', 'Done.', 'thanks']) {
    expect(messages.some((m) => m.text === text)).toBe(true);
  }
});

test('a reply that is not JSON falls back to the built-in summary', async ($, on) => {
  on('model.complete', () => ({ value: { isAnswered: true, text: 'sorry, no', usage: { input_tokens: 1, output_tokens: 1 } } }));
  on('session.compact', () => ({ messages: SUMMARY }));
  const out = await $.session.compact({ trigger: 'manual', messages: transcript() });
  expect(out.messages?.[0]?.text).toBe('built-in summary');
});

test('a judge that keeps everything falls back to the built-in summary', async ($, on) => {
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"call_t1":1,"result_t1":1,"call_t2":1,"result_t2":1}', usage: { input_tokens: 1, output_tokens: 1 } } }));
  on('session.compact', () => ({ messages: SUMMARY }));
  const out = await $.session.compact({ trigger: 'manual', messages: transcript() });
  expect(out.messages?.[0]?.text).toBe('built-in summary');
});

test('an API error falls back to the built-in summary', async ($, on) => {
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: { input_tokens: 0, output_tokens: 0 } } }));
  on('session.compact', () => ({ messages: SUMMARY }));
  const out = await $.session.compact({ trigger: 'manual', messages: transcript() });
  expect(out.messages?.[0]?.text).toBe('built-in summary');
});

test('a precompute is left to the engine and asks nothing', async ($, on) => {
  let asked = 0;
  on('model.complete', () => {
    asked += 1;
    return { value: { isAnswered: true, text: '{}', usage: { input_tokens: 0, output_tokens: 0 } } };
  });
  on('session.compact', () => ({ messages: SUMMARY }));
  await $.session.compact({ trigger: 'precompute', messages: transcript() });
  expect(asked).toBe(0);
});

function usage(percent: number) {
  return () => ({ value: { startedAt: 0, rateLimits: [], context: { percent, window: 200_000, tokens: percent * 2000 } } });
}
const TURN = { answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'end_turn' } as const;

test('at 60% after a turn the mod starts a compaction', async ($, on) => {
  let compactions = 0;
  on('session.usage', usage(61));
  on('session.compact', () => {
    compactions += 1;
    return { messages: SUMMARY };
  });
  on('turn.complete', () => ({ text: 'ok' }));
  await $.turn.complete({ ...TURN });
  expect(compactions).toBe(1);
});

test('under 60% nothing happens', async ($, on) => {
  let compactions = 0;
  on('session.usage', usage(59));
  on('session.compact', () => {
    compactions += 1;
    return { messages: SUMMARY };
  });
  on('turn.complete', () => ({ text: 'ok' }));
  await $.turn.complete({ ...TURN });
  expect(compactions).toBe(0);
});

test('a subagent turn starts nothing', async ($, on) => {
  let compactions = 0;
  on('session.usage', usage(90));
  on('session.compact', () => {
    compactions += 1;
    return { messages: SUMMARY };
  });
  on('turn.complete', () => ({ text: 'ok' }));
  await $.turn.complete({ ...TURN, agentId: 'a1' });
  expect(compactions).toBe(0);
});

