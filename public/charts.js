/* Tiny dependency-free SVG chart helpers. */
(function () {
  const NS = 'http://www.w3.org/2000/svg';

  function fmtTok(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(Math.round(n));
  }
  function fmtUsd(n) { return '$' + (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3)); }
  window.fmtTok = fmtTok; window.fmtUsd = fmtUsd;

  /** Area/line chart. series: [{date,value}] sorted */
  window.areaChart = function (el, series, { color = '#e0633c', fmt = fmtUsd, h = 220 } = {}) {
    el.innerHTML = '';
    if (!series.length) { el.innerHTML = '<div class="empty">no data yet</div>'; return; }
    const w = el.clientWidth || 560;
    const pad = { l: 46, r: 12, t: 14, b: 26 };
    const max = Math.max(...series.map((d) => d.value)) || 1;
    const X = (i) => pad.l + (i / Math.max(1, series.length - 1)) * (w - pad.l - pad.r);
    const Y = (v) => pad.t + (1 - v / max) * (h - pad.t - pad.b);

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.classList.add('chart');

    // grid + y labels
    for (let g = 0; g <= 3; g++) {
      const v = (max / 3) * g, y = Y(v);
      svg.innerHTML += `<line x1="${pad.l}" y1="${y}" x2="${w - pad.r}" y2="${y}" class="gridline"/>
        <text x="${pad.l - 8}" y="${y + 4}" class="axis" text-anchor="end">${fmt(v)}</text>`;
    }
    // x labels (≈6)
    const step = Math.max(1, Math.floor(series.length / 6));
    series.forEach((d, i) => {
      if (i % step === 0 || i === series.length - 1)
        svg.innerHTML += `<text x="${X(i)}" y="${h - 8}" class="axis" text-anchor="middle">${d.date.slice(5)}</text>`;
    });

    const pts = series.map((d, i) => `${X(i)},${Y(d.value)}`).join(' ');
    const gid = 'g' + Math.random().toString(36).slice(2, 8);
    svg.innerHTML += `
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${color}" stop-opacity=".45"/>
        <stop offset="1" stop-color="${color}" stop-opacity="0"/>
      </linearGradient></defs>
      <polygon points="${pad.l},${Y(0)} ${pts} ${X(series.length - 1)},${Y(0)}" fill="url(#${gid})"/>
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
    series.forEach((d, i) => {
      svg.innerHTML += `<circle cx="${X(i)}" cy="${Y(d.value)}" r="7" fill="transparent" class="hover-pt">
        <title>${d.date} — ${fmt(d.value)}</title></circle>
        <circle cx="${X(i)}" cy="${Y(d.value)}" r="2.4" fill="${color}" pointer-events="none"/>`;
    });
    el.appendChild(svg);
  };

  /** Stacked bar chart. series: [{date, parts:{label:value}}], colors: {label:color} */
  window.stackChart = function (el, series, colors, { fmt = fmtTok, h = 220 } = {}) {
    el.innerHTML = '';
    if (!series.length) { el.innerHTML = '<div class="empty">no data yet</div>'; return; }
    const w = el.clientWidth || 560;
    const pad = { l: 46, r: 12, t: 14, b: 26 };
    const totals = series.map((d) => Object.values(d.parts).reduce((a, b) => a + b, 0));
    const max = Math.max(...totals) || 1;
    const bw = Math.min(26, ((w - pad.l - pad.r) / series.length) * 0.7);
    const X = (i) => pad.l + ((i + 0.5) / series.length) * (w - pad.l - pad.r);
    const Y = (v) => pad.t + (1 - v / max) * (h - pad.t - pad.b);

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.classList.add('chart');
    for (let g = 0; g <= 3; g++) {
      const v = (max / 3) * g, y = Y(v);
      svg.innerHTML += `<line x1="${pad.l}" y1="${y}" x2="${w - pad.r}" y2="${y}" class="gridline"/>
        <text x="${pad.l - 8}" y="${y + 4}" class="axis" text-anchor="end">${fmt(v)}</text>`;
    }
    const step = Math.max(1, Math.floor(series.length / 6));
    series.forEach((d, i) => {
      if (i % step === 0 || i === series.length - 1)
        svg.innerHTML += `<text x="${X(i)}" y="${h - 8}" class="axis" text-anchor="middle">${d.date.slice(5)}</text>`;
      let acc = 0;
      for (const [label, val] of Object.entries(d.parts)) {
        if (!val) continue;
        const y0 = Y(acc), y1 = Y(acc + val);
        svg.innerHTML += `<rect x="${X(i) - bw / 2}" y="${y1}" width="${bw}" height="${Math.max(1, y0 - y1)}" rx="2"
          fill="${colors[label] || '#888'}"><title>${d.date} ${label}: ${fmt(val)}</title></rect>`;
        acc += val;
      }
    });
    el.appendChild(svg);
    // legend
    const leg = document.createElement('div');
    leg.className = 'legend';
    leg.innerHTML = Object.entries(colors).map(([l, c]) => `<span><i style="background:${c}"></i>${l}</span>`).join('');
    el.appendChild(leg);
  };

  /** Donut chart. items: [{label,value,color}] */
  window.donutChart = function (el, items, { fmt = fmtUsd } = {}) {
    el.innerHTML = '';
    const total = items.reduce((a, b) => a + b.value, 0);
    if (!total) { el.innerHTML = '<div class="empty">no data yet</div>'; return; }
    const size = 190, r = 70, cx = size / 2, cy = size / 2, sw = 26;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.classList.add('donut');
    let a0 = -Math.PI / 2;
    for (const it of items) {
      const frac = it.value / total;
      const a1 = a0 + frac * Math.PI * 2;
      const large = frac > 0.5 ? 1 : 0;
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1 - 0.02), y1 = cy + r * Math.sin(a1 - 0.02);
      svg.innerHTML += `<path d="M${x0} ${y0} A${r} ${r} 0 ${large} 1 ${x1} ${y1}" fill="none"
        stroke="${it.color}" stroke-width="${sw}"><title>${it.label}: ${fmt(it.value)} (${(frac * 100).toFixed(1)}%)</title></path>`;
      a0 = a1;
    }
    svg.innerHTML += `<text x="${cx}" y="${cy - 4}" text-anchor="middle" class="donut-total">${fmt(total)}</text>
      <text x="${cx}" y="${cy + 14}" text-anchor="middle" class="donut-sub">total</text>`;
    const wrap = document.createElement('div');
    wrap.className = 'donut-flex';
    wrap.appendChild(svg);
    const leg = document.createElement('div');
    leg.className = 'legend col';
    leg.innerHTML = items.map((it) =>
      `<span><i style="background:${it.color}"></i>${it.label}<b>${fmt(it.value)}</b></span>`).join('');
    wrap.appendChild(leg);
    el.appendChild(wrap);
  };

  /** Horizontal bars. items: [{label,value,sub,color}] */
  window.hbarChart = function (el, items, { fmt = fmtTok } = {}) {
    el.innerHTML = '';
    if (!items.length) { el.innerHTML = '<div class="empty">no data yet</div>'; return; }
    const max = Math.max(...items.map((i) => i.value)) || 1;
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'hbar-row';
      row.innerHTML = `
        <span class="hbar-label" title="${it.label}">${it.label}</span>
        <span class="hbar-track"><i style="width:${(it.value / max) * 100}%;background:${it.color || 'var(--accent)'}"></i></span>
        <span class="hbar-val">${fmt(it.value)}${it.sub ? `<small>${it.sub}</small>` : ''}</span>`;
      el.appendChild(row);
    }
  };
})();
