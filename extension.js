const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const ACTIVE_MS = 15000;

function cfg() { return vscode.workspace.getConfiguration('claudeSubagents'); }

function scan() {
  const keepMs = Math.max(1, Number(cfg().get('keepMinutes')) || 30) * 60000;
  const now = Date.now();
  const res = [];
  let projs = [];
  try { projs = fs.readdirSync(PROJECTS); } catch (_) { return res; }
  for (const proj of projs) {
    const pdir = path.join(PROJECTS, proj);
    let sessions = [];
    try { sessions = fs.readdirSync(pdir); } catch (_) { continue; }
    for (const s of sessions) {
      const sub = path.join(pdir, s, 'subagents');
      let files = [];
      try { files = fs.readdirSync(sub); } catch (_) { continue; }
      for (const f of files) {
        if (!f.endsWith('.meta.json')) continue;
        const id = f.slice(0, -'.meta.json'.length);
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(path.join(sub, f), 'utf8')); } catch (_) {}
        let started = 0, last = 0;
        try { const st = fs.statSync(path.join(sub, f)); started = st.birthtimeMs || st.ctimeMs || st.mtimeMs; } catch (_) {}
        try { const st = fs.statSync(path.join(sub, id + '.jsonl')); last = st.mtimeMs; } catch (_) {}
        if (!last) last = started;
        if (now - last > keepMs) continue;
        res.push({
          type: meta.agentType || '?',
          desc: meta.description || '',
          depth: meta.spawnDepth || 0,
          proj: proj,
          active: (now - last) < ACTIVE_MS,
          last: last,
          durLabel: fmtDur(Math.max(0, last - started))
        });
      }
    }
  }
  res.sort(function (a, b) { return (b.active ? 1 : 0) - (a.active ? 1 : 0) || b.last - a.last; });
  return res;
}

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m + 'm' + String(s % 60).padStart(2, '0');
}

let view, timer;

function tick() {
  if (!view) return;
  try { view.webview.postMessage({ type: 'data', agents: scan(), ts: Date.now() }); } catch (_) {}
}

function scheduled() {
  const ms = Math.max(1, Number(cfg().get('refreshSeconds')) || 3) * 1000;
  clearInterval(timer);
  timer = setInterval(tick, ms);
}

function nonce() {
  let t = '';
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 24; i++) t += c[Math.floor(Math.random() * c.length)];
  return t;
}

function html(n) {
  return '<!DOCTYPE html><html><head><meta charset="UTF-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'nonce-' + n + '\';">'
    + '<style>'
    + 'body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:8px 6px;font-size:12px;}'
    + '.head{display:flex;justify-content:space-between;align-items:center;opacity:.7;margin-bottom:10px;font-size:11px;}'
    + '.empty{opacity:.5;font-style:italic;padding:12px 4px;}'
    + '.a{display:flex;gap:8px;padding:7px 4px;border-radius:6px;}'
    + '.a+.a{border-top:1px solid rgba(127,127,127,.14);}'
    + '.dot{flex:none;width:8px;height:8px;border-radius:50%;margin-top:4px;background:#7a7a7a;}'
    + '.dot.on{background:#3fb950;box-shadow:0 0 0 0 rgba(63,185,80,.6);animation:p 1.6s infinite;}'
    + '@keyframes p{0%{box-shadow:0 0 0 0 rgba(63,185,80,.5);}70%{box-shadow:0 0 0 6px rgba(63,185,80,0);}100%{box-shadow:0 0 0 0 rgba(63,185,80,0);}}'
    + '.b{min-width:0;flex:1;}'
    + '.t{display:flex;justify-content:space-between;gap:6px;}'
    + '.type{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'
    + '.meta{opacity:.55;font-size:10px;white-space:nowrap;}'
    + '.d{opacity:.75;font-size:11px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}'
    + '</style></head><body>'
    + '<div class="head"><span>SOUS-AGENTS</span><span id="cnt"></span></div>'
    + '<div id="list"></div>'
    + '<script nonce="' + n + '">'
    + 'var esc=function(s){return String(s).replace(/[&<>]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c];});};'
    + 'window.addEventListener("message",function(e){var m=e.data;if(!m||m.type!=="data")return;'
    + 'var act=m.agents.filter(function(a){return a.active;}).length;'
    + 'document.getElementById("cnt").textContent=act+" actif"+(act>1?"s":"")+" / "+m.agents.length;'
    + 'var L=document.getElementById("list");'
    + 'if(!m.agents.length){L.innerHTML="<div class=\\"empty\\">Aucun sous-agent recent.</div>";return;}'
    + 'L.innerHTML=m.agents.map(function(a){'
    + 'return "<div class=\\"a\\"><div class=\\"dot "+(a.active?"on":"")+"\\"></div><div class=\\"b\\">"'
    + '+"<div class=\\"t\\"><span class=\\"type\\">"+esc(a.type)+"</span><span class=\\"meta\\">"+(a.active?"actif":"fini")+" "+esc(a.durLabel)+"</span></div>"'
    + '+"<div class=\\"d\\">"+esc(a.desc||"(sans description)")+"</div>"'
    + '+"</div></div>";}).join("");'
    + '});'
    + '</script></body></html>';
}

const provider = {
  resolveWebviewView(v) {
    view = v;
    v.webview.options = { enableScripts: true };
    v.webview.html = html(nonce());
    v.onDidDispose(function () { view = null; });
    tick();
  }
};

function activate(context) {
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('claudeSubagents.view', provider));
  context.subscriptions.push(vscode.commands.registerCommand('claudeSubagents.refresh', tick));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(function (e) {
    if (e.affectsConfiguration('claudeSubagents')) scheduled();
  }));
  context.subscriptions.push({ dispose: function () { clearInterval(timer); } });
  scheduled();
}

function deactivate() { clearInterval(timer); }

module.exports = { activate, deactivate };
