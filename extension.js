const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const ACTIVE_MS = 30000;
const REMOTE_TIMEOUT_MS = 6000;
const REMOTE_INTERVAL_MS = 15000;

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

const MAX_DEPTH = 4;

function collectMetas(dir, proj, now, res, depth) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH) collectMetas(path.join(dir, e.name), proj, now, res, depth + 1);
      continue;
    }
    if (!e.name.endsWith('.meta.json')) continue;
    const f = e.name;
    const id = f.slice(0, -'.meta.json'.length);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) {}
    let started = 0, last = 0;
    try { const st = fs.statSync(path.join(dir, f)); started = st.birthtimeMs || st.ctimeMs || st.mtimeMs; } catch (_) {}
    try { const st = fs.statSync(path.join(dir, id + '.jsonl')); last = st.mtimeMs; } catch (_) {}
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

function scan() {
  const now = Date.now();
  const res = [];
  let projs = [];
  try { projs = fs.readdirSync(PROJECTS); } catch (_) { return res; }
  const allowed = allowedProjectDirs();
  // Pas de dossier de workspace ouvert -> aucun projet ne correspond, jamais de fallback "tout afficher"
  // (sinon fuite d'agents d'un autre projet, cf. bug rapporte).
  projs = projs.filter(function (p) { return allowed.indexOf(p.toLowerCase()) !== -1; });
  for (const proj of projs) {
    const pdir = path.join(PROJECTS, proj);
    let entries = [];
    try { entries = fs.readdirSync(pdir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const session = e.name;
      const sub = path.join(pdir, session, 'subagents');
      collectMetas(sub, proj, now, res, 0);
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

// Script bash execute a distance (via ssh) : liste chaque *.meta.json actif sous
// ~/.claude/projects, avec mtime du .jsonl associe (activite) et contenu JSON brut.
// Un seul appel ssh par host, on parse le JSON cote client (evite le parsing JSON en bash).
const REMOTE_SCRIPT = "for f in $(find ~/.claude/projects -maxdepth 6 -name '*.meta.json' 2>/dev/null); do " +
  "j=\"${f%.meta.json}.jsonl\"; " +
  "l=$(stat -c %Y \"$j\" 2>/dev/null || stat -c %Y \"$f\" 2>/dev/null); " +
  "s=$(stat -c %Y \"$f\" 2>/dev/null); " +
  "printf '===META===\\n%s\\n%s\\n%s\\n' \"$f\" \"$l\" \"$s\"; cat \"$f\"; echo; " +
  "done";

function fetchRemote(host) {
  return new Promise(function (resolve) {
    execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4', host, REMOTE_SCRIPT],
      { timeout: REMOTE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      function (err, stdout) {
        if (err || !stdout) { resolve([]); return; }
        const now = Date.now();
        const blocks = stdout.split('===META===\n').slice(1);
        const res = [];
        for (const block of blocks) {
          const nl1 = block.indexOf('\n');
          const nl2 = block.indexOf('\n', nl1 + 1);
          const nl3 = block.indexOf('\n', nl2 + 1);
          if (nl1 < 0 || nl2 < 0 || nl3 < 0) continue;
          const filePath = block.slice(0, nl1);
          const lastSec = Number(block.slice(nl1 + 1, nl2));
          const startSec = Number(block.slice(nl2 + 1, nl3));
          const jsonText = block.slice(nl3 + 1).trim();
          let meta = {};
          try { meta = JSON.parse(jsonText); } catch (_) { continue; }
          const last = lastSec ? lastSec * 1000 : now;
          const started = startSec ? startSec * 1000 : last;
          if (now - last > ACTIVE_MS) continue;
          const projMatch = /\/projects\/([^/]+)\//.exec(filePath);
          const id = path.basename(filePath, '.meta.json');
          res.push({
            id: host + ':' + id,
            type: meta.agentType || '?',
            desc: meta.description || '',
            proj: host + (projMatch ? ':' + projLabel(projMatch[1]) : ''),
            last: last,
            durLabel: fmtDur(Math.max(0, now - started))
          });
        }
        resolve(res);
      });
  });
}

let remoteAgents = [], remoteTimer;

function scanRemote() {
  const hosts = cfg().get('remoteHosts');
  if (!Array.isArray(hosts) || !hosts.length) { remoteAgents = []; return; }
  Promise.all(hosts.map(fetchRemote)).then(function (lists) {
    remoteAgents = lists.reduce(function (a, b) { return a.concat(b); }, []);
    tick();
  });
}

function scheduledRemote() {
  clearInterval(remoteTimer);
  const hosts = cfg().get('remoteHosts');
  if (!Array.isArray(hosts) || !hosts.length) { remoteAgents = []; return; }
  scanRemote();
  remoteTimer = setInterval(scanRemote, REMOTE_INTERVAL_MS);
}

let item, timer, lastAgents = [], lastText = null, lastTooltip = null;

function tick() {
  lastAgents = scan().concat(remoteAgents).sort(function (a, b) { return b.last - a.last; });
  const n = lastAgents.length;
  const text = n ? '$(sync~spin) ' + n + ' agent' + (n > 1 ? 's' : '') : '$(circle-outline) 0 agent';
  const tooltip = n ? 'Cliquer pour voir la liste des agents actifs' : 'Aucun sous-agent actif';
  if (text === lastText && tooltip === lastTooltip) return;
  lastText = text; lastTooltip = tooltip;
  item.text = text;
  item.tooltip = tooltip;
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
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 110);
  item.name = 'Claude Subagents';
  item.command = 'claudeSubagents.showList';
  item.show();
  context.subscriptions.push(item);
  context.subscriptions.push(vscode.commands.registerCommand('claudeSubagents.refresh', tick));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSubagents.showList', showList));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(function (e) {
    if (e.affectsConfiguration('claudeSubagents')) { scheduled(); scheduledRemote(); }
  }));
  context.subscriptions.push({ dispose: function () { clearInterval(timer); clearInterval(remoteTimer); } });
  tick();
  scheduled();
  scheduledRemote();
}

function deactivate() { clearInterval(timer); clearInterval(remoteTimer); }

module.exports = { activate, deactivate };
