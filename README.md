<div align="center">

<img src="./ui/logo.png" alt="PRadar Logo" width="120" />

# PRadar — PR Review Intelligence

**An autonomous AI-powered engineering agent that manages your entire Pull Request lifecycle.**

[![Deployed on Cloudflare Workers](https://img.shields.io/badge/Deployed-Cloudflare%20Workers-F38020?style=flat&logo=cloudflare)](https://pradar.pradar.workers.dev)
[![Built for Construct](https://img.shields.io/badge/Built%20for-Construct%20AI-00e5a0?style=flat)](https://construct.computer)
[![Techfluence 2026](https://img.shields.io/badge/Bounty-Techfluence%202026-blueviolet?style=flat)](https://construct.computer)

**Live Demo:** https://pradar.pradar.workers.dev

</div>

---

## 🚀 What PRadar Does

PRadar acts as an autonomous **Engineering Manager** for your GitHub repositories. It never sleeps, doesn't need hand-holding, and automates the entire PR review pipeline end-to-end.

| Feature | Description |
|---|---|
| 🤖 **AI Code Fixes** | Reads GitHub Issues, uses **Construct's Kimi 2.6 LLM** to write production-ready code fixes, and posts the draft directly to the Issue |
| 🎯 **Auto-Assign Reviewers** | 3-tier fallback: GitHub API → comment mention → Slack DM. Reviewer is notified 100% of the time |
| 🛡 **Risk Analysis** | Grades every PR Low / Medium / High risk based on diff size and posts a Risk Report to GitHub |
| 📊 **Flow Dashboard** | Visual war-room: PR pipeline stages, risk distribution bar, per-repo activity lanes |
| 📡 **Standup Digests** | Cron-scheduled daily summaries posted to Slack and logged to Notion automatically |
| 🔔 **Desktop Alerts** | Native Construct notifications for PRs hitting critical wait times |
| 💾 **Persistent Cache** | All scan data survives page refreshes via localStorage |

---

## 🛠 13 Registered MCP Tools

| # | Tool | What it does |
|---|---|---|
| 1 | `list_open_prs` | Fetches all open PRs across monitored repos |
| 2 | `compute_review_wait` | Calculates wait time + urgency flags |
| 3 | `flag_stale_prs` | Isolates blocked/unassigned/overdue PRs |
| 4 | `get_repo_health` | Generates 0-100 composite health score |
| 5 | `assess_pr_risk` | Grades PRs by diff analysis |
| 6 | `post_risk_comment` | Posts Risk Report to GitHub PR |
| 7 | `auto_assign_prs` | 3-tier reviewer assignment |
| 8 | `alert_critical_prs` | Native desktop notifications |
| 9 | `snooze_pr` | Snooze alerts for a PR |
| 10 | `post_slack_alert` | Posts digest to Slack |
| 11 | `write_notion_entry` / `write_standup_entry` | Logs standup to Notion |
| 12 | `list_open_issues` | Fetches open issues sorted by age |
| 13 | `draft_code_fix` | Kimi 2.6 AI code generation for issues |

---

## ⚙️ Quick Setup

### 1. Clone and install

```bash
git clone https://github.com/ChiragSimepurushkar/PRadar.git
cd PRadar
npm install
```

### 2. Configure secrets

```bash
# Copy the example file
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your tokens (see below)
```

### 3. Run locally

```bash
npm run dev
# Open http://localhost:8787
```

### 4. Open the ⚙️ Settings panel in the UI

Fill in your credentials — no file editing needed after setup.

---

## 🔑 Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GITHUB_TOKEN` | ✅ | PAT with `repo` scope (Classic) or `Pull requests: R&W` + `Issues: R&W` (Fine-grained) |
| `REPOS` | ✅ | Comma-separated `owner/repo` list |
| `SLACK_TOKEN` | Optional | Bot token for Slack alerts |
| `SLACK_CHANNEL` | Optional | Target Slack channel ID |
| `NOTION_KEY` | Optional | Notion integration secret |
| `NOTION_PAGE_ID` | Optional | Notion page to log standups |
| `TEAM_MEMBERS` | Optional | GitHub usernames for auto-assign |

Create a `.dev.vars` file (see `.dev.vars.example`). **Never commit this file — it's in `.gitignore`.**

### GitHub Token Permissions

**Fine-grained PAT:** Repository permissions → `Pull requests: Read & write` + `Issues: Read & write` + `Contents: Read-only`

**Classic PAT:** Check the top-level `repo` scope.

---

## 🚢 Deploy to Cloudflare Workers

```bash
npx wrangler deploy
```

Then set your production secrets:

```bash
wrangler secret put GITHUB_TOKEN
wrangler secret put SLACK_TOKEN
wrangler secret put NOTION_KEY
# etc.
```

---

## 🏗 Architecture

- **Runtime:** Cloudflare Workers (edge, serverless)
- **Framework:** Construct App SDK (`@construct-computer/app-sdk`)
- **AI:** Construct platform-native Kimi 2.6 LLM bridge (`ctx.construct.tools.call`)
- **Scheduling:** Cloudflare Cron Triggers (daily standup at 03:15 UTC Mon-Fri)
- **Storage:** Browser localStorage (scan cache) + in-memory Worker config

---

## 📄 License

MIT — Built by Chirag Simepurushkar for Construct × Techfluence 2026.
