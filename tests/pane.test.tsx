import { expect, test } from 'claude-code/testing';

const PANE = {
  plugin: 'panda-compact',
  component: 'Pane',
  requestId: 'panda-compact',
  props: {
    title: 'Compact',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const;

function engine(on: Parameters<Parameters<typeof test>[1]>[1], language: unknown, percent = 35) {
  on('command.register', () => ({ value: { command: 'panda-compact' } }));
  on('ui.open', () => ({ value: { isPlaced: true } }));
  on('settings.read', () => ({ value: language === undefined ? {} : { language } }));
  on('session.usage', () => ({
    value: { startedAt: 0, rateLimits: [], context: { percent, window: 200_000, tokens: percent * 2000 } },
  }));
  on('session.start', (_, e) => ({ cwd: e.cwd }));
}

test('the pane shows the fill, the threshold and a Compact button, on every surface', async ($, on) => {
  engine(on, undefined);
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true });
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface });
    expect((await ui.find({ type: 'Text', text: /^Context 35%$/ }))?.text).toBe('Context 35%');
    expect((await ui.find({ type: 'Text', text: /Auto-compact at 60%/ }))?.text).toBe('Auto-compact at 60%');
    expect(await ui.find({ type: 'Button', key: 'compact' })).toBeTruthy();
    await ui.unmount();
  }
});

test('the pane speaks the language set in Claude Code', async ($, on) => {
  engine(on, 'italian');
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true });
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' });
  expect((await ui.find({ type: 'Text', text: /^Contesto 35%$/ }))?.text).toBe('Contesto 35%');
  expect((await ui.find({ type: 'Text', text: /Compattazione automatica al 60%/ }))?.text).toBe(
    'Compattazione automatica al 60%',
  );
  await ui.unmount();
});

test('a language the mod has no words for falls back to English', async ($, on) => {
  engine(on, 'japanese');
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true });
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' });
  expect((await ui.find({ type: 'Text', text: /^Context 35%$/ }))?.text).toBe('Context 35%');
  await ui.unmount();
});

test('pressing the button starts a compaction', async ($, on) => {
  engine(on, undefined);
  let compactions = 0;
  on('session.compact', () => {
    compactions += 1;
    return { messages: [{ role: 'user' as const, text: 'built-in summary', toolUses: [] }] };
  });
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true });
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface });
    await ui.press({ key: 'compact' });
    await ui.unmount();
  }
  expect(compactions).toBe(2);
});

test('a compaction writes nothing in the transcript', async ($, on) => {
  engine(on, undefined);
  const transcript: string[] = [];
  on('ui.log', (_, e) => {
    if (e.to === 'transcript') transcript.push(e.text);
    return { value: undefined };
  });
  on('ui.toast', () => ({ value: undefined }));
  on('model.complete', () => ({
    value: { isAnswered: true, text: '{}', usage: { input_tokens: 1, output_tokens: 1 } },
  }));
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'built-in summary', toolUses: [] }] }));
  await $.session.compact({
    trigger: 'manual',
    messages: [{ role: 'user', text: 'hi', toolUses: [] }],
  });
  expect(transcript.length).toBe(0);
});
