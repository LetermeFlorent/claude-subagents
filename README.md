# Claude Subagents

Panneau lateral VS Code qui liste les **sous-agents Claude Code** (Task / Agent) que l'extension officielle n'affiche pas : type, description, statut (actif / fini) et duree.

![apercu](icon.png)

## Comment ca marche

Claude Code ecrit chaque sous-agent dans `~/.claude/projects/<projet>/<session>/subagents/` :
- `agent-<id>.meta.json` -> `{ agentType, description, spawnDepth }`
- `agent-<id>.jsonl` -> le transcript (son `mtime` sert a savoir si l'agent est encore actif)

L'extension scanne ce dossier toutes les quelques secondes et affiche les agents recents. Un point **vert** = actif (transcript ecrit il y a moins de 45 s), **gris** = termine.

## Installation

Depuis le `.vsix` (onglet Releases) :

```
code --install-extension claude-subagents-0.1.0.vsix
```

Puis Reload Window. L'icone **Claude Agents** apparait dans la barre d'activite.

> En Remote-SSH, installe l'extension cote serveur (la ou tourne Claude Code) : c'est la que les fichiers des sous-agents sont ecrits.

## Reglages

| Reglage | Defaut | Description |
| --- | --- | --- |
| `claudeSubagents.refreshSeconds` | `3` | Frequence de rafraichissement |
| `claudeSubagents.keepMinutes` | `30` | Anciennete max des agents affiches |

## Licence

MIT
