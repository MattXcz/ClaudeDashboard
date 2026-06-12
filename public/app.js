/* Claude Dashboard — frontend logic */
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const api = (p) => fetch(p).then((r) => r.json());
  const ago = (ts) => {
    if (!ts) return '—';
    const d = Date.now() - ts;
    if (d < 60e3) return Math.max(1, Math.round(d / 1e3)) + 's ago';
    if (d < 3600e3) return Math.round(d / 60e3) + 'm ago';
    if (d < 86400e3) return Math.round(d / 3600e3) + 'h ago';
    return Math.round(d / 86400e3) + 'd ago';
  };
  const hhmm = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const shortModel = (m) => (m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
  const MODEL_COLORS = ['#e0633c', '#6aa6ff', '#b48cf2', '#5fbf77', '#e8c265', '#63c8e0', '#e063a8'];
  const modelColor = (() => { const map = {}; let i = 0; return (m) => (map[m] ??= MODEL_COLORS[i++ % MODEL_COLORS.length]); })();

  /* ───────── boot ───────── */
  $('#logo-slot').innerHTML = LOGO(22);
  $('#big-logo-slot').innerHTML = LOGO(56);
  mountIcons();

  /* ───────── router ───────── */
  const loaded = {};
  window.go = function (view, arg) {
    $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
    if (view === 'feed') { feedUnseen = 0; updateFeedBadge(); }
    const loader = LOADERS[view];
    if (loader && (!loaded[view] || arg !== undefined)) { loader(arg); loaded[view] = true; }
  };
  $$('.nav-btn').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));

  /* ───────── header status ───────── */
  async function refreshHeader() {
    try {
      const s = await api('/api/stats');
      window.__stats = s;
      const a = s.blocks && s.blocks.active;
      if (a) {
        const frac = Math.min(1, (Date.now() - a.start) / (a.end - a.start));
        $('#ring-fg').style.strokeDashoffset = 94.2 * (1 - frac);
        $('#block-cost').textContent = fmtUsd(a.cost);
        const mins = Math.max(0, Math.round((a.end - Date.now()) / 60e3));
        $('#block-time').textContent = `${Math.floor(mins / 60)}h ${mins % 60}m left`;
      } else {
        $('#ring-fg').style.strokeDashoffset = 94.2;
        $('#block-cost').textContent = '$0.00';
        $('#block-time').textContent = 'no active block';
      }
      renderSideNow(s);
    } catch { /* server gone */ }
  }
  refreshHeader();
  setInterval(refreshHeader, 15000);

  /* ───────── chat side panel ───────── */
  function renderSideNow(s) {
    const el = $('#side-now');
    if (!el) return;
    const t = s.totals || {};
    const stats = [
      ['sessions', s.sessions ?? 0],
      ['active now', s.activeSessions ?? 0],
      ['total cost', fmtUsd(t.cost || 0)],
      ['today', s.today ? fmtUsd(s.today.cost) : '$0.00'],
      ['tokens out', fmtTok(t.output || 0)],
      ['tool calls', fmtTok(s.toolCalls || 0)],
      ['sub-agents', s.agents || 0],
      ['burn rate', s.blocks && s.blocks.active ? fmtTok(Math.round(s.blocks.burnRate)) + '/min' : '—'],
    ];
    el.innerHTML = stats.map(([l, v]) => `<div class="side-stat"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');
  }

  async function refreshSideSessions() {
    const el = $('#side-sessions');
    if (!el) return;
    try {
      const list = await api('/api/sessions');
      el.innerHTML = list.slice(0, 12).map((s) => `
        <div class="sess-item" onclick="openSession('${s.id}')">
          <div class="t">${s.active ? '<span class="dot-active">●</span> ' : ''}${esc(s.title)}</div>
          <div class="m"><span>${esc(s.projectName)}</span><span>${ago(s.lastTs)}</span><span>${fmtUsd(s.cost)}</span></div>
        </div>`).join('') || '<div class="empty">no sessions yet</div>';
    } catch { /* */ }
  }
  refreshSideSessions();
  setInterval(refreshSideSessions, 20000);

  /* ───────── CHAT ───────── */
  let chatSessionId = null;
  let chatBusy = false;
  const input = $('#chat-input');
  const msgs = $('#chat-msgs');

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(160, input.scrollHeight) + 'px';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  $('#chat-send').addEventListener('click', sendChat);
  $('#chat-new').addEventListener('click', () => {
    chatSessionId = null;
    msgs.innerHTML = '';
    $('#chat-empty').style.display = '';
  });
  $$('.sugg').forEach((b) => b.addEventListener('click', () => { input.value = b.dataset.sugg; sendChat(); }));

  function addMsg(role, html) {
    $('#chat-empty').style.display = 'none';
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    div.innerHTML = `
      <div class="avatar">${icon(role === 'user' ? 'user' : 'bot')}</div>
      <div class="body"><div class="who">${role === 'user' ? 'you' : 'claude'}<span class="when">${hhmm(Date.now())}</span></div>
      <div class="content">${html}</div></div>`;
    msgs.appendChild(div);
    $('#chat-scroll').scrollTop = $('#chat-scroll').scrollHeight;
    return div.querySelector('.content');
  }

  function toolChip(name, inputSummary) {
    return `<div class="tool-chip">${icon('tools')} <b>${esc(name)}</b>${inputSummary ? `<small>${esc(inputSummary)}</small>` : ''}</div>`;
  }
  function summarizeToolInput(t) {
    const i = t.input || {};
    for (const k of ['command', 'file_path', 'pattern', 'query', 'url', 'description', 'prompt', 'path'])
      if (typeof i[k] === 'string') return i[k].slice(0, 120);
    return '';
  }

  async function sendChat() {
    const prompt = input.value.trim();
    if (!prompt || chatBusy) return;
    chatBusy = true;
    $('#chat-send').disabled = true;
    input.value = ''; input.style.height = 'auto';
    addMsg('user', `<div class="text">${esc(prompt)}</div>`);
    const out = addMsg('assistant', `<div class="typing"><i></i><i></i><i></i></div>`);
    const scroll = () => { $('#chat-scroll').scrollTop = $('#chat-scroll').scrollHeight; };

    let cwd = $('#chat-cwd').value.trim();
    if (cwd.startsWith('~')) cwd = cwd.replace('~', '');
    const body = {
      prompt,
      sessionId: chatSessionId,
      model: $('#chat-model').value || undefined,
      permissionMode: $('#chat-perm').value,
      cwd: $('#chat-cwd').value.trim() || undefined,
    };

    try {
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok || !res.body) throw new Error('server error ' + res.status);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let firstChunk = true;

      const handle = (ev) => {
        if (ev.type === 'system' && ev.subtype === 'init') {
          chatSessionId = ev.session_id || chatSessionId;
          return;
        }
        if (ev.type === 'assistant' && ev.message) {
          if (firstChunk) { out.innerHTML = ''; firstChunk = false; }
          const c = ev.message.content;
          if (Array.isArray(c)) {
            for (const b of c) {
              if (b.type === 'thinking' && b.thinking)
                out.insertAdjacentHTML('beforeend', `<div class="text thinking">${esc(b.thinking.slice(0, 600))}</div>`);
              if (b.type === 'text' && b.text)
                out.insertAdjacentHTML('beforeend', `<div class="text">${esc(b.text)}</div>`);
              if (b.type === 'tool_use')
                out.insertAdjacentHTML('beforeend', toolChip(b.name, summarizeToolInput(b)));
            }
          } else if (typeof c === 'string' && c) {
            out.insertAdjacentHTML('beforeend', `<div class="text">${esc(c)}</div>`);
          }
          scroll();
          return;
        }
        if (ev.type === 'result') {
          chatSessionId = ev.session_id || chatSessionId;
          if (firstChunk) { out.innerHTML = ''; firstChunk = false; }
          if (ev.is_error && ev.result)
            out.insertAdjacentHTML('beforeend', `<div class="result-line err">${esc(String(ev.result).slice(0, 600))}</div>`);
          else {
            const u = ev.usage || {};
            const meta = [
              ev.total_cost_usd != null ? fmtUsd(ev.total_cost_usd) : null,
              ev.duration_ms != null ? (ev.duration_ms / 1000).toFixed(1) + 's' : null,
              ev.num_turns ? ev.num_turns + ' turns' : null,
              u.output_tokens ? fmtTok(u.output_tokens) + ' out' : null,
            ].filter(Boolean).join(' · ');
            if (meta) out.insertAdjacentHTML('beforeend', `<div class="result-line">✓ ${meta}</div>`);
          }
          scroll();
          return;
        }
        if (ev.type === 'error') {
          if (firstChunk) { out.innerHTML = ''; firstChunk = false; }
          out.insertAdjacentHTML('beforeend', `<div class="result-line err">${esc(ev.text)}</div>`);
          scroll();
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const p of parts) {
          const line = p.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          try { handle(JSON.parse(line.slice(6))); } catch { /* */ }
        }
      }
      if (firstChunk) {
        let diag = '';
        try {
          const d = await api('/api/doctor');
          diag = d.bin ? `<br>CLI: <code>${esc(d.bin)}</code> · ${esc(d.version || '?')}` : '<br>CLI binary not found — set <code>CLAUDE_BIN</code> and restart.';
        } catch { /* */ }
        out.innerHTML = `<div class="result-line err">no response — is the <code>claude</code> CLI installed and logged in?${diag}</div>`;
      }
    } catch (err) {
      out.innerHTML = `<div class="result-line err">${esc(err.message)}</div>`;
    } finally {
      chatBusy = false;
      $('#chat-send').disabled = false;
      refreshHeader(); refreshSideSessions();
    }
  }

  /* ───────── USAGE ───────── */
  async function loadUsage() {
    const u = await api('/api/usage');
    const t = u.totals;
    $('#usage-sub').textContent = `since first recorded session · cache reads are nearly free`;
    const cards = [
      ['cost', 'total cost', fmtUsd(t.cost), `${fmtUsd((u.blocks.active || {}).cost || 0)} this block`, 'accent'],
      ['token', 'output tokens', fmtTok(t.output), `${fmtTok(t.input)} input`],
      ['spark', 'cache read', fmtTok(t.cacheRead), `${fmtTok(t.cacheWrite)} written`],
      ['msg', 'messages', fmtTok(t.msgs), ''],
      ['clock', 'burn rate', u.blocks.active ? fmtTok(Math.round(u.blocks.burnRate)) + '/min' : '—', u.blocks.active ? `proj. ${fmtUsd(u.blocks.projected)} / block` : 'no active block'],
    ];
    $('#usage-cards').innerHTML = cards.map(([ic, l, v, s, cls]) => `
      <div class="card ${cls || ''}"><span class="ic">${icon(ic)}</span><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('');

    // last 30 days series
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10);
      days.push({ date: d, data: u.daily[d] });
    }
    areaChart($('#chart-daily'), days.map((d) => ({ date: d.date, value: d.data ? d.data.cost : 0 })), { fmt: fmtUsd });
    stackChart($('#chart-tokens'),
      days.map((d) => ({
        date: d.date,
        parts: { output: d.data?.output || 0, input: d.data?.input || 0, 'cache write': d.data?.cacheWrite || 0 },
      })),
      { output: '#e0633c', input: '#6aa6ff', 'cache write': '#b48cf2' }, { fmt: fmtTok });

    const items = Object.entries(u.models)
      .filter(([, v]) => v.cost > 0.0001)
      .sort((a, b) => b[1].cost - a[1].cost)
      .map(([m, v]) => ({ label: shortModel(m), value: v.cost, color: modelColor(m) }));
    donutChart($('#chart-models'), items, { fmt: fmtUsd });

    hbarChart($('#chart-blocks'), u.blocks.blocks.slice().reverse().map((b) => ({
      label: new Date(b.start).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      value: b.cost,
      color: u.blocks.active === b || (u.blocks.active && u.blocks.active.start === b.start) ? 'var(--accent)' : 'rgba(255,255,255,0.25)',
    })), { fmt: fmtUsd });
  }

  /* ───────── SESSIONS ───────── */
  let allSessions = [];
  async function loadSessions() {
    allSessions = await api('/api/sessions');
    renderSessions();
  }
  function renderSessions() {
    const q = ($('#session-filter').value || '').toLowerCase();
    const list = allSessions.filter((s) => !q || (s.title + s.projectName + s.cwd).toLowerCase().includes(q));
    $('#sessions-list').innerHTML = list.map((s) => `
      <div class="session-card" onclick="openSession('${s.id}')">
        <div class="title">${s.active ? '<span class="dot-active">●</span> ' : ''}${esc(s.title)}</div>
        <div class="row">
          <span class="pill orange">${esc(s.projectName)}</span>
          ${s.gitBranch ? `<span>${icon('branch')}${esc(s.gitBranch)}</span>` : ''}
          <span>${icon('msg')}${s.messages}</span>
          <span>${icon('tools')}${s.toolCount}</span>
          ${s.agentCount ? `<span class="pill purple">${s.agentCount} agents</span>` : ''}
          <span class="pill">${fmtUsd(s.cost)}</span>
          <span>${ago(s.lastTs)}</span>
        </div>
      </div>`).join('') || '<div class="empty">no sessions found — run Claude Code or use the Chat tab</div>';
  }
  $('#session-filter').addEventListener('input', renderSessions);

  /* ───────── SESSION DETAIL ───────── */
  window.openSession = async function (id) {
    go('session');
    $('#session-title').textContent = 'loading…';
    const s = await api('/api/session?id=' + encodeURIComponent(id));
    if (s.error) { $('#session-title').textContent = 'not found'; return; }
    $('#session-title').textContent = s.title.slice(0, 90);
    $('#session-meta').innerHTML = [
      ['folder', 'project', esc(s.projectName), esc(s.cwd)],
      ['cost', 'cost', fmtUsd(s.cost), ''],
      ['token', 'tokens out', fmtTok(s.usage.output), fmtTok(s.usage.cacheRead) + ' cache read'],
      ['msg', 'messages', s.messages, s.userMsgs + ' prompts'],
      ['clock', 'last activity', ago(s.lastTs), s.models.map(shortModel).join(', ')],
    ].map(([ic, l, v, sub]) => `<div class="card"><span class="ic">${icon(ic)}</span><div class="l">${l}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`).join('');

    // transcript
    $('#session-transcript').innerHTML = (s.entries || []).map((e) => {
      const tools = (e.tools || []).map((t) => toolChip(t.name, t.input)).join('');
      const long = (e.text || '').length > 700;
      return `<div class="tr-entry ${e.t} ${e.sidechain ? 'sidechain' : ''}">
        <div class="who">${e.t === 'user' ? 'user' : 'claude'}${e.model ? ' · ' + esc(shortModel(e.model)) : ''}${e.sidechain ? ' · sub-agent' : ''}${e.ts ? ' · ' + hhmm(e.ts) : ''}</div>
        ${e.thinking ? `<div class="text thinking">${esc(e.thinking)}</div>` : ''}
        ${e.text ? `<div class="text ${long ? 'clamp' : ''}">${esc(e.text)}</div>${long ? '<span class="tr-more" onclick="this.previousElementSibling.classList.toggle(\'clamp\');this.textContent=this.textContent===\'show more\'?\'show less\':\'show more\'">show more</span>' : ''}` : ''}
        ${tools}
      </div>`;
    }).join('') || '<div class="empty">empty transcript</div>';

    renderAgentGraph($('#session-graph'), s);
    hbarChart($('#session-tools'), Object.entries(s.tools || {})
      .sort((a, b) => b[1].count - a[1].count).slice(0, 12)
      .map(([n, t]) => ({ label: n, value: t.count, sub: t.errors ? t.errors + ' err' : '', color: 'var(--purple)' })),
      { fmt: (n) => n });
  };

  /* agent graph: main session node -> spawned sub-agents */
  function renderAgentGraph(el, s) {
    const agents = s.agents || [];
    if (!agents.length) { el.innerHTML = '<div class="empty">no sub-agents in this session</div>'; return; }
    const W = el.clientWidth || 420, rowH = 64, H = 80 + agents.length * rowH;
    const mainX = 20, mainY = H / 2 - 20, agX = Math.max(190, W * 0.45);
    let svg = `<svg class="agraph" viewBox="0 0 ${W} ${H}">`;
    svg += `<g class="node-main"><rect x="${mainX}" y="${mainY}" width="130" height="44" rx="10"/>
      <text x="${mainX + 14}" y="${mainY + 19}">main session</text>
      <text x="${mainX + 14}" y="${mainY + 34}" class="sub">${esc(shortModel(s.models[0] || ''))}</text></g>`;
    agents.forEach((a, i) => {
      const y = 30 + i * rowH;
      const x1 = mainX + 130, y1 = mainY + 22, x2 = agX, y2 = y + 22;
      svg += `<path class="edge" d="M${x1} ${y1} C ${x1 + 40} ${y1}, ${x2 - 40} ${y2}, ${x2} ${y2}"/>`;
      svg += `<g class="node-agent"><rect x="${agX}" y="${y}" width="${Math.min(240, W - agX - 16)}" height="44" rx="10"/>
        <text x="${agX + 12}" y="${y + 19}">${esc(a.type)}</text>
        <text x="${agX + 12}" y="${y + 34}" class="sub">${esc((a.description || a.prompt || '').slice(0, 36))}</text>
        <title>${esc(a.description)}\n${esc(a.prompt)}</title></g>`;
    });
    el.innerHTML = svg + '</svg>';
  }

  /* ───────── AGENTS view ───────── */
  async function loadAgents() {
    const data = await api('/api/agents');
    $('#agents-list').innerHTML = data.map((g) => `
      <div class="panel agent-session">
        <div class="head" onclick="openSession('${g.session.id}')">
          <h4>${esc(g.session.title.slice(0, 100))}</h4>
          <span class="muted">${esc(g.session.projectName)} · ${ago(g.session.lastTs)} · ${g.agents.length} agents →</span>
        </div>
        <div class="agent-cards">
          ${g.agents.map((a) => `
            <div class="agent-card">
              <div class="type">${icon('agents')} ${esc(a.type)}${a.model ? ` <span class="muted">(${esc(a.model)})</span>` : ''}</div>
              <div class="desc">${esc(a.description || '—')}</div>
              <div class="prompt">${esc(a.prompt)}</div>
            </div>`).join('')}
        </div>
      </div>`).join('') || '<div class="empty panel">no Task-tool sub-agents found yet</div>';
  }

  /* ───────── TOOLS ───────── */
  async function loadTools() {
    const t = await api('/api/tools');
    hbarChart($('#tools-board'), Object.entries(t.totals)
      .sort((a, b) => b[1].count - a[1].count).slice(0, 18)
      .map(([n, v]) => ({ label: n, value: v.count, sub: v.errors ? v.errors + ' err' : '', color: 'var(--purple)' })),
      { fmt: (n) => fmtTok(n) });
    $('#tools-recent').innerHTML = t.recent.map((c) => `
      <div class="feed-item tool_use ${c.isError ? 'err' : ''}">
        <span class="ic">${icon(c.isError ? 'error' : 'tools')}</span>
        <div class="fbody">
          <div class="fmeta"><b>${esc(c.name)}</b><span>${esc(c.project)}</span>${c.sidechain ? '<span>sub-agent</span>' : ''}</div>
          <div class="ftext">${esc(c.input || '')}</div>
        </div>
        <span class="ftime">${c.ts ? ago(c.ts) : ''}</span>
      </div>`).join('') || '<div class="empty">no tool calls yet</div>';
  }

  /* ───────── SKILLS ───────── */
  async function loadSkills() {
    const d = await api('/api/skills');
    const group = (title, items, ic) => items.length ? `
      <div class="skill-group"><h3>${title} (${items.length})</h3><div class="skill-grid">
        ${items.map((s) => `<div class="skill-card">
          <div class="name"><span class="ic">${icon(ic)}</span>${esc(s.name)}${s.source ? `<span class="src">${esc(s.source)}</span>` : ''}</div>
          <div class="desc">${esc(s.description || '—')}</div></div>`).join('')}
      </div></div>` : '';
    $('#skills-list').innerHTML =
      group('Skills', d.skills, 'skills') +
      group('Slash commands', d.commands, 'prompts') +
      group('Agent definitions', d.agents, 'agents') ||
      '<div class="empty panel">nothing found in ~/.claude/skills, commands or agents</div>';
    if (!d.skills.length && !d.commands.length && !d.agents.length)
      $('#skills-list').innerHTML = '<div class="empty panel">nothing found in ~/.claude (skills / commands / agents)</div>';
  }

  /* ───────── PROMPTS ───────── */
  let allPrompts = [];
  async function loadPrompts() {
    allPrompts = await api('/api/prompts');
    renderPrompts();
  }
  function renderPrompts() {
    const q = ($('#prompt-filter').value || '').toLowerCase();
    const list = allPrompts.filter((p) => !q || p.text.toLowerCase().includes(q)).slice(0, 200);
    $('#prompts-list').innerHTML = list.map((p) => `
      <div class="prompt-item" title="click to reuse in chat" data-text="${esc(p.text)}">
        <div class="text">${esc(p.text.slice(0, 400))}</div>
        <div class="meta">${p.project ? `<span>${esc(p.project)}</span>` : ''}<span>${p.ts ? new Date(p.ts).toLocaleString() : ''}</span></div>
      </div>`).join('') || '<div class="empty">no prompts recorded</div>';
    $$('.prompt-item').forEach((el) => el.addEventListener('click', () => {
      go('chat');
      input.value = el.dataset.text;
      input.dispatchEvent(new Event('input'));
      input.focus();
    }));
  }
  $('#prompt-filter').addEventListener('input', renderPrompts);

  /* ───────── FEED (SSE) ───────── */
  let feedUnseen = 0;
  const feedIcons = { prompt: 'user', response: 'bot', tool_use: 'tools', tool_result: 'check', thinking: 'think', system: 'spark', hello: 'spark' };
  function updateFeedBadge() {
    const b = $('#feed-badge');
    b.textContent = feedUnseen > 99 ? '99+' : feedUnseen;
    b.classList.toggle('hidden', feedUnseen === 0);
  }
  function connectSSE() {
    const es = new EventSource('/api/events');
    es.onopen = () => { $('#live-dot').classList.add('on'); $('#live-label').textContent = 'live'; };
    es.onerror = () => { $('#live-dot').classList.remove('on'); $('#live-label').textContent = 'reconnecting'; };
    es.onmessage = (m) => {
      let e; try { e = JSON.parse(m.data); } catch { return; }
      if (e.kind === 'hello') return;
      if ($('#feed-pause').checked) return;
      if (!$('#view-feed').classList.contains('active')) { feedUnseen++; updateFeedBadge(); }
      const list = $('#feed-list');
      const div = document.createElement('div');
      div.className = `feed-item ${e.kind} ${e.isError ? 'err' : ''}`;
      const text = e.kind === 'tool_use'
        ? (e.tools || []).map((t) => `${t.name}(${t.input || ''})`).join('  ')
        : e.text || (e.kind === 'tool_result' ? (e.isError ? 'tool error' : 'tool ok') : e.kind);
      div.innerHTML = `
        <span class="ic">${icon(feedIcons[e.kind] || 'spark')}</span>
        <div class="fbody">
          <div class="fmeta"><b>${e.kind}</b><span>${esc(e.project || '')}</span>${e.model ? `<span>${esc(shortModel(e.model))}</span>` : ''}${e.sidechain ? '<span>sub-agent</span>' : ''}</div>
          <div class="ftext">${esc(text)}</div>
        </div>
        <span class="ftime">${hhmm(e.ts)}</span>`;
      list.prepend(div);
      while (list.children.length > 400) list.lastChild.remove();
    };
  }
  connectSSE();
  $('#feed-clear').addEventListener('click', () => { $('#feed-list').innerHTML = ''; feedUnseen = 0; updateFeedBadge(); });

  /* ───────── loaders map ───────── */
  const LOADERS = {
    usage: loadUsage,
    sessions: loadSessions,
    agents: loadAgents,
    tools: loadTools,
    skills: loadSkills,
    prompts: loadPrompts,
  };

  mountIcons();
})();
