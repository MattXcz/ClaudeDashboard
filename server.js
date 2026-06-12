#!/usr/bin/env node
/**
 * Claude Dashboard — local server
 * Zero-dependency Node.js (>=18) server that:
 *  - parses ~/.claude session JSONL files (usage, tools, agents, prompts)
 *  - exposes a JSON API + SSE live event feed
 *  - bridges chat to the `claude` CLI (stream-json)
 *  - serves the static frontend from ./public
 *
 * Usage:  node server.js   (then open http://localhost:7777)
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const url = require('url');
const { spawn } = require('child_process');
const readline = require('readline');

const PORT = process.env.PORT || 7777;
const CLAUDE_DIR = process.env.CLAUDE_DIR || path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ----------------------------- pricing (USD / MTok) ----------------------------- */
const PRICING = [
  { match: /fable|mythos/i, input: 25, output: 125, cacheWrite: 31.25, cacheRead: 2.5 },
  { match: /opus/i, input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  { match: /sonnet/i, input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  { match: /haiku/i, input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
];
function costOf(model, u) {
  if (!u) return 0;
  const p = PRICING.find((p) => p.match.test(model || '')) || PRICING[2];
  return (
    ((u.input_tokens || 0) * p.input +
      (u.output_tokens || 0) * p.output +
      (u.cache_creation_input_tokens || 0) * p.cacheWrite +
      (u.cache_read_input_tokens || 0) * p.cacheRead) /
    1e6
  );
}

/* ----------------------------- session index ----------------------------- */
/** cache: filePath -> { mtimeMs, size, session } */
const cache = new Map();

function emptySession(id, project) {
  return {
    id,
    project,
    cwd: '',
    gitBranch: '',
    version: '',
    firstTs: null,
    lastTs: null,
    messages: 0,
    userMsgs: 0,
    assistantMsgs: 0,
    models: {},
    usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    cost: 0,
    tools: {}, // name -> { count, errors }
    toolCalls: [], // recent {ts,name,inputSummary,isError,agent}
    agents: [], // Task spawns {id,ts,type,description,model}
    firstPrompt: '',
    summary: '',
    entries: [], // light transcript entries
    hourly: {}, // isoHour -> {input,output,cacheWrite,cacheRead,cost,msgs}
    seen: new Set(), // dedup keys
  };
}

function summarizeInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  const keys = ['command', 'file_path', 'pattern', 'query', 'url', 'prompt', 'description', 'path', 'skill'];
  for (const k of keys) {
    if (typeof input[k] === 'string') return input[k].slice(0, 160);
  }
  try { return JSON.stringify(input).slice(0, 160); } catch { return ''; }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

function ingestLine(s, line) {
  let e;
  try { e = JSON.parse(line); } catch { return; }
  if (!e || typeof e !== 'object') return;

  if (e.type === 'summary' && e.summary) { s.summary = e.summary; return; }

  const ts = e.timestamp ? Date.parse(e.timestamp) : null;
  if (ts) {
    if (!s.firstTs || ts < s.firstTs) s.firstTs = ts;
    if (!s.lastTs || ts > s.lastTs) s.lastTs = ts;
  }
  if (e.cwd) s.cwd = e.cwd;
  if (e.gitBranch) s.gitBranch = e.gitBranch;
  if (e.version) s.version = e.version;

  const m = e.message;
  const sidechain = !!e.isSidechain;

  if (e.type === 'user' && m) {
    s.messages++;
    const txt = textOf(m.content);
    const isToolResult = Array.isArray(m.content) && m.content.some((b) => b && b.type === 'tool_result');
    if (isToolResult) {
      for (const b of m.content) {
        if (b && b.type === 'tool_result' && b.is_error) {
          // mark last matching tool call as error
          const tc = s.toolCalls.find((t) => t.id === b.tool_use_id);
          if (tc) { tc.isError = true; if (s.tools[tc.name]) s.tools[tc.name].errors++; }
        }
      }
    } else if (txt && !sidechain && e.userType !== 'external') {
      s.userMsgs++;
      if (!s.firstPrompt && !txt.startsWith('<')) s.firstPrompt = txt.slice(0, 220);
      if (s.entries.length < 4000)
        s.entries.push({ t: 'user', ts, text: txt.slice(0, 8000), sidechain });
    } else if (txt && sidechain && s.entries.length < 4000) {
      s.entries.push({ t: 'user', ts, text: txt.slice(0, 2000), sidechain });
    }
    return;
  }

  if (e.type === 'assistant' && m) {
    // dedup streamed duplicates (same message id + request id)
    const key = (m.id || '') + ':' + (e.requestId || '') + ':' + (Array.isArray(m.content) ? m.content.length : 0);
    if (m.id && s.seen.has(key)) return;
    if (m.id) s.seen.add(key);

    s.messages++;
    s.assistantMsgs++;
    const model = m.model || 'unknown';
    if (!/synthetic/i.test(model)) s.models[model] = (s.models[model] || 0) + 1;

    const u = m.usage;
    if (u) {
      const c = costOf(model, u);
      s.usage.input += u.input_tokens || 0;
      s.usage.output += u.output_tokens || 0;
      s.usage.cacheWrite += u.cache_creation_input_tokens || 0;
      s.usage.cacheRead += u.cache_read_input_tokens || 0;
      s.cost += c;
      if (ts) {
        const h = new Date(ts).toISOString().slice(0, 13);
        const hh = (s.hourly[h] ||= { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, msgs: 0, models: {} });
        hh.input += u.input_tokens || 0;
        hh.output += u.output_tokens || 0;
        hh.cacheWrite += u.cache_creation_input_tokens || 0;
        hh.cacheRead += u.cache_read_input_tokens || 0;
        hh.cost += c;
        hh.msgs++;
        hh.models[model] = (hh.models[model] || 0) + (u.output_tokens || 0);
      }
    }

    if (Array.isArray(m.content)) {
      const txt = textOf(m.content);
      const tools = [];
      let thinking = '';
      for (const b of m.content) {
        if (!b) continue;
        if (b.type === 'thinking' && b.thinking) thinking += b.thinking;
        if (b.type === 'tool_use') {
          const t = (s.tools[b.name] ||= { count: 0, errors: 0 });
          t.count++;
          const call = { id: b.id, ts, name: b.name, input: summarizeInput(b.name, b.input), isError: false, sidechain };
          tools.push(call);
          s.toolCalls.push(call);
          if (s.toolCalls.length > 500) s.toolCalls.shift();
          if (b.name === 'Task' && b.input) {
            s.agents.push({
              id: b.id, ts,
              type: b.input.subagent_type || 'general-purpose',
              description: b.input.description || '',
              prompt: (b.input.prompt || '').slice(0, 300),
              model: b.input.model || '',
            });
          }
        }
      }
      if ((txt || tools.length || thinking) && s.entries.length < 4000) {
        s.entries.push({
          t: 'assistant', ts, model,
          text: txt.slice(0, 8000),
          thinking: thinking ? thinking.slice(0, 1200) : undefined,
          tools: tools.length ? tools.map((t) => ({ name: t.name, input: t.input })) : undefined,
          sidechain,
        });
      }
    }
  }
}

async function parseSessionFile(file, project) {
  const id = path.basename(file, '.jsonl');
  const s = emptySession(id, project);
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) ingestLine(s, line);
  s.seen = undefined; // drop dedup set before caching/serving
  return s;
}

async function getAllSessions() {
  let projects = [];
  try { projects = await fsp.readdir(PROJECTS_DIR); } catch { return []; }
  const out = [];
  for (const proj of projects) {
    const dir = path.join(PROJECTS_DIR, proj);
    let files;
    try { files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      try {
        const st = await fsp.stat(file);
        const c = cache.get(file);
        if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) { out.push(c.session); continue; }
        const session = await parseSessionFile(file, proj);
        cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, session });
        out.push(session);
      } catch { /* skip unreadable */ }
    }
  }
  out.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  return out;
}

function projectName(encoded, cwd) {
  if (cwd) return cwd.split('/').filter(Boolean).pop() || cwd;
  return (encoded || '').replace(/^-/, '').split('-').pop() || encoded;
}

function sessionSummary(s) {
  return {
    id: s.id,
    project: s.project,
    projectName: projectName(s.project, s.cwd),
    cwd: s.cwd,
    gitBranch: s.gitBranch,
    version: s.version,
    firstTs: s.firstTs,
    lastTs: s.lastTs,
    messages: s.messages,
    userMsgs: s.userMsgs,
    models: Object.keys(s.models),
    usage: s.usage,
    cost: +s.cost.toFixed(4),
    toolCount: Object.values(s.tools).reduce((a, t) => a + t.count, 0),
    agentCount: s.agents.length,
    title: s.summary || s.firstPrompt || '(no prompt)',
    active: s.lastTs && Date.now() - s.lastTs < 5 * 60 * 1000,
  };
}

/* ----------------------------- aggregations ----------------------------- */
function aggregateUsage(sessions) {
  const daily = {}; // date -> {...}
  const models = {}; // model -> tokens/cost
  const hourlyToday = {};
  const today = new Date().toISOString().slice(0, 10);
  let totals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, msgs: 0 };

  for (const s of sessions) {
    for (const [h, v] of Object.entries(s.hourly || {})) {
      const day = h.slice(0, 10);
      const d = (daily[day] ||= { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0, msgs: 0, models: {} });
      d.input += v.input; d.output += v.output; d.cacheWrite += v.cacheWrite; d.cacheRead += v.cacheRead;
      d.cost += v.cost; d.msgs += v.msgs;
      for (const [m, t] of Object.entries(v.models || {})) {
        d.models[m] = (d.models[m] || 0) + t;
        const mm = (models[m] ||= { output: 0, cost: 0 });
        mm.output += t;
      }
      if (day === today) {
        const hh = (hourlyToday[h.slice(11, 13)] ||= { cost: 0, tokens: 0 });
        hh.cost += v.cost; hh.tokens += v.input + v.output;
      }
      totals.input += v.input; totals.output += v.output;
      totals.cacheWrite += v.cacheWrite; totals.cacheRead += v.cacheRead;
      totals.cost += v.cost; totals.msgs += v.msgs;
    }
    for (const [m, c] of Object.entries(s.models)) {
      const mm = (models[m] ||= { output: 0, cost: 0 });
      mm.msgs = (mm.msgs || 0) + c;
    }
    // attribute session cost to its dominant model for the donut
  }
  // model cost attribution: approximate from hourly model output share
  for (const s of sessions) {
    for (const v of Object.values(s.hourly || {})) {
      const totalOut = Object.values(v.models || {}).reduce((a, b) => a + b, 0) || 1;
      for (const [m, t] of Object.entries(v.models || {})) {
        models[m].cost += v.cost * (t / totalOut);
      }
    }
  }
  return { daily, models, hourlyToday, totals };
}

/** ccusage-style 5h billing blocks from hourly buckets */
function computeBlocks(sessions) {
  const hours = {};
  for (const s of sessions)
    for (const [h, v] of Object.entries(s.hourly || {})) {
      const x = (hours[h] ||= { cost: 0, tokens: 0, msgs: 0 });
      x.cost += v.cost; x.tokens += v.input + v.output + v.cacheWrite; x.msgs += v.msgs;
    }
  const keys = Object.keys(hours).sort();
  const blocks = [];
  let cur = null;
  for (const k of keys) {
    const t = Date.parse(k + ':00:00Z');
    if (!cur || t >= cur.end) {
      cur = { start: t, end: t + 5 * 3600e3, cost: 0, tokens: 0, msgs: 0 };
      blocks.push(cur);
    }
    cur.cost += hours[k].cost; cur.tokens += hours[k].tokens; cur.msgs += hours[k].msgs;
  }
  const now = Date.now();
  const active = blocks.length && now < blocks[blocks.length - 1].end ? blocks[blocks.length - 1] : null;
  let burnRate = 0, projected = 0;
  if (active) {
    const elapsed = Math.max(1, (now - active.start) / 60000); // minutes
    burnRate = active.tokens / elapsed;
    projected = active.cost * ((active.end - active.start) / Math.max(1, now - active.start));
  }
  return { blocks: blocks.slice(-12), active, burnRate, projected };
}

/* ----------------------------- skills / commands / agents defs ----------------------------- */
async function readSkillDir(dir, source) {
  const out = [];
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const md = path.join(dir, ent.name, 'SKILL.md');
    try {
      const raw = await fsp.readFile(md, 'utf8');
      const fm = /^---\n([\s\S]*?)\n---/.exec(raw);
      let name = ent.name, description = '';
      if (fm) {
        const n = /^name:\s*(.+)$/m.exec(fm[1]);
        const d = /^description:\s*([\s\S]*?)(?=\n\w+:|$)/m.exec(fm[1]);
        if (n) name = n[1].trim();
        if (d) description = d[1].replace(/\n\s+/g, ' ').trim().slice(0, 300);
      }
      out.push({ name, description, source, path: path.join(dir, ent.name) });
    } catch { /* no SKILL.md */ }
  }
  return out;
}

async function getSkills() {
  const skills = [];
  skills.push(...(await readSkillDir(path.join(CLAUDE_DIR, 'skills'), 'user')));
  // plugin skills
  const pluginsRepos = path.join(CLAUDE_DIR, 'plugins', 'repos');
  try {
    for (const org of await fsp.readdir(pluginsRepos)) {
      const orgDir = path.join(pluginsRepos, org);
      for (const repo of await fsp.readdir(orgDir).catch(() => [])) {
        const sk = path.join(orgDir, repo, 'skills');
        skills.push(...(await readSkillDir(sk, `plugin:${repo}`)));
      }
    }
  } catch { /* none */ }
  // slash commands
  const commands = [];
  try {
    for (const f of await fsp.readdir(path.join(CLAUDE_DIR, 'commands'))) {
      if (f.endsWith('.md')) {
        const raw = await fsp.readFile(path.join(CLAUDE_DIR, 'commands', f), 'utf8').catch(() => '');
        const d = /^description:\s*(.+)$/m.exec(raw);
        commands.push({ name: '/' + f.replace(/\.md$/, ''), description: d ? d[1].trim() : raw.split('\n').find((l) => l && !l.startsWith('---')) || '' });
      }
    }
  } catch { /* none */ }
  // agent definitions
  const agents = [];
  try {
    for (const f of await fsp.readdir(path.join(CLAUDE_DIR, 'agents'))) {
      if (f.endsWith('.md')) {
        const raw = await fsp.readFile(path.join(CLAUDE_DIR, 'agents', f), 'utf8').catch(() => '');
        const n = /^name:\s*(.+)$/m.exec(raw);
        const d = /^description:\s*(.+)$/m.exec(raw);
        agents.push({ name: n ? n[1].trim() : f.replace(/\.md$/, ''), description: d ? d[1].trim().slice(0, 200) : '' });
      }
    }
  } catch { /* none */ }
  return { skills, commands, agents };
}

/* ----------------------------- prompt history ----------------------------- */
async function getPrompts(sessions) {
  // Prefer ~/.claude/history.jsonl when present
  const file = path.join(CLAUDE_DIR, 'history.jsonl');
  const prompts = [];
  try {
    const raw = await fsp.readFile(file, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.display) prompts.push({ text: e.display, ts: e.timestamp ? (e.timestamp > 1e12 ? e.timestamp : e.timestamp * 1000) : null, project: e.project || '' });
      } catch { /* skip */ }
    }
  } catch { /* fall back to sessions */ }
  if (!prompts.length) {
    for (const s of sessions) {
      for (const e of s.entries) {
        if (e.t === 'user' && !e.sidechain && e.text && !e.text.startsWith('<'))
          prompts.push({ text: e.text.slice(0, 500), ts: e.ts, project: projectName(s.project, s.cwd), session: s.id });
      }
    }
  }
  prompts.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return prompts.slice(0, 500);
}

/* ----------------------------- SSE: live events ----------------------------- */
const sseClients = new Set();
const fileOffsets = new Map();

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) res.write(data);
}

function watchProjects() {
  if (!fs.existsSync(PROJECTS_DIR)) return;
  // seed offsets so we only stream *new* lines
  try {
    for (const proj of fs.readdirSync(PROJECTS_DIR)) {
      const dir = path.join(PROJECTS_DIR, proj);
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith('.jsonl')) fileOffsets.set(path.join(dir, f), fs.statSync(path.join(dir, f)).size);
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  let pending = new Set();
  let timer = null;
  const onChange = (evt, fname) => {
    if (!fname || !String(fname).endsWith('.jsonl')) return;
    pending.add(String(fname));
    if (!timer) timer = setTimeout(flush, 150);
  };
  const flush = () => {
    timer = null;
    const files = [...pending]; pending = new Set();
    for (const rel of files) {
      const file = path.join(PROJECTS_DIR, rel);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      const prev = fileOffsets.get(file) || 0;
      if (st.size <= prev) { fileOffsets.set(file, st.size); continue; }
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(st.size - prev);
      fs.readSync(fd, buf, 0, buf.length, prev);
      fs.closeSync(fd);
      fileOffsets.set(file, st.size);
      cache.delete(file); // force re-parse next time stats are requested
      const project = rel.split(path.sep)[0];
      const sessionId = path.basename(rel, '.jsonl');
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        const ev = simplifyEvent(e, project, sessionId);
        if (ev) broadcast(ev);
      }
    }
  };
  try {
    fs.watch(PROJECTS_DIR, { recursive: true }, onChange);
    console.log('▸ watching', PROJECTS_DIR);
  } catch (err) {
    console.warn('fs.watch recursive unavailable:', err.message);
  }
}

function simplifyEvent(e, project, sessionId) {
  const base = { ts: e.timestamp ? Date.parse(e.timestamp) : Date.now(), project, sessionId, sidechain: !!e.isSidechain };
  const m = e.message;
  if (e.type === 'user' && m) {
    if (Array.isArray(m.content) && m.content.some((b) => b && b.type === 'tool_result')) {
      const err = m.content.some((b) => b && b.type === 'tool_result' && b.is_error);
      return { ...base, kind: 'tool_result', isError: err };
    }
    const txt = textOf(m.content);
    if (txt) return { ...base, kind: 'prompt', text: txt.slice(0, 300) };
    return null;
  }
  if (e.type === 'assistant' && m) {
    const tools = Array.isArray(m.content) ? m.content.filter((b) => b && b.type === 'tool_use') : [];
    if (tools.length)
      return { ...base, kind: 'tool_use', model: m.model, tools: tools.map((t) => ({ name: t.name, input: summarizeInput(t.name, t.input) })) };
    const txt = textOf(m.content);
    if (txt) return { ...base, kind: 'response', model: m.model, text: txt.slice(0, 300), usage: m.usage };
    if (Array.isArray(m.content) && m.content.some((b) => b && b.type === 'thinking'))
      return { ...base, kind: 'thinking', model: m.model };
    return null;
  }
  if (e.type === 'system' && e.subtype) return { ...base, kind: 'system', text: e.subtype };
  return null;
}

/* ----------------------------- chat bridge (claude CLI) ----------------------------- */
function handleChat(req, res) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => {
    let p;
    try { p = JSON.parse(body); } catch { res.writeHead(400); return res.end('bad json'); }
    const prompt = (p.prompt || '').trim();
    if (!prompt) { res.writeHead(400); return res.end('empty prompt'); }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
    if (p.sessionId) args.push('--resume', p.sessionId);
    if (p.model) args.push('--model', p.model);
    if (p.permissionMode && p.permissionMode !== 'default') args.push('--permission-mode', p.permissionMode);

    const cwd = p.cwd && fs.existsSync(p.cwd) ? p.cwd : os.homedir();
    const child = spawn('claude', args, { cwd, env: { ...process.env }, shell: process.platform === 'win32' });

    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ type: 'status', text: 'started' });

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try { send(JSON.parse(line)); } catch { send({ type: 'raw', text: line.slice(0, 500) }); }
    });
    let errBuf = '';
    child.stderr.on('data', (d) => { errBuf += d; });
    child.on('error', (err) => { send({ type: 'error', text: `Cannot start claude CLI: ${err.message}` }); res.end(); });
    child.on('close', (code) => {
      if (code !== 0 && errBuf) send({ type: 'error', text: errBuf.slice(0, 1000) });
      send({ type: 'done', code });
      res.end();
    });
    req.on('close', () => { try { child.kill('SIGTERM'); } catch { /* */ } });
  });
}

/* ----------------------------- HTTP server ----------------------------- */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

function json(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const route = u.pathname;
  try {
    if (route === '/api/stats') {
      const sessions = await getAllSessions();
      const usage = aggregateUsage(sessions);
      const blocks = computeBlocks(sessions);
      const toolTotals = {};
      for (const s of sessions)
        for (const [n, t] of Object.entries(s.tools)) {
          const x = (toolTotals[n] ||= { count: 0, errors: 0 });
          x.count += t.count; x.errors += t.errors;
        }
      const today = new Date().toISOString().slice(0, 10);
      return json(res, {
        claudeDir: CLAUDE_DIR,
        dirExists: fs.existsSync(PROJECTS_DIR),
        sessions: sessions.length,
        activeSessions: sessions.filter((s) => s.lastTs && Date.now() - s.lastTs < 5 * 60e3).length,
        totals: usage.totals,
        today: usage.daily[today] || null,
        models: usage.models,
        blocks,
        toolKinds: Object.keys(toolTotals).length,
        toolCalls: Object.values(toolTotals).reduce((a, t) => a + t.count, 0),
        agents: sessions.reduce((a, s) => a + s.agents.length, 0),
      });
    }
    if (route === '/api/usage') {
      const sessions = await getAllSessions();
      return json(res, { ...aggregateUsage(sessions), blocks: computeBlocks(sessions) });
    }
    if (route === '/api/sessions') {
      const sessions = await getAllSessions();
      return json(res, sessions.map(sessionSummary));
    }
    if (route === '/api/session') {
      const sessions = await getAllSessions();
      const s = sessions.find((x) => x.id === u.query.id);
      if (!s) return json(res, { error: 'not found' }, 404);
      return json(res, { ...sessionSummary(s), entries: s.entries, agents: s.agents, tools: s.tools, toolCalls: s.toolCalls.slice(-200) });
    }
    if (route === '/api/tools') {
      const sessions = await getAllSessions();
      const totals = {};
      const recent = [];
      for (const s of sessions) {
        for (const [n, t] of Object.entries(s.tools)) {
          const x = (totals[n] ||= { count: 0, errors: 0 });
          x.count += t.count; x.errors += t.errors;
        }
        for (const c of s.toolCalls)
          recent.push({ ...c, session: s.id, project: projectName(s.project, s.cwd) });
      }
      recent.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      return json(res, { totals, recent: recent.slice(0, 120) });
    }
    if (route === '/api/skills') return json(res, await getSkills());
    if (route === '/api/prompts') return json(res, await getPrompts(await getAllSessions()));
    if (route === '/api/agents') {
      const sessions = await getAllSessions();
      const out = [];
      for (const s of sessions)
        if (s.agents.length)
          out.push({ session: sessionSummary(s), agents: s.agents });
      return json(res, out.slice(0, 60));
    }
    if (route === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
      res.write(`data: ${JSON.stringify({ kind: 'hello', ts: Date.now() })}\n\n`);
      sseClients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { sseClients.delete(res); clearInterval(ping); });
      return;
    }
    if (route === '/api/chat' && req.method === 'POST') return handleChat(req, res);

    /* static */
    let file = route === '/' ? '/index.html' : route;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (err) {
    json(res, { error: err.message }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`\n  ◤ Claude Dashboard ◢\n`);
  console.log(`  ▸ http://localhost:${PORT}`);
  console.log(`  ▸ data: ${CLAUDE_DIR}\n`);
  watchProjects();
});
