# panda-compact

Compaction for Claude Code that keeps your conversation word for word. When a
session fills up, Claude Code normally replaces the old turns with a summary,
and the summary loses things: a file path, an exact error, a constraint you
gave an hour ago. panda-compact replaces the summary with a judgment: **Haiku,
inside your own session, decides which old tool calls and tool results are no
longer needed**, and the mod drops or shortens only those. Every prompt and
every reply stays exactly as it was.

No API key, no third-party service: the judge runs on the session's own model
client (`$.model.complete`), so your conversation goes nowhere it does not
already go.

## What it does

- **Two questions per tool call.** For each old tool call, Haiku says how
  likely it is that the call still matters, and that its full result is still
  needed.
- **Three outcomes.** Result still needed: call and result stay. Only the call
  matters: the call stays and the result is cut to its first 300 characters
  plus a one-line note. Neither: both go, so no result is left without its call.
- **Protected messages.** The first message and the newest six are never
  touched. Your text and Claude's text are never removed, shortened or
  reordered.
- **Starts by itself at 60%.** After every turn the mod checks the context
  fill and, from 60%, starts a compaction.
- **Falls back to the summary.** If Haiku cannot cut at least 25% of the
  characters, or anything fails, Claude Code's own summary runs as usual. A
  toast says which of the two happened.
- **No loops.** If a compaction of ours leaves the context still over the
  threshold, the next one is Claude Code's summary.

## Install

At the prompt of a terminal session:

```
/plugin install panda-compact --marketplace PandaHound/panda-compact
```

From a shell:

```
claude plugin install panda-compact --marketplace PandaHound/panda-compact
```

In the desktop app: click + next to the prompt box, then Plugins, Add
marketplace with `PandaHound/panda-compact`, then Add plugin.

To remove it: `claude plugin uninstall panda-compact`.

## Where it works

| Where | /compact and Claude Code's own auto-compaction | Starts by itself at 60% |
|---|---|---|
| Terminal (CLI) | yes | yes |
| Desktop app, VS Code, SDK, `claude -p` | yes | only with the setting below |

In the desktop app, the SDK and `claude -p`, Claude Code does not let a plugin
start a compaction. There, ask Claude Code itself to compact at 60%, and every
compaction will go through the mod. Add this to `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "60" } }
```

The mod notices the refusal once, says so in the log and stops trying.

## Options

Set them in the install screen or with `/plugin configure panda-compact`.

| Option | Default | What it sets |
|---|---|---|
| `compactAtPercent` | 60 | Context fill at which the mod starts a compaction |
| `model` | `haiku` | The judge model, as `--model` takes it |
| `keepThreshold` | 0.5 | Minimum probability for a call or result to stay |
| `preserveRecentMessages` | 6 | Newest messages never touched |
| `minReductionRatio` | 0.25 | Minimum cut to use the result; below it the summary runs |
| `truncateHeadChars` | 300 | Characters kept from a result that is cut; 0 keeps only the note |
| `maxStateTokens` | 60000 | Estimated size of the conversation sent to the judge |
| `maxRequestTokens` | 80000 | Estimated size of one request, conversation plus questions |

## What the judge sees and what it costs

The whole conversation, oldest first: prompts, replies and the input of every
tool call (file paths, commands, edits). Tool results are not sent: each is
replaced by a note with its status and length. Long conversations are fitted
to about 60,000 estimated tokens by shortening tool inputs and old texts. The
questions go in batches when they do not fit one request; the conversation
leads each request and is served from the prompt cache after the first. The
calls are billed like any other Haiku call of your session.

## Limits

- Only tool calls and results are removed. Short sessions often fall back to
  the summary because there is not enough to cut.
- A probability is not proof: a dropped result may turn out to be needed.
  Claude can always run the tool again or re-read the file.
- Token sizes are estimated from characters, not counted with a tokenizer.
- Mod events and methods can change between Claude Code versions. Written and
  tested against Claude Code 2.1.308.

## Development

```
claude plugin validate .
claude plugin test .
```

## Credits

The selection logic (`src/compact.ts`, `src/state.ts`, `src/types.ts`) comes
from [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
by Tamara Tran (MIT), which asks TypeSafe's Jev model over the network.
panda-compact asks Haiku inside the session instead and adds the fallback for
hosts that cannot start a compaction and the guard against repeated
compactions.

## License

MIT, see `LICENSE`.
