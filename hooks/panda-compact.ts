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

function notify(
  $: { ui: { log: (t: string) => void; toast: (t: string, o?: { timeoutMs?: number }) => void } },
  text: string,
): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}

export const register: Register =(on: On, options: PluginOptions) => {
  const config = resolveHookConfig(options);
  let compacting = false;
  /** Set when a compaction of ours left the context still over the threshold. */
  let summaryNext = false;
  let lastWasOurs = false;
  /** Set once the host has refused `$.session.compact` from a plugin. */
  let selfTriggerOff = false;

  on('session.compact', async ($, event, next) => {
    lastWasOurs = false;
    // A precomputed summary is the engine's own business.
    if (event.trigger === 'precompute' || !Array.isArray(event.messages)) return next(event);
    if (summaryNext && !event.agentId) {
      summaryNext = false;
      notify($, 'built-in summary (the last compaction left the context over the threshold)');
      return next(event);
    }
    try {
      const { result, messages } = await compactSession(event.messages, config, (request) =>
        $.model.complete(request),
      );
      for (const line of decisionLogLines(result)) $.ui.log(line);
      if (reductionRatio(result) < config.minReductionRatio) {
        notify($, `built-in summary (below the ${percent(config.minReductionRatio)} minimum: ${summarize(result)})`);
        return next(event);
      }
      if (!event.agentId) lastWasOurs = true;
      notify($, `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`);
      return { messages };
    } catch (error) {
      notify($, `built-in summary (${error instanceof Error ? error.message : String(error)})`);
      return next(event);
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    // Subagents have their own window; this hook watches the main conversation.
    // Where the host cannot start a compaction from a plugin (desktop app, SDK,
    // claude -p) the mod stops trying after the first refusal: there the engine's
    // own threshold (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE) brings compactions to it.
    if (compacting || selfTriggerOff || event.agentId) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < config.compactAtPercent) {
        lastWasOurs = false;
        return next(event);
      }
      // Ours ran last turn and the window is still full: let the engine summarize.
      if (lastWasOurs) summaryNext = true;
      compacting = true;
      await $.session.compact();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (/not available/i.test(reason)) {
        selfTriggerOff = true;
        summaryNext = false;
        $.ui.log(
          `this host cannot start a compaction from a plugin; set CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=${config.compactAtPercent} so the engine compacts at that fill (${reason})`,
        );
      } else {
        $.ui.log(`auto-compact skipped (${reason})`);
      }
    } finally {
      compacting = false;
    }
    return next(event);
  });
};
