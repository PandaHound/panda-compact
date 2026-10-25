import { atom, read, update } from 'claude-code';
import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, reductionRatio } from '../src/compact.js';
import { DEFAULT_MODEL, modelJudge, type CompleteFn } from '../src/judge.js';
import { wordsFor, type Words } from '../src/i18n.js';
import type { CompactOptions, CompactResult, Message, ToolResult, ToolUse } from '../src/types.js';

export const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  model: DEFAULT_MODEL,
  maxStateTokens: 60_000,
  maxRequestTokens: 80_000,
};

export type HookConfig = CompactOptions & {
  compactAtPercent: number;
  minReductionRatio: number;
  model: string;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const config: HookConfig = {
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(options, 'minReductionRatio', HOOK_DEFAULTS.minReductionRatio),
    maxStateTokens: optionNumber(options, 'maxStateTokens', HOOK_DEFAULTS.maxStateTokens),
    maxRequestTokens: optionNumber(options, 'maxRequestTokens', HOOK_DEFAULTS.maxRequestTokens),
    model:
      typeof options['model'] === 'string' && options['model'].length > 0
        ? options['model']
        : HOOK_DEFAULTS.model,
  };
  for (const key of ['keepThreshold', 'preserveRecentMessages', 'truncateHeadChars'] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) config[key] = value;
  }
  return config;
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = { tool_use_id: tool.tool_use_id, tool: tool.tool, input: tool.input };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return { tool_use_id: result.tool_use_id, text: result.text, isError: result.isError ?? false };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged is the engine's own object, handle included; anything rebuilt is a
 * fresh message without a handle, so the engine takes the edited content.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = { result: CompactResult; messages: SessionMessage[] };

/** Runs the compaction over a session transcript; throws when the judge fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  complete: CompleteFn,
): Promise<SessionCompaction> {
  const result = await compact(messages, modelJudge(complete, config.model), config);
  return { result, messages: toSessionMessages(messages, result.messages) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} calls dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; ${stats.requests} request(s) in ${Math.round(stats.ms / 100) / 10}s`;
}

const UI_LOG_MAX_CHARS = 4096;

/** One line per decision chunk, each under the host's log limit. */
export function decisionLogLines(result: CompactResult, maxChars: number = UI_LOG_MAX_CHARS): string[] {
  const entries = result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map((d) => `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 40) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, i) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${i + 1}/${chunks.length}): ${chunk}`,
  );
}


export const PANE = 'panda-compact';
const fill = atom({ plugin: 'panda-compact', key: 'percent' } as const, null);
const busy = atom({ plugin: 'panda-compact', key: 'isBusy' } as const, false);

const BAR_WIDTH = 280;

/** The fill bar with a mark above it where the automatic compaction starts. */
export function barSvg(percent: number | null, auto: number): string {
  const clamp = (v: number) => Math.min(100, Math.max(0, v));
  const filled = Math.round((BAR_WIDTH * clamp(percent ?? 0)) / 100);
  const mark = Math.round((BAR_WIDTH * clamp(auto)) / 100);
  const x = Math.min(BAR_WIDTH - 5, Math.max(5, mark));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_WIDTH}" height="20" viewBox="0 0 ${BAR_WIDTH} 20">`,
    `<path d="M${x - 5} 0 L${x + 5} 0 L${x} 7 Z" fill="#8c8c8c"/>`,
    `<rect x="0" y="10" width="${BAR_WIDTH}" height="8" rx="4" fill="#8c8c8c" fill-opacity="0.3"/>`,
    filled > 0 ? `<rect x="0" y="10" width="${filled}" height="8" rx="4" fill="#6f5cf0"/>` : '',
    `<rect x="${mark - 1}" y="9" width="2" height="10" fill="#8c8c8c"/>`,
    '</svg>',
  ].join('');
}

/** The same bar in text, for a surface that draws no SVG (the terminal). */
export function barText(percent: number | null, auto: number, width: number): [string, string] {
  const cells = Math.max(10, Math.min(40, width));
  const filled = Math.round((cells * Math.min(100, Math.max(0, percent ?? 0))) / 100);
  const mark = Math.min(cells - 1, Math.round((cells * Math.min(100, Math.max(0, auto))) / 100));
  return [' '.repeat(mark) + '▼', '█'.repeat(filled) + '░'.repeat(cells - filled)];
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Ui = { ui: { log: (t: string, o?: { to?: 'transcript' | 'debug' }) => void } };

/** Details go to the debug log only: the transcript stays clean. */
function debug($: Ui, text: string): void {
  $.ui.log(text, { to: 'debug' });
}

export const register: Register = (on: On, options: PluginOptions) => {
  const config = resolveHookConfig(options);
  let words: Words = wordsFor(undefined);
  let compacting = false;
  /** Set when a compaction of ours left the context still over the threshold. */
  let summaryNext = false;
  let lastWasOurs = false;
  /** Set once the host has refused `$.session.compact` from a plugin. */
  let selfTriggerOff = false;

  on('session.start', async ($, event, next) => {
    try {
      const language = await $.settings.read({ key: 'language' });
      const value =
        typeof language === 'string'
          ? language
          : (language as Record<string, unknown> | undefined)?.['language'];
      words = wordsFor(value);
    } catch (error) {
      debug($, `language not read (${reasonOf(error)})`);
    }
    try {
      const { context } = await $.session.usage();
      await update($, fill, () => context.percent ?? null);
    } catch (error) {
      debug($, `usage not read (${reasonOf(error)})`);
    }
    await $.command.register({ name: 'panda-compact', description: words.title });
    void $.ui.open({ id: PANE, title: words.title });
    return next(event);
  });

  on('command.run', { command: 'panda-compact' }, async ($) => {
    await $.ui.open({ id: PANE, title: words.title });
    return { text: words.title };
  });

  on('session.compact', async ($, event, next) => {
    lastWasOurs = false;
    // A precomputed summary is the engine's own business.
    if (event.trigger === 'precompute' || !Array.isArray(event.messages)) return next(event);
    if (summaryNext && !event.agentId) {
      summaryNext = false;
      debug($, 'built-in summary: the last compaction left the context over the threshold');
      $.ui.toast(words.summary);
      return next(event);
    }
    try {
      const { result, messages } = await compactSession(event.messages, config, (request) =>
        $.model.complete(request),
      );
      for (const line of decisionLogLines(result)) debug($, line);
      if (reductionRatio(result) < config.minReductionRatio) {
        debug($, `built-in summary: below the ${percent(config.minReductionRatio)} minimum (${summarize(result)})`);
        if (!event.agentId) $.ui.toast(words.summary);
        return next(event);
      }
      if (!event.agentId) {
        lastWasOurs = true;
        $.ui.toast(words.kept(percent(reductionRatio(result))));
        await update($, fill, () => null);
      }
      debug($, `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`);
      return { messages };
    } catch (error) {
      debug($, `built-in summary: ${reasonOf(error)}`);
      if (!event.agentId) $.ui.toast(words.summary);
      return next(event);
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    // Subagents have their own window; this hook watches the main conversation.
    if (compacting || event.agentId) return next(event);
    try {
      const { context } = await $.session.usage();
      await update($, fill, () => context.percent ?? null);
      // Where the host cannot start a compaction from a plugin (desktop app, SDK,
      // claude -p) the mod stops trying after the first refusal: there the
      // engine's own threshold (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE) brings them.
      if (selfTriggerOff || (context.percent ?? 0) < config.compactAtPercent) {
        lastWasOurs = false;
        return next(event);
      }
      // Ours ran last turn and the window is still full: let the engine summarize.
      if (lastWasOurs) summaryNext = true;
      compacting = true;
      await $.session.compact();
    } catch (error) {
      const reason = reasonOf(error);
      if (/not available/i.test(reason)) {
        selfTriggerOff = true;
        summaryNext = false;
        debug(
          $,
          `this host cannot start a compaction from a plugin; set CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=${config.compactAtPercent} so the engine compacts at that fill (${reason})`,
        );
      } else {
        debug($, `auto-compact skipped (${reason})`);
      }
    } finally {
      compacting = false;
    }
    return next(event);
  });

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e);
    const { Box, Text, Button } = table;
    const value = await read($, fill);
    const isBusy = await read($, busy);
    const auto = config.compactAtPercent;
    const press = async () => {
      if (await read($, busy)) return;
      await update($, busy, () => true);
      try {
        await $.session.compact();
      } catch (error) {
        // Hosts without a terminal (desktop app, SDK) refuse a plugin's direct
        // compaction; there the button runs /compact as if the person typed it.
        debug($, `direct compaction refused (${reasonOf(error)}); running /compact`);
        try {
          await $.command.run({ command: 'compact' });
        } catch (fallback) {
          debug($, `/compact refused (${reasonOf(fallback)})`);
          $.ui.toast(words.unavailable);
        }
      } finally {
        await update($, busy, () => false);
      }
    };
    const columns = (e.props as { bodyColumns?: number }).bodyColumns ?? 40;
    const Svg = 'Svg' in table ? table.Svg : undefined;
    const [markRow, barRow] = barText(value, auto, columns - 2);
    return (
      <Box flexDirection="column">
        {Svg ? (
          <Svg source={barSvg(value, auto)} alt={words.barAlt(value, auto)} />
        ) : (
          <Box flexDirection="column">
            <Text dimColor>{markRow}</Text>
            <Text>{barRow}</Text>
          </Box>
        )}
        <Text>{value === null ? words.noData : words.context(value)}</Text>
        <Text dimColor>{words.auto(auto)}</Text>
        <Box>
          <Button key="compact" label={isBusy ? words.busy : words.button} onPress={press} />
        </Box>
      </Box>
    );
  });
};
