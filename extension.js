const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const ACTIVE_MS = 30000;

function cfg() { return vscode.workspace.getConfiguration('claudeSubagents'); }

function projLabel(p) {
  const parts = p.split('-').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

function encodePath(p) { return p.replace(/[^a-zA-Z0-9]/g, '-'); }

function allowedProjectDirs() {
  const folders = vscode.workspace.workspaceFolders || [];
  return folders.map(function (f) { return encodePath(f.uri.fsPath).toLowerCase(); });
}

function scan() {
  const now = Date.now();
  const res = [];
  let projs = [];
  try { projs = fs.readdirSync(PROJECTS); } catch (_) { return res; }
  const allowed = allowedProjectDirs();
  if (allowed.length) projs = projs.filter(function (p) { return allowed.indexOf(p.toLowerCase()) !== -1; });
  for (const proj of projs) {
    const pdir = path.join(PROJECTS, proj);
    let entries = [];
    try { entries = fs.readdirSync(pdir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const session = e.name;
      const sub = path.join(pdir, session, 'subagents');
      let files = [];
      try { files = fs.readdirSync(sub); } catch (_) { continue; }
      const metas = files.filter(function (f) { return f.endsWith('.meta.json'); });
      if (!metas.length) continue;
      for (const f of metas) {
        const id = f.slice(0, -'.meta.json'.length);
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(path.join(sub, f), 'utf8')); } catch (_) {}
        let started = 0, last = 0;
        try { const st = fs.statSync(path.join(sub, f)); started = st.birthtimeMs || st.ctimeMs || st.mtimeMs; } catch (_) {}
        try { const st = fs.statSync(path.join(sub, id + '.jsonl')); last = st.mtimeMs; } catch (_) {}
        if (!last) last = started;
        if (now - last > ACTIVE_MS) continue;
        res.push({
          id: id,
          type: meta.agentType || '?',
          desc: meta.description || '',
          proj: projLabel(proj),
          last: last,
          durLabel: fmtDur(Math.max(0, now - started))
        });
      }
    }
  }
  res.sort(function (a, b) { return b.last - a.last; });
  return res;
}

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m + 'm' + String(s % 60).padStart(2, '0');
}

let item, timer, lastAgents = [];

function tick() {
  lastAgents = scan();
  const n = lastAgents.length;
  item.text = n ? '$(sync~spin) ' + n + ' agent' + (n > 1 ? 's' : '') : '$(circle-outline) 0 agent';
  item.tooltip = n ? 'Cliquer pour voir la liste des agents actifs' : 'Aucun sous-agent actif';
  item.show();
}

async function showList() {
  if (!lastAgents.length) {
    vscode.window.showInformationMessage('Aucun sous-agent actif.');
    return;
  }
  const items = lastAgents.map(function (a) {
    return {
      label: '$(sync~spin) ' + a.type,
      description: a.durLabel,
      detail: '[' + a.proj + '] ' + (a.desc || '(sans description)')
    };
  });
  await vscode.window.showQuickPick(items, {
    placeHolder: lastAgents.length + ' sous-agent' + (lastAgents.length > 1 ? 's' : '') + ' actif' + (lastAgents.length > 1 ? 's' : ''),
    matchOnDescription: true,
    matchOnDetail: true
  });
}

function scheduled() {
  const ms = Math.max(1, Number(cfg().get('refreshSeconds')) || 3) * 1000;
  clearInterval(timer);
  timer = setInterval(tick, ms);
}

function activate(context) {
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  item.name = 'Claude Subagents';
  item.command = 'claudeSubagents.showList';
  context.subscriptions.push(item);
  context.subscriptions.push(vscode.commands.registerCommand('claudeSubagents.refresh', tick));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSubagents.showList', showList));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(function (e) {
    if (e.affectsConfiguration('claudeSubagents')) scheduled();
  }));
  context.subscriptions.push({ dispose: function () { clearInterval(timer); } });
  tick();
  scheduled();
}

function deactivate() { clearInterval(timer); }

module.exports = { activate, deactivate };
