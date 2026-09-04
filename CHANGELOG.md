# Changelog

## 0.6.2 - 2026-09-04

- Fixed: the activity bar badge kept the previous count once the last agent
  stopped, showing 1 or 3 next to an empty panel. Clearing it with `undefined`
  leaves the old number stuck on the icon, so the count is now written as zero,
  which VS Code hides on its own.
- The panel is titled `Claude Agents` rather than `Claude Agents: Agents
  actifs`, and its refresh button reads `Rafraichir` instead of repeating the
  extension name. Commands keep their `Claude Subagents` prefix in the palette,
  where it is what makes them findable.

## 0.6.1 - 2026-09-04

The panel is a proper view now, not a tree. Each agent reads on three lines,
what it is with its elapsed time, what it was asked to do, then model, effort
and project, with a rail down the left whose colour tracks whether output is
still coming: green while it moves, yellow past five seconds of silence, orange
past two minutes, blue for a remote agent. Measured values are set in the editor
font and prose in the interface font. Every colour comes from the current theme,
so it follows light and dark without a second palette.

`showPanel` becomes `claudeSubagents.listStyle`, a choice between `quickPick`
and `panel` rather than a checkbox, since it selects between two displays
instead of switching something on.

## 0.6.0 - 2026-09-04

Optional side panel, off by default: the agent list can live in its own activity
bar view, which stays open when focus goes elsewhere instead of vanishing like
the quick pick did.

## 0.5.1 - 2026-09-04

- Fixed: when the last agent stopped while the list was open, the list went blank instead of saying so.
- Fixed: the SSH scan used `stat -c`, which only GNU coreutils understands, so a macOS or BSD host returned nothing. It now falls back to `stat -f`.

## 0.5.0 - 2026-09-04

- Fixed: elapsed times were frozen while the list was open. The list is now a live quick pick that recomputes durations every second, without touching the disk.
- Added: agents are grouped by the Claude session that spawned them, so three sessions running in one project no longer blend into a single list.
- Added: pressing Enter on an agent opens its transcript.
- Added: time since the agent last wrote anything, shown next to its total duration. The activity cutoff is 30 s, so the list used to mix working agents with ones that had just stopped.
- Added: `alignment` and `priority` settings to move the counter anywhere in the status bar. It now defaults to the far right.
- Added: `idleMultiplier` and `unfocusedMultiplier` to slow the scan down when nothing is running or the window sits in the background.
- Changed: transcript headers are cached between scans. Twenty scans with three agents used to mean 100 file opens and 9.96 MB read; they now read nothing at all.
- Changed: the status bar tooltip lists the agents directly, with their model, duration, session and project.
- Fixed: `digestAgent` called `statSync` two or three times per agent per scan, on the same file.

## 0.4.3 - 2026-08-18

- Fixed: model and effort were missing for agents fetched from SSH hosts.

## 0.4.2 - 2026-08-14

- Fixed: workflow agents were almost never counted. A thinking agent writes nothing for minutes, so the mtime check declared it dead. The run journal is now authoritative, capped at 15 minutes.
- Fixed: every agent was counted twice, once from its `.meta.json` and once from its `.jsonl`.

## 0.4.1 - 2026-08-10

- Added: reasoning effort next to the model in the agent list.
- Changed: the list shows the working directory's name instead of its full path.

## 0.4.0 - 2026-08-10

- Added: background sessions (`claude agents`, `claude --bg`) are counted alongside subagents.
- Added: model and real working directory for every agent.
- Added: `showBackground` and `showAllProjects` settings.

## 0.3.0 - 2026-07-23

- Added: remote agents over SSH via `claudeSubagents.remoteHosts`.
- Added: strict workspace filtering, keeping only agents whose working directory is inside the current workspace.
- Changed: generic recursive scan (depth 4) instead of a hardcoded `workflows/` path.
- Fixed: agents spawned through `Workflow` were not counted at all.
- Fixed: duplicate status bar item over Remote-SSH. The extension now declares `"extensionKind": ["ui"]` and its priority no longer loses to overflow.

## 0.2.0 - 2026-07-22

- Changed: the side panel became a status bar item, with the full roster one click away in a QuickPick.

## 0.1.0 - 2026-07-22

- Initial release: a side panel listing active Claude Code subagents.
