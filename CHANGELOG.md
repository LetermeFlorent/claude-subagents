# Changelog

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
