# Claude Agents Status Bar

[![Version](https://img.shields.io/visual-studio-marketplace/v/letermeflorent.claude-agents-statusbar?label=marketplace)](https://marketplace.visualstudio.com/items?itemName=letermeflorent.claude-agents-statusbar)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/letermeflorent.claude-agents-statusbar)](https://marketplace.visualstudio.com/items?itemName=letermeflorent.claude-agents-statusbar)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**How many Claude Code agents are running right now?** This extension answers that with one number in your status bar — and one click gives you the whole roster.

> **Unofficial extension.** Not affiliated with, endorsed by, or supported by Anthropic. "Claude" is a trademark of Anthropic, PBC.

---

![The running agent count in the VS Code status bar](https://raw.githubusercontent.com/LetermeFlorent/claude-subagents/main/media/statusbar.png)

## The problem

When Claude Code fans out — a `Task` call, a `Workflow` spawning a dozen agents, a background session left running in another window — that work becomes invisible. The official extension shows you the conversation you are looking at, not the fleet behind it. You end up wondering whether anything is still running, or whether you are burning tokens on agents you forgot about.

## What you get

A single status bar item, always visible, spinning while work is in flight:

```
$(sync~spin) 3 agents
```

Click it and you get every one of them, sorted by most recent activity:

```
⟳ cavecrew-investigator  @claude-opus-5  e:high            42s
  [hive] locate the worktree spawn path

⟳ general-purpose  @claude-sonnet-5                       3m18s
  [chartographer] audit CurseForge fallback

⟳ bg  @claude-opus-5  e:medium                            17m04s
  [resume-mail] watching CI on the docker branch
```

Agent type, model, reasoning effort, elapsed time, project, and the description the agent was spawned with — searchable, because the QuickPick matches on all of it.

## Features

- **Counts everything**, not just the obvious: `Task`/`Agent` subagents, agents spawned inside a `Workflow`, and background sessions (`claude agents`, `claude --bg`)
- **Survives thinking time.** Workflow agents are tracked through the run journal, not file timestamps — an agent that reasons for four minutes without writing anything still counts as alive
- **Scoped to your workspace** by default, so a busy machine does not pollute the window you are working in. One setting shows everything
- **Remote machines too**, over plain SSH — see the agents running on your VPS from your laptop
- **Zero dependencies, zero network.** Reads files Claude Code already writes. Nothing is sent anywhere

## How it works

Claude Code records every agent on disk. The extension reads those records every few seconds and decides what is still alive:

| Source | Path | Alive when |
| --- | --- | --- |
| Subagents | `~/.claude/projects/<project>/<session>/subagents/agent-<id>.{meta.json,jsonl}` | transcript written less than 30 s ago |
| Workflow agents | same tree, under `subagents/workflows/wf_*/` | `journal.jsonl` shows a `started` line for that agent and no terminating line — capped at 15 min so a killed workflow does not linger |
| Background sessions | `~/.claude/daemon/roster.json` + `~/.claude/jobs/<id>/state.json` | live PID, non-idle tempo, or timeline written less than 60 s ago |

The journal rule is the important one. A thinking agent writes nothing for minutes, so the naive "was the transcript touched recently?" check reports most of a workflow as dead.

`CLAUDE_CONFIG_DIR` and `CLAUDE_PROJECTS_DIR` are honoured if you have moved your Claude directory.

## Watching remote machines

Add SSH aliases from your `~/.ssh/config`:

```jsonc
"claudeSubagents.remoteHosts": ["growthfit", "syllabis-vps"]
```

Each host is polled every 15 s with `ssh -o BatchMode=yes` (6 s timeout), and its agents appear in the list prefixed with the host name. Requires `ssh` on your `PATH` and a key without a passphrase — batch mode never prompts, it just fails silently and the host is skipped.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeSubagents.refreshSeconds` | `3` | Local refresh interval, in seconds |
| `claudeSubagents.remoteHosts` | `[]` | SSH aliases to poll in addition to the local machine |
| `claudeSubagents.showBackground` | `true` | Include background sessions in the count and the list |
| `claudeSubagents.showAllProjects` | `false` | Ignore the workspace filter and show agents from every project on the machine |

## Commands

| Command | What it does |
| --- | --- |
| `Claude Subagents: Show the list of active agents` | Same as clicking the status bar item |
| `Claude Subagents: Refresh` | Forces an immediate rescan |

## Troubleshooting

**It always says 0 agent.** By default only agents whose working directory is inside the current workspace are counted. Turn on `claudeSubagents.showAllProjects` to check whether that filter is what is hiding them.

**Remote agents never appear.** Test the exact command the extension uses: `ssh -o BatchMode=yes <alias> true`. If that prompts for anything or fails, the extension will get nothing.

**Two items in the status bar over Remote-SSH.** Should not happen — the extension declares `"extensionKind": ["ui"]` and only ever runs in the local extension host. If you installed an older build server-side, uninstall it there.

## Privacy

No telemetry, no analytics, no network access — other than the `ssh` calls to hosts you explicitly list. Everything else is local file reads.

## License

MIT
