# Claude Dashboard

A local, dependency-free browser dashboard for **Claude Code** — chat with Claude on the main screen, then flip to usage analytics, sessions, sub-agent graphs, tool stats, skills, prompt history and a live event feed.

![local](https://img.shields.io/badge/runs-100%25%20locally-success) ![deps](https://img.shields.io/badge/npm%20dependencies-0-blue) ![node](https://img.shields.io/badge/node-%E2%89%A518-orange)

## Quick start

```bash
cd ClaudeDashboard
npm start          # or: node server.js
# open http://localhost:7777
```

That's it — no `npm install`, no build step, no external services. Everything stays on your machine.

## What's inside

| View | What it shows |
|---|---|
| **Chat** (default) | Talk to Claude through your local `claude` CLI. Pick model, permission mode and working directory; sessions continue automatically (`--resume`). Tool calls render as chips, results show cost/duration. |
| **Usage** | Total & daily cost, token breakdown (input / output / cache), cost-by-model donut, ccusage-style **5-hour billing blocks** with burn rate and projected block cost. |
| **Sessions** | Every session from `~/.claude/projects` — searchable cards with project, branch, messages, tools, agents, cost. Click through to the full transcript (incl. thinking + sub-agent sidechains). |
| **Agents** | Sub-agents spawned via the Task tool, grouped per session, plus an **agent graph** on each session detail. |
| **Tools** | Tool-call leaderboard with error counts + recent invocations across all sessions. |
| **Skills** | Skills, slash commands and agent definitions found in `~/.claude` (incl. plugin skills). |
| **Prompts** | Your full prompt history (`~/.claude/history.jsonl`), searchable, click to reuse in chat. |
| **Feed** | Live event stream — the server watches your session files and pushes prompts, responses, tool calls and errors over SSE in real time. |

The header shows a **live indicator** and a ring meter for the current 5-hour block (cost + time remaining), refreshed every 15 s.

## How it works

- `server.js` (zero-dependency Node ≥18) parses the JSONL transcripts in `~/.claude/projects/`, aggregates usage/cost per hour, deduplicates streamed messages, and watches the directory for changes (`fs.watch` → Server-Sent Events).
- Chat spawns `claude -p … --output-format stream-json` and streams every event to the browser. Requires the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) installed and logged in.
- Costs are estimated from public per-MTok pricing (opus / sonnet / haiku / fable) including cache writes & reads.
- The frontend is plain HTML/CSS/JS with hand-rolled SVG charts and icons — no frameworks, no CDNs.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `7777` | HTTP port |
| `CLAUDE_DIR` | `~/.claude` | Claude Code data directory |

## Notes

- **Permission modes** in chat: `ask permissions` denies anything interactive in headless mode; use `accept edits` or `bypass permissions` for agentic work (bypass executes commands without asking — use with care).
- Cost figures are estimates; subscription (Pro/Max) usage doesn't bill per token, but the numbers still show relative consumption.
