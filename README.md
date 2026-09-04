# Claude Code Agents Status Bar

How many Claude Code agents are running right now? This extension answers that with one number in your status bar, and one click gives you the whole roster.

> Unofficial extension. Not affiliated with, endorsed by, or supported by Anthropic. "Claude" is a trademark of Anthropic, PBC.

![The running agent count in the VS Code status bar](https://raw.githubusercontent.com/LetermeFlorent/claude-subagents/main/media/statusbar.png)

## The problem

When Claude Code fans out, whether through a `Task` call, a `Workflow` spawning a dozen agents, or a background session left running in another window, that work becomes invisible. The official extension shows you the conversation you are looking at, not the fleet behind it. You end up wondering whether anything is still running, or whether you are burning tokens on agents you forgot about.

## What you get

A single status bar item, always visible, spinning while work is in flight:

```
$(sync~spin) 3 agents
```

Click it and you get every one of them, grouped by the Claude session that spawned them:

```
Session #1  a3f19c02
⟳ cavecrew-investigator  @claude-opus-5  e:high        42s
  #1 [hive] locate the worktree spawn path

⟳ general-purpose  @claude-sonnet-5                   3m18s  silencieux 8s
  #1 [hive] audit the fallback path

Session #2  7b04ee51
⟳ bg  @claude-opus-5  e:medium                       17m04s
  #2 [resume-mail] watching CI on the docker branch
```

Agent type, model, reasoning effort, elapsed time, project and the description the agent was spawned with, all searchable since the quick pick matches on every field. Durations count up live while the list is open. Pressing Enter on an agent opens its transcript.

## Telling three sessions apart

Claude Code stores subagents under the session that spawned them, at `~/.claude/projects/<project>/<session>/subagents/`. Running three Claude sessions in one project therefore produces three separate trees, and each agent belongs to exactly one of them. The list groups agents under their parent session and gives each one a short number, so you can tell which of your windows is doing what.

## Features

Everything gets counted, not just the obvious: `Task` and `Agent` subagents, agents spawned inside a `Workflow`, and background sessions started with `claude agents` or `claude --bg`.

Thinking time does not kill an agent. Workflow agents are tracked through the run journal rather than file timestamps, so one that reasons for four minutes without writing anything still counts as alive.

The list is scoped to your workspace by default, so a busy machine does not pollute the window you are working in, and one setting shows everything. Remote machines work too, over plain SSH, which lets you watch the agents running on a VPS from your laptop.

No dependencies and no network access. The extension reads files Claude Code already writes, and transcript headers are cached between scans, so a steady state costs no disk reads at all.

## How it works

Claude Code records every agent on disk. The extension reads those records every few seconds and decides what is still alive:

| Source | Path | Alive when |
| --- | --- | --- |
| Subagents | `~/.claude/projects/<project>/<session>/subagents/agent-<id>.{meta.json,jsonl}` | transcript written less than 30 s ago |
| Workflow agents | same tree, under `subagents/workflows/wf_*/` | `journal.jsonl` shows a `started` line for that agent and no terminating line, capped at 15 min so a killed workflow does not linger |
| Background sessions | `~/.claude/daemon/roster.json` plus `~/.claude/jobs/<id>/state.json` | live PID, non-idle tempo, or timeline written less than 60 s ago |

The journal rule is the important one. A thinking agent writes nothing for minutes, so the naive "was the transcript touched recently?" check reports most of a workflow as dead.

`CLAUDE_CONFIG_DIR` and `CLAUDE_PROJECTS_DIR` are honoured if you have moved your Claude directory.

## Watching remote machines

Add SSH aliases from your `~/.ssh/config`:

```jsonc
"claudeSubagents.remoteHosts": ["growthfit", "syllabis-vps"]
```

Each host is polled every 15 s with `ssh -o BatchMode=yes` (6 s timeout), and its agents appear in the list prefixed with the host name. Requires `ssh` on your `PATH` and a key without a passphrase, since batch mode never prompts: it fails silently and the host is skipped.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeSubagents.refreshSeconds` | `3` | Local refresh interval, in seconds. An open list recomputes durations every second without reading the disk |
| `claudeSubagents.idleMultiplier` | `2` | Interval multiplier when no agent is running. 1 keeps one cadence |
| `claudeSubagents.unfocusedMultiplier` | `4` | Interval multiplier when the window has no focus. Regaining focus rescans at once |
| `claudeSubagents.alignment` | `"right"` | Which side of the status bar to sit on |
| `claudeSubagents.priority` | `-1000` | Position within that side. Higher values push the item further left, so a low value keeps it at the far right |
| `claudeSubagents.remoteHosts` | `[]` | SSH aliases to poll in addition to the local machine |
| `claudeSubagents.showBackground` | `true` | Include background sessions in the count and the list |
| `claudeSubagents.showAllProjects` | `false` | Ignore the workspace filter and show agents from every project on the machine |

## Commands

| Command | What it does |
| --- | --- |
| `Claude Subagents: Show the list of active agents` | Same as clicking the status bar item |
| `Claude Subagents: Refresh` | Forces an immediate rescan |

## Troubleshooting

If it always says 0 agent, remember that only agents whose working directory is inside the current workspace are counted by default. Turn on `claudeSubagents.showAllProjects` to check whether that filter is what hides them.

If remote agents never appear, test the exact command the extension uses: `ssh -o BatchMode=yes <alias> true`. Anything that prompts or fails leaves the extension with nothing.

Two items in the status bar over Remote-SSH should not happen, since the extension declares `"extensionKind": ["ui"]` and only ever runs in the local extension host. If you installed an older build server-side, uninstall it there.

## Privacy

No telemetry, no analytics and no network access, apart from the `ssh` calls to hosts you explicitly list. Everything else is local file reads.

## License

MIT
