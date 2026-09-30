(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  const cards = new Map();

  const ARC = 'M21.72 78.28 A40 40 0 1 1 78.28 78.28';
  const gaugeHtml = (key, label) =>
    `<div class="gauge" data-k="${key}"><div class="lbl">${label}</div>
     <svg viewBox="0 0 100 100"><path class="track" d="${ARC}" pathLength="100"/>
     <path class="fill" d="${ARC}" pathLength="100" stroke-dasharray="0 100"/>
     <text x="50" y="58">–</text></svg><div class="sub">&nbsp;</div></div>`;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function makeCard(s) {
    const el = document.createElement('div');
    el.className = 'card offline';
    el.innerHTML = `
      <div class="head"><span class="dot"></span>
        <div class="title"><div class="name">${esc(s.name)}</div><div class="meta">connecting…</div></div>
        <div class="icons"><button data-a="terminal" title="Open terminal">&gt;_</button>${s.removable ? '<button data-a="remove" title="Remove">✕</button>' : ''}</div>
      </div><div class="err" hidden></div>
      <div class="body">
        <div class="gauges">${gaugeHtml('cpu', 'CPU')}${gaugeHtml('mem', 'Mem')}${gaugeHtml('load', 'Load')}${gaugeHtml('disk', 'Disk')}</div>
        <div class="foot">
          <div data-f="rx"><b>–</b><span>↓ –</span></div>
          <div data-f="tx"><b>–</b><span>↑ –</span></div>
          <div data-f="io"><b>–</b><span>disk –</span></div>
        </div></div>`;
    el.addEventListener('click', (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (a) vscode.postMessage({ type: a, id: s.id });
    });
    return el;
  }

  function sync(servers) {
    const ids = new Set(servers.map((s) => s.id));
    for (const [id, el] of cards) if (!ids.has(id)) { el.remove(); cards.delete(id); }
    for (const s of servers) {
      let el = cards.get(s.id);
      if (!el) { el = makeCard(s); cards.set(s.id, el); }
      else el.querySelector('.name').textContent = s.name;
      root.appendChild(el); // keeps config order
    }
    root.querySelector('.empty')?.remove();
    if (!servers.length) {
      const d = document.createElement('div');
      d.className = 'empty';
      d.innerHTML = 'No servers found in ~/.ssh/config.<br><button class="add" data-a="add">Add server</button> <button class="add" data-a="openConfig">Open ssh config</button>';
      d.querySelectorAll('button').forEach((b) => (b.onclick = () => vscode.postMessage({ type: b.dataset.a })));
      root.appendChild(d);
    }
  }

  const color = (p) => (p < 60 ? 'var(--ok)' : p < 85 ? 'var(--warn)' : 'var(--bad)');
  function setGauge(el, key, pct, text, sub) {
    const g = el.querySelector(`[data-k="${key}"]`);
    const p = Math.max(0, Math.min(100, pct));
    const fill = g.querySelector('.fill');
    fill.setAttribute('stroke-dasharray', `${p} 100`);
    fill.style.stroke = color(p);
    g.querySelector('text').textContent = text;
    g.querySelector('.sub').textContent = sub;
  }

  const size = (b) => {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return `${b >= 100 || i === 0 ? b.toFixed(0) : b.toFixed(b >= 10 ? 1 : 2)} ${u[i]}`;
  };
  const uptime = (s) => {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  };
  const num = (n) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));

  function update(m) {
    const el = cards.get(m.id);
    if (!el) return;
    const { status, stats } = m;
    el.classList.toggle('online', status.state === 'online');
    el.classList.toggle('error', status.state === 'error');
    el.classList.toggle('offline', status.state !== 'online');
    const err = el.querySelector('.err');
    err.hidden = status.state !== 'error';
    err.textContent = status.error || '';

    const meta = el.querySelector('.meta');
    if (status.state === 'connecting' && !stats) meta.textContent = 'connecting…';
    else if (!stats) meta.textContent = 'offline';
    else meta.textContent = [stats.os, `up ${uptime(stats.uptime)}`, status.latency != null ? `${status.latency} ms` : null].filter(Boolean).join(' · ');
    if (!stats) return;

    setGauge(el, 'cpu', stats.cpu, Math.round(stats.cpu) + '%', `${stats.cores} Core`);
    setGauge(el, 'mem', stats.memPct, Math.round(stats.memPct) + '%', size(stats.memTotal));
    setGauge(el, 'load', (stats.load[0] / stats.cores) * 100, stats.load[0].toFixed(2), `${stats.load[1].toFixed(2)} · ${stats.load[2].toFixed(2)}`);
    setGauge(el, 'disk', stats.diskPct, Math.round(stats.diskPct) + '%', size(stats.diskTotal));

    const r = stats.rates;
    const set = (f, big, small) => {
      const d = el.querySelector(`[data-f="${f}"]`);
      d.querySelector('b').textContent = big;
      d.querySelector('span').textContent = small;
    };
    if (r) {
      set('rx', size(r.rx) + '/s', `↓ ${num(r.rxPk)} pkts/s`);
      set('tx', size(r.tx) + '/s', `↑ ${num(r.txPk)} pkts/s`);
      set('io', size(r.ioBps) + '/s', `${num(r.iops)} IOPS`);
    }
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'servers') sync(m.servers);
    else if (m.type === 'update') update(m);
  });
  vscode.postMessage({ type: 'ready' });
})();
