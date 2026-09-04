(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  let agents = [];

  function fmtDur(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    return m + 'm' + String(s % 60).padStart(2, '0');
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function stateOf(a, now) {
    if (a.remote) return 'remote';
    const idle = Math.max(0, now - a.last);
    if (idle >= 120000) return 'stalled';
    if (idle >= 5000) return 'quiet';
    return '';
  }

  function card(a, now) {
    const state = stateOf(a, now);
    const b = el('button', 'agent' + (state ? ' ' + state : ''));
    b.type = 'button';
    b.dataset.id = a.id;

    const head = el('div', 'head');
    head.appendChild(el('span', 'live'));
    head.appendChild(el('span', 'type', a.type));
    head.appendChild(el('span', 'elapsed', fmtDur(Math.max(0, now - a.started))));
    b.appendChild(head);

    b.appendChild(a.desc
      ? el('div', 'desc', a.desc)
      : el('div', 'desc none', 'sans description'));

    const meta = el('div', 'meta');
    const bits = [];
    if (a.model) bits.push(a.model);
    if (a.effort) bits.push(a.effort);
    if (a.proj) bits.push(a.proj);
    bits.forEach(function (t, i) {
      if (i) meta.appendChild(el('span', 'sep', '·'));
      meta.appendChild(el('span', null, t));
    });
    const idle = Math.max(0, now - a.last);
    if (state === 'quiet' || state === 'stalled') {
      if (bits.length) meta.appendChild(el('span', 'sep', '·'));
      meta.appendChild(el('span', state + '-flag', 'silencieux ' + fmtDur(idle)));
    }
    if (meta.childNodes.length) b.appendChild(meta);

    b.title = a.cwd || '';
    return b;
  }

  function render() {
    const now = Date.now();
    root.textContent = '';

    if (!agents.length) {
      const e = el('div', 'empty');
      e.appendChild(el('div', null, 'Aucun agent actif.'));
      const hint = el('div');
      hint.style.marginTop = '6px';
      hint.textContent = 'Les sous-agents, les agents de workflow et les sessions en arriere-plan apparaissent ici des qu\'ils demarrent.';
      e.appendChild(hint);
      root.appendChild(e);
      return;
    }

    const groups = new Map();
    for (const a of agents) {
      const k = a.session || '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(a);
    }

    const split = groups.size > 1;
    for (const [k, list] of groups) {
      if (split) {
        const h = el('div', 'session');
        h.appendChild(el('span', null, k ? 'Session ' + list[0].sessionLabel : 'Sans session parente'));
        h.appendChild(el('span', 'count', String(list.length)));
        root.appendChild(h);
      }
      for (const a of list) root.appendChild(card(a, now));
    }
  }

  root.addEventListener('click', function (ev) {
    const b = ev.target.closest('.agent');
    if (b) vscode.postMessage({ type: 'open', id: b.dataset.id });
  });

  window.addEventListener('message', function (ev) {
    if (ev.data && ev.data.type === 'agents') {
      agents = ev.data.agents || [];
      render();
    }
  });

  // Les horodatages sont absolus, donc les durees se recalculent ici sans
  // repasser par l'extension ni relire le disque.
  setInterval(render, 1000);
  vscode.postMessage({ type: 'ready' });
}());
