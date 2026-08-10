const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ACTIVE_MS = 30000;
const BG_ALIVE_MS = 60000;
const REMOTE_TIMEOUT_MS = 6000;
const REMOTE_INTERVAL_MS = 15000;

function claudeHome() { return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'); }
function projectsBase() { return process.env.CLAUDE_PROJECTS_DIR || path.join(claudeHome(), 'projects'); }
const JOBS = path.join(claudeHome(), 'jobs');
const DAEMON = path.join(claudeHome(), 'daemon', 'roster.json');

function cfg() { return vscode.workspace.getConfiguration('claudeSubagents'); }

function projLabel(p) {
  const parts = p.split('-').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

function encodePath(p) { return p.replace(/[^a-zA-Z0-9]/g, '-'); }

function baseNameOf(p) {
  if (!p) return '';
  const s = String(p).replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

function inWorkspace(cwd) {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) return false;
  const c = path.normalize(String(cwd || ''));
  if (!c) return false;
  for (const f of folders) {
    const w = path.normalize(f.uri.fsPath);
    if (c === w || c.startsWith(w + path.sep)) return true;
  }
  return false;
}

function workspaceEncodedStems() {
  const folders = vscode.workspace.workspaceFolders || [];
  const stems = [];
  for (const f of folders) {
    let c = path.normalize(f.uri.fsPath);
    for (;;) {
      stems.push(encodePath(c).toLowerCase());
      const parent = path.dirname(c);
      if (parent === c || parent === '/' || parent.endsWith(':' + path.sep)) break;
      c = parent;
    }
  }
  return stems;
}

const MAX_DEPTH = 4;

function readHeadFields(p, maxBytes) {
  let buf = '';
  try {
    const fd = fs.openSync(p, 'r');
    const sz = fs.fstatSync(fd).size;
    const b = Buffer.allocUnsafe(Math.min(maxBytes, sz));
    fs.readSync(fd, b, 0, b.length, 0);
    fs.closeSync(fd);
    buf = b.toString('utf8');
  } catch (_) { return { cwd: null, model: null, effort: null }; }
  let cwd = null, model = null, effort = null;
  for (const line of buf.split('\n')) {
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (cwd === null && typeof o.cwd === 'string' && o.cwd) cwd = o.cwd;
      if (effort === null && typeof o.effort === 'string' && o.effort) effort = o.effort;
      if (model === null) {
        if (o.type === 'assistant' && o.message && typeof o.message.model === 'string' && o.message.model) model = o.message.model;
        else if (typeof o.model === 'string' && o.model) model = o.model;
      }
      if (cwd && model && effort) break;
    } catch (_) {}
  }
  return { cwd: cwd, model: model, effort: effort };
}

function tailModel(p) {
  try {
    const fd = fs.openSync(p, 'r');
    const sz = fs.fstatSync(fd).size;
    const chunk = Math.min(65536, sz);
    const b = Buffer.allocUnsafe(chunk);
    fs.readSync(fd, b, 0, chunk, sz - chunk);
    fs.closeSync(fd);
    const lines = b.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const o = JSON.parse(line);
        if (o.type === 'assistant' && o.message && typeof o.message.model === 'string' && o.message.model) return o.message.model;
        if (o.type === 'assistant' && typeof o.model === 'string' && o.model) return o.model;
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

let memo = {};

function memoGet(key, fn) {
  if (!(key in memo)) memo[key] = fn();
  return memo[key];
}

function parentCwd(parentJsonl) {
  return memoGet('c:' + parentJsonl, function () { return readHeadFields(parentJsonl, 262144).cwd; });
}

function parentModel(parentJsonl) {
  return memoGet('m:' + parentJsonl, function () { return tailModel(parentJsonl); });
}

function parentEffort(parentJsonl) {
  return memoGet('e:' + parentJsonl, function () { return readHeadFields(parentJsonl, 262144).effort; });
}

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m + 'm' + String(s % 60).padStart(2, '0');
}

function digestAgent(id, metaPath, jsonlPath, opt) {
  let meta = {};
  if (metaPath) {
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) {}
  }
  let last = 0, started = 0;
  if (jsonlPath) {
    try { last = fs.statSync(jsonlPath).mtimeMs; } catch (_) {}
    try { started = fs.statSync(jsonlPath).birthtimeMs || fs.statSync(jsonlPath).ctimeMs || last; } catch (_) {}
  }
  if (!last && metaPath) {
    try { last = fs.statSync(metaPath).mtimeMs; } catch (_) {}
  }
  if (!last) return;
  if (opt.now - last > ACTIVE_MS) return;
  const head = jsonlPath ? readHeadFields(jsonlPath, 262144) : { cwd: null, model: null };
  let cwd = head.cwd || '';
  if (opt.parentJsonl) cwd = cwd || (parentCwd(opt.parentJsonl) || '');
  let model = meta.model || head.model || '';
  if (!model && opt.parentJsonl) model = parentModel(opt.parentJsonl) || '';
  let effort = meta.effort || head.effort || '';
  if (!effort && opt.parentJsonl) effort = parentEffort(opt.parentJsonl) || '';
  opt.res.push({
    id: id,
    type: meta.customAgentType || meta.agentType || '?',
    desc: meta.description || '',
    proj: baseNameOf(cwd) || projLabel(opt.proj),
    cwd: cwd,
    model: model,
    effort: effort,
    last: last,
    durLabel: fmtDur(Math.max(0, opt.now - started))
  });
}

function collectMetas(dir, opt, depth) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH) collectMetas(full, opt, depth + 1);
      continue;
    }
    const isMeta = e.name.endsWith('.meta.json');
    const isJson = e.name.indexOf('agent-') === 0 && e.name.endsWith('.jsonl');
    if (!isMeta && !isJson) continue;
    const id = isMeta ? e.name.slice(0, -'.meta.json'.length) : e.name.slice(0, -'.jsonl'.length);
    digestAgent(id, path.join(dir, id + '.meta.json'), path.join(dir, id + '.jsonl'), opt);
  }
}

function scan() {
  memo = {};
  const now = Date.now();
  const res = [];
  let projs = [];
  try { projs = fs.readdirSync(projectsBase()); } catch (_) { return res; }
  const showAll = cfg().get('showAllProjects');
  if (!showAll) {
    const stems = workspaceEncodedStems();
    projs = projs.filter(function (p) { return stems.indexOf(p.toLowerCase()) !== -1; });
  }
  for (const proj of projs) {
    const pdir = path.join(projectsBase(), proj);
    let entries = [];
    try { entries = fs.readdirSync(pdir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (e.isDirectory()) {
        const opt = {
          proj: proj,
          parentJsonl: path.join(pdir, e.name + '.jsonl'),
          now: now,
          res: res
        };
        collectMetas(path.join(pdir, e.name, 'subagents'), opt, 0);
      } else if (e.name.indexOf('agent-') === 0 && (e.name.endsWith('.meta.json') || e.name.endsWith('.jsonl'))) {
        const isMeta = e.name.endsWith('.meta.json');
        const id = isMeta ? e.name.slice(0, -'.meta.json'.length) : e.name.slice(0, -'.jsonl'.length);
        digestAgent(id, path.join(pdir, id + '.meta.json'), path.join(pdir, id + '.jsonl'), {
          proj: proj, parentJsonl: null, now: now, res: res
        });
      }
    }
  }
  res.sort(function (a, b) { return b.last - a.last; });
  return res;
}

function bgFlags(st) {
  const out = { model: '', effort: '' };
  if (!st || !Array.isArray(st.respawnFlags)) return out;
  for (let i = 0; i < st.respawnFlags.length - 1; i++) {
    if (st.respawnFlags[i] === '--model' && st.respawnFlags[i + 1]) out.model = st.respawnFlags[i + 1];
    if (st.respawnFlags[i] === '--effort' && st.respawnFlags[i + 1]) out.effort = st.respawnFlags[i + 1];
  }
  return out;
}

function bgAgents() {
  if (cfg().get('showBackground') === false) return [];
  const out = [];
  let roster = {};
  try { roster = JSON.parse(fs.readFileSync(DAEMON, 'utf8')); } catch (_) { return out; }
  const workers = (roster && roster.workers) || {};
  const showAll = cfg().get('showAllProjects');
  const now = Date.now();
  for (const short in workers) {
    const w = workers[short] || {};
    if (!w.sessionId) continue;
    const stPath = path.join(JOBS, short, 'state.json');
    let st = null;
    try { st = JSON.parse(fs.readFileSync(stPath, 'utf8')); } catch (_) {}
    let last = 0;
    try { last = fs.statSync(path.join(JOBS, short, 'timeline.jsonl')).mtimeMs; } catch (_) {}
    if (!last) last = w.startedAt || now;
    const tempo = st && st.tempo;
    const alive = (w.pid > 0) || (tempo && tempo !== 'idle') || (now - last < BG_ALIVE_MS);
    if (!alive) continue;
    const cwd = String(w.cwd || (st && st.cwd) || '');
    if (!showAll && !inWorkspace(cwd)) continue;
    const detail = st ? (st.detail || st.intent || '') : '';
    const flags = bgFlags(st);
    out.push({
      id: short + ':' + (st && st.state ? st.state : 'bg'),
      type: (st && st.template === 'bg') ? 'bg' : 'session',
      desc: String(detail).slice(0, 160),
      proj: baseNameOf(cwd),
      cwd: cwd,
      model: flags.model,
      effort: flags.effort,
      last: last,
      durLabel: fmtDur(Math.max(0, now - (w.startedAt || now)))
    });
  }
  return out;
}

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
            type: meta.customAgentType || meta.agentType || '?',
            desc: meta.description || '',
            proj: host + (projMatch ? ':' + projLabel(projMatch[1]) : ''),
            cwd: '',
            model: meta.model || '',
            effort: meta.effort || '',
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
  lastAgents = scan().concat(bgAgents()).concat(remoteAgents).sort(function (a, b) { return b.last - a.last; });
  const n = lastAgents.length;
  const text = n ? '$(sync~spin) ' + n + ' agent' + (n > 1 ? 's' : '') : '$(circle-outline) 0 agent';
  const tooltip = n ? 'Cliquer pour voir la liste des agents actifs' : 'Aucun agent actif';
  if (text === lastText && tooltip === lastTooltip) return;
  lastText = text; lastTooltip = tooltip;
  item.text = text;
  item.tooltip = tooltip;
}

async function showList() {
  if (!lastAgents.length) {
    vscode.window.showInformationMessage('Aucun agent actif.');
    return;
  }
  const items = lastAgents.map(function (a) {
    const model = a.model ? '  @' + a.model : '';
    const effort = a.effort ? '  e:' + a.effort : '';
    return {
      label: '$(sync~spin) ' + a.type + model + effort,
      description: a.durLabel,
      detail: '[' + a.proj + '] ' + (a.desc || '(sans description)')
    };
  });
  await vscode.window.showQuickPick(items, {
    placeHolder: lastAgents.length + ' agent' + (lastAgents.length > 1 ? 's' : '') + ' actif' + (lastAgents.length > 1 ? 's' : ''),
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
  context.subscriptions.push(vscode.window.onDidChangeWindowState(function () { tick(); }));
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