const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ACTIVE_MS = 30000;
const WF_MAX_MS = 900000;
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

const HEAD_BYTES = 262144;
const EMPTY_HEAD = { cwd: null, model: null, effort: null };
const CACHE_MAX = 400;

const headCache = new Map();
const tailCache = new Map();
const wfCache = new Map();

function statOf(p) {
  try { return fs.statSync(p); } catch (_) { return null; }
}

// Les lignes d'un .jsonl s'ajoutent a la fin : une fois les trois champs lus,
// l'en-tete ne bougera plus, et relire 256 Ko a chaque tick ne sert a rien.
function headFields(p, st) {
  const s = st || statOf(p);
  if (!s) return EMPTY_HEAD;
  const c = headCache.get(p);
  if (c && s.size === c.size) return c.fields;
  if (c && s.size > c.size && (c.complete || c.read >= HEAD_BYTES)) return c.fields;
  const fields = readHeadFields(p, HEAD_BYTES);
  headCache.set(p, {
    fields: fields,
    size: s.size,
    read: Math.min(HEAD_BYTES, s.size),
    complete: !!(fields.cwd && fields.model && fields.effort)
  });
  return fields;
}

function tailModelCached(p) {
  const s = statOf(p);
  if (!s) return null;
  const c = tailCache.get(p);
  if (c && c.mtime === s.mtimeMs) return c.model;
  const model = tailModel(p);
  tailCache.set(p, { mtime: s.mtimeMs, model: model });
  return model;
}

function parentCwd(parentJsonl) { return headFields(parentJsonl).cwd; }

function parentModel(parentJsonl) { return tailModelCached(parentJsonl); }

function parentEffort(parentJsonl) { return headFields(parentJsonl).effort; }

function workflowLive(dir) {
  const jp = path.join(dir, 'journal.jsonl');
  const s = statOf(jp);
  if (!s) return null;
  const c = wfCache.get(jp);
  if (c && c.mtime === s.mtimeMs) return c.live;
  let txt = '';
  try { txt = fs.readFileSync(jp, 'utf8'); } catch (_) { return null; }
  const live = {};
  for (const line of txt.split('\n')) {
    if (!line) continue;
    let o = null;
    try { o = JSON.parse(line); } catch (_) { continue; }
    if (!o || typeof o.agentId !== 'string') continue;
    if (o.type === 'started') live[o.agentId] = 1;
    else delete live[o.agentId];
  }
  wfCache.set(jp, { mtime: s.mtimeMs, live: live });
  return live;
}

function pruneCaches() {
  if (headCache.size + tailCache.size + wfCache.size < CACHE_MAX) return;
  const maps = [headCache, tailCache, wfCache];
  for (const m of maps) {
    for (const k of Array.from(m.keys())) {
      if (!fs.existsSync(k)) m.delete(k);
    }
  }
  if (headCache.size + tailCache.size + wfCache.size >= CACHE_MAX) {
    headCache.clear(); tailCache.clear(); wfCache.clear();
  }
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
  const jst = jsonlPath ? statOf(jsonlPath) : null;
  let last = 0, started = 0;
  if (jst) { last = jst.mtimeMs; started = jst.birthtimeMs || jst.ctimeMs || jst.mtimeMs; }
  if (!last && metaPath) {
    const mst = statOf(metaPath);
    if (mst) { last = mst.mtimeMs; started = started || mst.birthtimeMs || mst.ctimeMs || last; }
  }
  if (!last) return;
  if (opt.now - last > ACTIVE_MS) {
    if (opt.now - last > WF_MAX_MS || !opt.wfDir) return;
    const live = workflowLive(opt.wfDir);
    if (!live || !(live[id] || live[id.replace(/^agent-/, '')])) return;
  }
  const head = jst ? headFields(jsonlPath, jst) : EMPTY_HEAD;
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
    session: opt.session || '',
    file: jsonlPath || metaPath || '',
    last: last,
    started: started || last
  });
}

function collectMetas(dir, opt, depth) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  const ids = [], seen = {};
  let hasJournal = false;
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH) collectMetas(full, opt, depth + 1);
      continue;
    }
    if (e.name === 'journal.jsonl') { hasJournal = true; continue; }
    const isMeta = e.name.endsWith('.meta.json');
    const isJson = e.name.indexOf('agent-') === 0 && e.name.endsWith('.jsonl');
    if (!isMeta && !isJson) continue;
    const id = isMeta ? e.name.slice(0, -'.meta.json'.length) : e.name.slice(0, -'.jsonl'.length);
    if (seen[id]) continue;
    seen[id] = 1;
    ids.push(id);
  }
  const dopt = hasJournal ? Object.assign({}, opt, { wfDir: dir }) : opt;
  for (const id of ids) {
    digestAgent(id, path.join(dir, id + '.meta.json'), path.join(dir, id + '.jsonl'), dopt);
  }
}

function scan() {
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
    const seen = {};
    for (const e of entries) {
      if (e.isDirectory()) {
        const opt = {
          proj: proj,
          parentJsonl: path.join(pdir, e.name + '.jsonl'),
          session: e.name,
          now: now,
          res: res
        };
        collectMetas(path.join(pdir, e.name, 'subagents'), opt, 0);
      } else if (e.name.indexOf('agent-') === 0 && (e.name.endsWith('.meta.json') || e.name.endsWith('.jsonl'))) {
        const isMeta = e.name.endsWith('.meta.json');
        const id = isMeta ? e.name.slice(0, -'.meta.json'.length) : e.name.slice(0, -'.jsonl'.length);
        if (seen[id]) continue;
        seen[id] = 1;
        digestAgent(id, path.join(pdir, id + '.meta.json'), path.join(pdir, id + '.jsonl'), {
          proj: proj, parentJsonl: null, session: '', now: now, res: res
        });
      }
    }
  }
  pruneCaches();
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
      session: short,
      file: path.join(JOBS, short, 'timeline.jsonl'),
      last: last,
      started: w.startedAt || now
    });
  }
  return out;
}

const REMOTE_SCRIPT = [
  // stat -c est GNU, stat -f est BSD : un hote macOS ou *BSD ne repond qu'au second.
  'mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }',
  'now=$(date +%s)',
  'find "$HOME/.claude/projects" -maxdepth 6 -name \'*.meta.json\' 2>/dev/null | while IFS= read -r f; do',
  'j="${f%.meta.json}.jsonl"',
  'l=$(mtime "$j")',
  '[ -n "$l" ] || l=$(mtime "$f")',
  '[ -n "$l" ] || continue',
  'a=$((now-l))',
  '[ "$a" -gt ' + Math.floor(WF_MAX_MS / 1000) + ' ] && continue',
  'if [ "$a" -gt ' + Math.floor(ACTIVE_MS / 1000) + ' ]; then',
  'd=$(dirname "$f")',
  '[ -f "$d/journal.jsonl" ] || continue',
  'n=$(basename "$f" .meta.json)',
  'awk -v w="$n" -v w2="${n#agent-}" \'{if(match($0,/"agentId":"[^"]*"/)){i=substr($0,RSTART+11,RLENGTH-12); if($0~/"type":"started"/) L[i]=1; else delete L[i]}} END{exit ((w in L)||(w2 in L))?0:1}\' "$d/journal.jsonl" || continue',
  'fi',
  's=$(mtime "$f")',
  '[ -n "$s" ] || s=$l',
  'm=$(tail -c 65536 "$j" 2>/dev/null | grep \'"type":"assistant"\' | grep -o \'"model":"[^"]*"\' | tail -1 | sed \'s/^"model":"//;s/"$//\')',
  'e=$(head -c 262144 "$j" 2>/dev/null | grep -o \'"effort":"[^"]*"\' | head -1 | sed \'s/^"effort":"//;s/"$//\')',
  'c=$(head -c 262144 "$j" 2>/dev/null | grep -o \'"cwd":"[^"]*"\' | head -1 | sed \'s/^"cwd":"//;s/"$//\')',
  'case "$f" in *"/subagents/"*)',
  'p=$(printf \'%s\' "$f" | sed \'s#/subagents/.*##\').jsonl',
  'if [ -f "$p" ]; then',
  '[ -n "$m" ] || m=$(tail -c 65536 "$p" | grep \'"type":"assistant"\' | grep -o \'"model":"[^"]*"\' | tail -1 | sed \'s/^"model":"//;s/"$//\')',
  '[ -n "$e" ] || e=$(head -c 262144 "$p" | grep -o \'"effort":"[^"]*"\' | head -1 | sed \'s/^"effort":"//;s/"$//\')',
  '[ -n "$c" ] || c=$(head -c 262144 "$p" | grep -o \'"cwd":"[^"]*"\' | head -1 | sed \'s/^"cwd":"//;s/"$//\')',
  'fi',
  ';;',
  'esac',
  'printf \'===AGENT===\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n\' "$f" "$a" "$((now-s))" "$m" "$e" "$c"',
  'cat "$f"',
  'echo',
  'done'
].join('\n');

function fetchRemote(host) {
  return new Promise(function (resolve) {
    execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4', host, REMOTE_SCRIPT],
      { timeout: REMOTE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      function (err, stdout) {
        if (err || !stdout) { resolve([]); return; }
        const now = Date.now();
        const blocks = stdout.split('===AGENT===\n').slice(1);
        const res = [];
        for (const block of blocks) {
          const lines = block.split('\n');
          if (lines.length < 7) continue;
          const filePath = lines[0];
          const ageLast = Math.max(0, Number(lines[1]) || 0);
          const ageStart = Math.max(0, Number(lines[2]) || 0);
          let meta = {};
          try { meta = JSON.parse(lines.slice(6).join('\n').trim()); } catch (_) { continue; }
          const cwd = lines[5];
          const projMatch = /\/projects\/([^/]+)\//.exec(filePath);
          const id = path.basename(filePath, '.meta.json');
          const proj = baseNameOf(cwd) || (projMatch ? projLabel(projMatch[1]) : '');
          const sessMatch = /\/([^/]+)\/subagents\//.exec(filePath);
          res.push({
            id: host + ':' + id,
            type: meta.customAgentType || meta.agentType || '?',
            desc: meta.description || '',
            proj: host + (proj ? ':' + proj : ''),
            cwd: cwd,
            model: meta.model || lines[3] || '',
            effort: meta.effort || lines[4] || '',
            session: sessMatch ? sessMatch[1] : '',
            file: '',
            last: now - ageLast * 1000,
            started: now - ageStart * 1000
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

let item, timer, lastAgents = [], lastText = null, lastSig = null;
let picker = null, pickerTimer = null;

const sessionNum = new Map();

function sessionLabel(session) {
  if (!session) return '';
  if (!sessionNum.has(session)) sessionNum.set(session, sessionNum.size + 1);
  return '#' + sessionNum.get(session);
}

function itemFor(a, now) {
  const model = a.model ? '  @' + a.model : '';
  const effort = a.effort ? '  e:' + a.effort : '';
  const idle = Math.max(0, now - a.last);
  const sess = sessionLabel(a.session);
  return {
    label: '$(sync~spin) ' + a.type + model + effort,
    description: fmtDur(Math.max(0, now - a.started)) + (idle >= 5000 ? '   silencieux ' + fmtDur(idle) : ''),
    detail: (sess ? sess + ' ' : '') + '[' + a.proj + '] ' + (a.desc || '(sans description)'),
    agent: a
  };
}

function buildItems(now) {
  if (!lastAgents.length) {
    return [{ label: '$(circle-outline) Aucun agent actif', alwaysShow: true }];
  }
  const groups = new Map();
  for (const a of lastAgents) {
    const k = a.session || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  const items = [];
  const split = groups.size > 1;
  for (const [k, list] of groups) {
    if (split) {
      items.push({
        label: k ? 'Session ' + sessionLabel(k) + '  ' + String(k).slice(0, 8) : 'Sans session parente',
        kind: vscode.QuickPickItemKind.Separator
      });
    }
    for (const a of list) items.push(itemFor(a, now));
  }
  return items;
}

function placeholderFor() {
  const n = lastAgents.length;
  if (!n) return 'Aucun agent actif';
  const s = n > 1 ? 's' : '';
  return n + ' agent' + s + ' actif' + s + ', Entree pour ouvrir le transcript';
}

function openAgent(a) {
  // La commande est aussi joignable sans argument si elle remonte dans la
  // palette : mieux vaut ne rien faire que jeter.
  if (!a) return;
  if (!a.file) {
    vscode.window.showInformationMessage('Agent distant : aucun transcript en local.');
    return;
  }
  if (!fs.existsSync(a.file)) {
    vscode.window.showWarningMessage('Transcript introuvable : ' + a.file);
    return;
  }
  vscode.workspace.openTextDocument(vscode.Uri.file(a.file)).then(function (doc) {
    vscode.window.showTextDocument(doc, { preview: true });
  });
}

function buildTooltip(now) {
  const n = lastAgents.length;
  if (!n) return 'Aucun agent actif';
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  const s = n > 1 ? 's' : '';
  md.appendMarkdown(n + ' agent' + s + ' actif' + s + '\n\n');
  for (const a of lastAgents.slice(0, 12)) {
    const sess = sessionLabel(a.session);
    const parts = ['$(sync~spin)', a.type];
    if (a.model) parts.push('@' + a.model);
    parts.push(fmtDur(Math.max(0, now - a.started)));
    if (sess) parts.push(sess);
    parts.push('[' + a.proj + ']');
    md.appendMarkdown(parts.join(' ') + '\n\n');
  }
  if (n > 12) md.appendMarkdown('et ' + (n - 12) + ' de plus\n\n');
  md.appendMarkdown('[$(list-unordered) Ouvrir la liste](command:claudeSubagents.showList)');
  return md;
}

function tick() {
  lastAgents = scan().concat(bgAgents()).concat(remoteAgents).sort(function (a, b) { return b.last - a.last; });
  if (!item) return;
  const now = Date.now();
  const n = lastAgents.length;
  const text = n ? '$(sync~spin) ' + n + ' agent' + (n > 1 ? 's' : '') : '$(circle-outline) 0 agent';
  let sig = '';
  for (const a of lastAgents) sig += a.id + ':' + Math.round((now - a.started) / 1000) + '|';
  if (text !== lastText) { item.text = text; lastText = text; }
  if (sig !== lastSig) { item.tooltip = buildTooltip(now); lastSig = sig; }
  refreshPanel();
}

function showList() {
  // Le panneau reste ouvert quand le focus part ailleurs, contrairement au
  // QuickPick : quand il est actif, le compteur y renvoie plutot que de
  // rouvrir une liste qui se refermera au premier clic a cote.
  if (panelMode()) {
    vscode.commands.executeCommand('claudeSubagents.panel.focus');
    return;
  }
  if (!lastAgents.length) {
    vscode.window.showInformationMessage('Aucun agent actif.');
    return;
  }
  if (picker) { picker.show(); return; }
  const qp = vscode.window.createQuickPick();
  picker = qp;
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.placeholder = placeholderFor();
  qp.items = buildItems(Date.now());
  qp.onDidAccept(function () {
    const sel = qp.selectedItems[0];
    qp.hide();
    if (sel && sel.agent) openAgent(sel.agent);
  });
  qp.onDidHide(function () {
    clearInterval(pickerTimer);
    pickerTimer = null;
    picker = null;
    qp.dispose();
    scheduled();
  });
  // Les durees se recalculent sans relire le disque : seul l'ecart a `started` change.
  pickerTimer = setInterval(function () {
    const active = qp.activeItems[0];
    const keep = active && active.agent ? active.agent.id : null;
    qp.placeholder = placeholderFor();
    qp.items = buildItems(Date.now());
    if (keep) {
      const again = qp.items.filter(function (i) { return i.agent && i.agent.id === keep; });
      if (again.length) qp.activeItems = again;
    }
  }, 1000);
  qp.show();
  scheduled();
}

function panelMode() { return String(cfg().get('listStyle') || 'quickPick') === 'panel'; }

function agentPayload(a) {
  return {
    id: a.id,
    type: a.type,
    desc: a.desc,
    model: a.model,
    effort: a.effort,
    proj: a.proj,
    cwd: a.cwd,
    session: a.session,
    sessionLabel: sessionLabel(a.session),
    remote: !a.file,
    started: a.started,
    last: a.last
  };
}

function nonce() {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function panelHtml(webview, extensionUri) {
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'panel.css'));
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'panel.js'));
  const n = nonce();
  const csp = "default-src 'none'; style-src " + webview.cspSource +
    "; script-src 'nonce-" + n + "';";
  return [
    '<!DOCTYPE html>',
    '<html lang="fr">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="' + csp + '">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<link href="' + css + '" rel="stylesheet">',
    '</head>',
    '<body><div id="root"></div>',
    '<script nonce="' + n + '" src="' + js + '"></script>',
    '</body></html>'
  ].join('\n');
}

class PanelProvider {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.view = null;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
    };
    view.webview.html = panelHtml(view.webview, this.extensionUri);
    view.webview.onDidReceiveMessage((msg) => {
      if (!msg) return;
      if (msg.type === 'ready') this.post();
      if (msg.type === 'open') {
        const a = lastAgents.filter(function (x) { return x.id === msg.id; })[0];
        if (a) openAgent(a);
      }
    });
    view.onDidChangeVisibility(() => { if (view.visible) this.post(); });
    this.post();
  }

  post() {
    if (!this.view) return;
    this.view.webview.postMessage({ type: 'agents', agents: lastAgents.map(agentPayload) });
    const n = lastAgents.length;
    // Remettre `badge` a undefined laisse l'ancien chiffre colle sur l'icone
    // (VS Code 1.136). Un badge a zero, lui, ne s'affiche pas du tout.
    this.view.badge = {
      value: n,
      tooltip: n ? n + ' agent' + (n > 1 ? 's' : '') + ' actif' + (n > 1 ? 's' : '') : 'Aucun agent actif'
    };
  }
}

let panel = null;

function refreshPanel() {
  if (panel) panel.post();
}

function baseMs() {
  return Math.max(1, Number(cfg().get('refreshSeconds')) || 3) * 1000;
}

function nextDelay() {
  const ms = baseMs();
  if (picker) return ms;
  const focused = !(vscode.window.state && vscode.window.state.focused === false);
  if (!focused) return ms * Math.max(1, Number(cfg().get('unfocusedMultiplier')) || 1);
  if (!lastAgents.length) return ms * Math.max(1, Number(cfg().get('idleMultiplier')) || 1);
  return ms;
}

function scheduled() {
  clearTimeout(timer);
  timer = setTimeout(function () { tick(); scheduled(); }, nextDelay());
}

function placeItem() {
  if (item) item.dispose();
  const left = String(cfg().get('alignment') || 'right').toLowerCase() === 'left';
  const prio = Number(cfg().get('priority'));
  item = vscode.window.createStatusBarItem(
    left ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right,
    isFinite(prio) ? prio : -1000
  );
  item.name = 'Claude Subagents';
  item.command = 'claudeSubagents.showList';
  item.show();
  lastText = null;
  lastSig = null;
}

function syncPanelContext() {
  vscode.commands.executeCommand('setContext', 'claudeSubagents.panelEnabled', panelMode());
}

function activate(context) {
  placeItem();

  panel = new PanelProvider(context.extensionUri);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('claudeSubagents.panel', panel));
  syncPanelContext();

  context.subscriptions.push(vscode.commands.registerCommand('claudeSubagents.refresh', tick));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSubagents.showList', showList));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSubagents.openAgent', openAgent));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSubagents.openPanel', function () {
    if (!panelMode()) {
      cfg().update('listStyle', 'panel', vscode.ConfigurationTarget.Global).then(function () {
        vscode.commands.executeCommand('claudeSubagents.panel.focus');
      });
      return;
    }
    vscode.commands.executeCommand('claudeSubagents.panel.focus');
  }));
  context.subscriptions.push(vscode.window.onDidChangeWindowState(function () { tick(); scheduled(); }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(function (e) {
    if (!e.affectsConfiguration('claudeSubagents')) return;
    if (e.affectsConfiguration('claudeSubagents.alignment') || e.affectsConfiguration('claudeSubagents.priority')) {
      placeItem();
    }
    if (e.affectsConfiguration('claudeSubagents.listStyle')) syncPanelContext();
    tick();
    scheduled();
    scheduledRemote();
  }));
  context.subscriptions.push({
    dispose: function () {
      clearTimeout(timer);
      clearInterval(remoteTimer);
      clearInterval(pickerTimer);
      if (item) item.dispose();
    }
  });
  tick();
  scheduled();
  scheduledRemote();
}

function deactivate() {
  clearTimeout(timer);
  clearInterval(remoteTimer);
  clearInterval(pickerTimer);
}

module.exports = { activate, deactivate };