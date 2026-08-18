# Changelog

## 0.4.3 — 2026-08-18

- Fixed: model and effort were missing for agents fetched from SSH hosts.

## 0.4.2 — 2026-08-14

- Fixed: workflow agents were almost never counted. A thinking agent writes nothing for minutes, so the mtime check declared it dead — the run journal is now authoritative, capped at 15 minutes.
- Fixed: every agent was counted twice, once from its `.meta.json` and once from its `.jsonl`.

## 0.4.1 — 2026-08-10

- Added: reasoning effort next to the model in the agent list.
- Changed: the list shows the working directory's name instead of its full path.

## 0.4.0 — 2026-08-10

- Added: background sessions (`claude agents`, `claude --bg`) are counted alongside subagents.
- Added: model and real working directory for every agent.
- Added: `showBackground` and `showAllProjects` settings.

## 0.3.0 — 2026-07-23

- Added: remote agents over SSH via `claudeSubagents.remoteHosts`.
- Added: strict workspace filtering — only agents whose working directory is inside the current workspace.
- Changed: generic recursive scan (depth 4) instead of a hardcoded `workflows/` path.
- Fixed: agents spawned through `Workflow` were not counted at all.
- Fixed: duplicate status bar item over Remote-SSH — the extension now declares `"extensionKind": ["ui"]` and its priority no longer loses to overflow.

## 0.2.0 — 2026-07-22

- Changed: the side panel became a status bar item, with the full roster one click away in a QuickPick.

## 0.1.0 — 2026-07-22

- Initial release: a side panel listing active Claude Code subagents.
