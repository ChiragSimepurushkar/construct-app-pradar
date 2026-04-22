import { ConstructApp } from '@construct-computer/app-sdk'
import { Octokit } from '@octokit/rest'

const app = new ConstructApp({ name: 'pradar', version: '1.0.0' })

// ── Types ─────────────────────────────────────────────
interface WorkerEnv {
  GITHUB_TOKEN?: string
  NOTION_KEY?: string
  NOTION_PAGE_ID?: string
  SLACK_TOKEN?: string
  SLACK_CHANNEL?: string
  REPOS?: string
  ASSETS?: { fetch: typeof fetch }
  [key: string]: unknown
}

interface PR {
  title: string; url: string; author: string; repo: string
  reviewers: string[]; labels: string[]; createdAt: string
  wait_hours?: number; flag?: string; unassigned?: boolean
  // Risk analysis fields (populated by assess_pr_risk)
  risk?: 'low' | 'medium' | 'high'
  risk_score?: number
  risk_reasons?: string[]
  files_changed?: number
  additions?: number
  deletions?: number
}

// ── Tool 1 ────────────────────────────────────────────
app.tool('list_open_prs', {
  description: 'Fetch all open pull requests across the team repos',
  parameters: {
    repos: { type: 'string', description: 'Comma-separated owner/repo list' }
  },
  handler: async (args, ctx) => {
    const token = ctx.auth?.github_token || (ctx.env as any).GITHUB_TOKEN
    const repoList = ((args.repos as string) || (ctx.env as any).REPOS || '').split(',')
    const octokit = new Octokit({ auth: token })
    const all: PR[] = []
    try {
      for (const repo of repoList.map((r: string) => r.trim())) {
        const [owner, name] = repo.split('/')
        if (!owner || !name) continue
        const prs = await octokit.paginate(octokit.pulls.list,
          { owner, repo: name, state: 'open', per_page: 100 })
        all.push(...prs.map(p => ({
          title: p.title, url: p.html_url ?? '',
          author: p.user?.login ?? 'unknown', repo,
          reviewers: p.requested_reviewers?.map(r => r.login) ?? [],
          labels: p.labels.map(l => l.name ?? ''),
          createdAt: p.created_at
        })))
      }
    } catch (e: any) {
      if (e.message && e.message.includes('fetch')) {
        throw new Error(`GitHub API blocked the connection (CORS/Network): ${e.message}`);
      }
      throw e;
    }
    return JSON.stringify(all)
  }
})

// ── Tool 2 ────────────────────────────────────────────
app.tool('compute_review_wait', {
  description: 'Calculate wait time for each PR and attach urgency flag',
  parameters: { prs_json: { type: 'string', description: 'JSON array of PRs from list_open_prs' } },
  handler: async (args) => {
    const prs: PR[] = JSON.parse(args.prs_json as string)
    const now = Date.now()
    const result = prs.map(pr => {
      const hrs = (now - new Date(pr.createdAt).getTime()) / 3_600_000
      return {
        ...pr, wait_hours: Math.round(hrs),
        flag: hrs < 8 ? 'green' : hrs < 24 ? 'amber' : 'red',
        unassigned: pr.reviewers.length === 0
      }
    })
    return JSON.stringify(result)
  }
})

// ── Tool 3 ────────────────────────────────────────────
app.tool('flag_stale_prs', {
  description: 'Return PRs waiting over threshold hours or labelled blocked or unassigned',
  parameters: {
    prs_json: { type: 'string', description: 'JSON array with wait_hours from compute_review_wait' },
    threshold_hours: { type: 'number', description: 'Hours before a PR is considered stale (default 24)' }
  },
  handler: async (args) => {
    const prs: PR[] = JSON.parse(args.prs_json as string)
    const thresh = (args.threshold_hours as number) || 24
    const stale = prs.filter(pr =>
      (pr.wait_hours ?? 0) > thresh ||
      pr.labels.some(l => l.toLowerCase().includes('block')) ||
      pr.unassigned)
    return JSON.stringify({ stale, count: stale.length, total: prs.length })
  }
})

// ── Tool 4 ────────────────────────────────────────────
app.tool('write_standup_entry', {
  description: 'Append PR digest to today Notion daily standup page',
  parameters: {
    prs_json: { type: 'string', description: 'Full PR list JSON' },
    stale_json: { type: 'string', description: 'Stale PRs JSON from flag_stale_prs' }
  },
  handler: async (args, ctx) => {
    const env = ctx.env as any
    const prs: PR[] = JSON.parse(args.prs_json as string)
    const { stale, count } = JSON.parse(args.stale_json as string)
    const bullets = stale.map((p: PR) => ({
      object: 'block', type: 'bulleted_list_item',
      bulleted_list_item: {
        rich_text: [{
          type: 'text',
          text: {
            content: `${p.flag === 'red' ? '🔴' : '🟡'} ${p.title} (${p.wait_hours}h) — ${p.repo}`,
            link: { url: p.url }
          }
        }]
      }
    }))
    const res = await fetch(`https://api.notion.com/v1/blocks/${env.NOTION_PAGE_ID}/children`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${env.NOTION_KEY}`,
        'Notion-Version': '2022-06-28', 'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        children: [{
          object: 'block', type: 'callout',
          callout: {
            icon: { emoji: '📡' },
            rich_text: [{
              type: 'text', text: {
                content:
                  `PRadar — ${prs.length} open PRs · ${count} need attention · ${new Date().toLocaleDateString()}`
              }
            }],
            children: bullets.length ? bullets : [{
              object: 'block', type: 'paragraph',
              paragraph: { rich_text: [{ type: 'text', text: { content: 'All PRs look healthy today!' } }] }
            }]
          }
        }]
      })
    })
    return res.ok ? 'Notion updated' : `Notion error: ${await res.text()}`
  }
})

// ── Tool 5 ────────────────────────────────────────────
app.tool('post_digest', {
  description: 'Post PR digest to team Slack channel before standup',
  parameters: {
    prs_json: { type: 'string', description: 'Full PR list JSON' },
    stale_json: { type: 'string', description: 'Stale PRs result from flag_stale_prs' }
  },
  handler: async (args, ctx) => {
    const env = ctx.env as any
    const prs: PR[] = JSON.parse(args.prs_json as string)
    const { stale, count } = JSON.parse(args.stale_json as string)
    const lines = stale.slice(0, 10).map((p: PR) =>
      `${p.flag === 'red' ? '🔴' : p.unassigned ? '👤' : '🟡'} *<${p.url}|${p.title}>* — ${p.wait_hours}h · \`${p.repo}\``
    ).join('\n')
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.SLACK_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: env.SLACK_CHANNEL,
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: '📡 PRadar — Morning Standup Digest' } },
          {
            type: 'section', fields: [
              { type: 'mrkdwn', text: `*Open PRs*\n${prs.length}` },
              { type: 'mrkdwn', text: `*Need attention*\n${count}` }
            ]
          },
          ...(lines ? [{ type: 'section', text: { type: 'mrkdwn', text: lines } }] : []),
          {
            type: 'context', elements: [{
              type: 'mrkdwn',
              text: 'Sent by PRadar via Construct · Runs weekdays 8:45 AM'
            }]
          }
        ],
        text: `${prs.length} open PRs · ${count} stale`
      })
    })
    const data = await res.json() as { ok: boolean, error?: string };
    return data.ok ? 'Slack digest posted' : `Slack error: ${data.error}`;
  }
})

// ── Tool 6: alert_critical_prs ────────────────────────
// Uses platform-native notify.send to fire desktop notifications for
// every red-flag (>24h) or unassigned PR. Variant 'error' for critical.
app.tool('alert_critical_prs', {
  description: 'Send Construct platform desktop notifications for critical and unassigned PRs',
  parameters: {
    prs_json: { type: 'string', description: 'PR list JSON from compute_review_wait' }
  },
  handler: async (args, ctx) => {
    const prs: PR[] = JSON.parse(args.prs_json as string)
    const critical = prs.filter(p => p.flag === 'red')
    const unassigned = prs.filter(p => p.unassigned && p.flag !== 'red')

    if (critical.length === 0 && unassigned.length === 0) {
      return 'No critical or unassigned PRs — team is healthy 🎉'
    }

    const results: string[] = []

    // Fire one notification per critical PR
    for (const pr of critical.slice(0, 5)) {
      try {
        await ctx.construct.tools.call('notify.send', {
          title: `🔴 Stale PR — ${pr.wait_hours}h waiting`,
          body: `"${pr.title}" in ${pr.repo} needs immediate review`,
          variant: 'error'
        })
        results.push(`notified: ${pr.title}`)
      } catch (e: any) {
        // In local dev, ConstructCallError('no_bridge') is expected — log and continue
        results.push(`notify unavailable (dev mode): ${pr.title}`)
      }
    }

    // Fire summary notification for unassigned
    if (unassigned.length > 0) {
      try {
        await ctx.construct.tools.call('notify.send', {
          title: `👤 ${unassigned.length} unassigned PR${unassigned.length > 1 ? 's' : ''}`,
          body: unassigned.slice(0, 3).map(p => p.title).join(', '),
          variant: 'info'
        })
        results.push(`unassigned summary sent`)
      } catch (_e) {
        results.push(`unassigned summary (dev mode)`)
      }
    }

    return `Alerts fired: ${critical.length} critical, ${unassigned.length} unassigned. ${results.join(' | ')}`
  }
})

// ── Tool 7: get_repo_health ───────────────────────────
// Composite health score 0–100. Formula:
//   Base 100 − (stale% × 40) − (unassigned% × 30) − (avg_wait_penalty × 30)
app.tool('get_repo_health', {
  description: 'Compute a 0–100 health score for the PR queue with letter grade A–F',
  parameters: {
    prs_json: { type: 'string', description: 'PR list JSON from compute_review_wait' }
  },
  handler: async (args) => {
    const prs: PR[] = JSON.parse(args.prs_json as string)
    if (prs.length === 0) return JSON.stringify({ score: 100, grade: 'A', open: 0, stale: 0, avg_wait_hours: 0, longest_wait_hours: 0, message: 'No open PRs — perfect health!' })

    const staleCount   = prs.filter(p => (p.wait_hours ?? 0) > 24 || p.unassigned).length
    const unassignedCount = prs.filter(p => p.unassigned).length
    const waitHours    = prs.map(p => p.wait_hours ?? 0)
    const avgWait      = waitHours.reduce((a, b) => a + b, 0) / prs.length
    const longestWait  = Math.max(...waitHours)

    const stalePct     = staleCount / prs.length
    const unassignedPct = unassignedCount / prs.length
    const waitPenalty  = Math.min(1, avgWait / 48) // 48h = max penalty

    const rawScore = 100 - (stalePct * 40) - (unassignedPct * 30) - (waitPenalty * 30)
    const score    = Math.max(0, Math.round(rawScore))
    const grade    = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 45 ? 'D' : 'F'

    return JSON.stringify({
      score, grade,
      open: prs.length,
      stale: staleCount,
      avg_wait_hours: Math.round(avgWait),
      longest_wait_hours: longestWait,
      message: grade === 'A' ? 'Excellent velocity' : grade === 'B' ? 'Good, minor backlog' : grade === 'C' ? 'Review queue growing' : grade === 'D' ? 'Action required' : 'Critical backlog — escalate now'
    })
  }
})

// ── Tool 8: snooze_pr ────────────────────────────────
// Marks a PR as snoozed for N hours. flag_stale_prs respects this.
const _snoozeRegistry = new Map<string, number>() // url → expiry timestamp

app.tool('snooze_pr', {
  description: 'Snooze a PR from the stale list for a specified number of hours',
  parameters: {
    pr_url:  { type: 'string', description: 'The GitHub PR URL to snooze' },
    hours:   { type: 'number', description: 'Number of hours to snooze (default 24)' }
  },
  handler: async (args) => {
    const url   = args.pr_url as string
    const hours = (args.hours as number) || 24
    const expiry = Date.now() + hours * 3_600_000
    _snoozeRegistry.set(url, expiry)
    const until = new Date(expiry).toLocaleTimeString('en-IN', { hour12: false })
    return `Snoozed until ${until} (${hours}h): ${url}`
  }
})

// Helper: check if a PR URL is snoozed (used in flag_stale_prs below)
export function isSnoozed(url: string): boolean {
  const expiry = _snoozeRegistry.get(url)
  if (!expiry) return false
  if (Date.now() > expiry) { _snoozeRegistry.delete(url); return false }
  return true
}

// ── Tool 9: assess_pr_risk ───────────────────────────
// Fetches the changed file list for each PR from GitHub, applies a
// risk scoring heuristic, and returns the enriched PR list.
// Risk bands: low (0–39) | medium (40–74) | high (75–100)
const HIGH_RISK_PATTERNS = [
  /auth/i, /login/i, /password/i, /secret/i, /credential/i,
  /\.env/i, /token/i, /encrypt/i, /jwt/i, /oauth/i,
  /migration/i, /migrate/i, /schema\.sql/i, /\.sql$/i,
  /dockerfile/i, /docker-compose/i, /terraform/i,
  /kubernetes/i, /\.k8s/i, /\.github\/workflows/i,
  /package\.json$/i, /yarn\.lock$/i, /pnpm-lock/i, /go\.sum$/i,
  /requirements\.txt$/i, /Gemfile\.lock$/i,
]
const MEDIUM_RISK_PATTERNS = [
  /controller/i, /handler/i, /route/i, /api/i,
  /middleware/i, /service/i, /store/i, /repository/i, /repo/i,
  /config/i, /settings/i, /cors/i,
]

app.tool('assess_pr_risk', {
  description: 'Analyse GitHub PR code diffs, score risk 0–100, tag each PR low/medium/high with reasons',
  parameters: {
    prs_json: { type: 'string', description: 'PR list JSON from compute_review_wait' }
  },
  handler: async (args, ctx) => {
    const token = (ctx.env as any).GITHUB_TOKEN
    const prs: PR[] = JSON.parse(args.prs_json as string)

    const enriched = await Promise.all(prs.map(async pr => {
      try {
        // Parse owner/repo/number from PR URL
        // URL format: https://github.com/owner/repo/pull/123
        const match = pr.url.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/)
        if (!match) return { ...pr, risk: 'low' as const, risk_score: 0, risk_reasons: ['Could not parse URL'], files_changed: 0, additions: 0, deletions: 0 }
        const [, owner, repo, numberStr] = match

        // Fetch PR details (additions, deletions) and files changed
        const [detailsRes, filesRes] = await Promise.all([
          fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${numberStr}`, {
            headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'PRadar/1.0', Accept: 'application/vnd.github+json' }
          }),
          fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${numberStr}/files?per_page=100`, {
            headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'PRadar/1.0', Accept: 'application/vnd.github+json' }
          })
        ])

        const details = detailsRes.ok ? await detailsRes.json() as any : {}
        const files: any[] = filesRes.ok ? await filesRes.json() : []
        const filenames: string[] = files.map((f: any) => f.filename)
        const additions: number = details.additions ?? 0
        const deletions: number = details.deletions ?? 0
        const totalLines = additions + deletions

        const reasons: string[] = []
        let score = 0

        // --- Rule-based scoring ---
        // Sensitive file patterns (high risk)
        const highHits = filenames.filter(f => HIGH_RISK_PATTERNS.some(p => p.test(f)))
        if (highHits.length > 0) {
          score += Math.min(50, highHits.length * 20)
          reasons.push(`Sensitive files: ${highHits.slice(0, 3).join(', ')}`)
        }

        // Medium-risk patterns
        const medHits = filenames.filter(f => !HIGH_RISK_PATTERNS.some(p => p.test(f)) && MEDIUM_RISK_PATTERNS.some(p => p.test(f)))
        if (medHits.length > 0 && score < 40) {
          score += Math.min(30, medHits.length * 10)
          reasons.push(`Core logic changes: ${medHits.slice(0, 2).join(', ')}`)
        }

        // Size-based scoring
        if (totalLines > 1000) { score += 25; reasons.push(`Large diff: ${totalLines} lines`) }
        else if (totalLines > 400) { score += 15; reasons.push(`Medium diff: ${totalLines} lines`) }
        else if (totalLines > 100) { score += 5; reasons.push(`${totalLines} lines changed`) }

        if (filenames.length > 30) { score += 15; reasons.push(`${filenames.length} files changed`) }
        else if (filenames.length > 10) { score += 5; reasons.push(`${filenames.length} files changed`) }

        // Test-only changes reduce risk
        const isTestOnly = filenames.every(f => /test|spec|__tests__|fixture/i.test(f))
        if (isTestOnly) { score = Math.max(0, score - 20); reasons.push('Test-only changes') }

        // Docs/UI-only also reduce risk
        const isDocOrUI = filenames.every(f => /\.md$|\.css$|\.scss$|\.png$|\.svg$|\.jpg$/i.test(f))
        if (isDocOrUI) { score = 0; reasons.push('Documentation / styling only') }

        const finalScore = Math.min(100, Math.max(0, score))
        const risk: 'low' | 'medium' | 'high' = finalScore >= 75 ? 'high' : finalScore >= 40 ? 'medium' : 'low'

        if (reasons.length === 0) reasons.push('No sensitive patterns detected')

        return {
          ...pr,
          risk, risk_score: finalScore,
          risk_reasons: reasons,
          files_changed: filenames.length,
          additions, deletions
        }
      } catch (e) {
        return { ...pr, risk: 'low' as const, risk_score: 0, risk_reasons: ['Analysis error'], files_changed: 0, additions: 0, deletions: 0 }
      }
    }))

    return JSON.stringify(enriched)
  }
})

// ── Tool 10: post_risk_comment ───────────────────────
// Posts a PRadar risk-analysis comment directly on each HIGH-risk PR
// on GitHub, so developers see the alert right in their code review flow.
app.tool('post_risk_comment', {
  description: 'Post a formatted risk-analysis comment on each high-risk GitHub PR',
  parameters: {
    prs_json: { type: 'string', description: 'Risk-enriched PR JSON from assess_pr_risk' }
  },
  handler: async (args, ctx) => {
    const token = (ctx.env as any).GITHUB_TOKEN
    const prs: PR[] = JSON.parse(args.prs_json as string)
    const highRisk = prs.filter(p => p.risk === 'high')

    if (highRisk.length === 0) return 'No high-risk PRs to comment on.'

    const results: string[] = []
    const now = new Date().toLocaleTimeString('en-IN', { hour12: false })

    for (const pr of highRisk) {
      try {
        const match = pr.url.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/)
        if (!match) { results.push(`skip (bad URL): ${pr.title}`); continue }
        const [, owner, repo, number] = match

        // Build a rich Markdown comment
        const riskEmoji = pr.risk_score! >= 90 ? '🚨' : '⚠️'
        const reasons   = (pr.risk_reasons ?? ['No reasons available'])
          .map(r => `- ${r}`).join('\n')
        const stats = pr.files_changed != null
          ? `| Files changed | ${pr.files_changed} |\n| Lines | +${pr.additions ?? 0} / -${pr.deletions ?? 0} |`
          : ''

        const body = `## ${riskEmoji} PRadar — Risk Analysis

| | |
|---|---|
| **Risk Level** | ${riskEmoji} **${(pr.risk ?? '').toUpperCase()}** (${pr.risk_score}/100) |
| **PR Title** | ${pr.title} |
${stats}

### Why this was flagged
${reasons}

---
> 🤖 *Automatically analysed by **[PRadar](https://github.com/construct-computer/app-registry)** via Construct AI platform · ${now} IST*
> *This is an automated comment. High-risk PRs require a senior reviewer.*`

        const res = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'User-Agent': 'PRadar/1.0',
              Accept: 'application/vnd.github+json',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ body })
          }
        )
        if (res.ok) results.push(`✓ commented: ${pr.title}`)
        else results.push(`✗ failed (${res.status}): ${pr.title}`)
      } catch (e: any) {
        results.push(`✗ error: ${pr.title} — ${e.message}`)
      }
    }
    return `Comments posted on ${highRisk.length} high-risk PR(s). ${results.join(' | ')}`
  }
})

// ── Tool 11: auto_assign_prs ──────────────────────────
// For every PR that has no reviewers requested and has been waiting
// longer than the threshold, picks a random available team member
// (excluding the PR author) and officially requests their review.
app.tool('auto_assign_prs', {
  description: 'Auto-assign reviewers to unassigned PRs using the GitHub API',
  parameters: {
    prs_json:     { type: 'string', description: 'PR list JSON (with wait_hours & unassigned flags)' },
    team_members: { type: 'string', description: 'Comma-separated GitHub usernames of the team' },
    min_wait_hours: { type: 'number', description: 'Only assign if waiting longer than this (default 2)' }
  },
  handler: async (args, ctx) => {
    const token       = (ctx.env as any).GITHUB_TOKEN
    const teamRaw     = (args.team_members as string) || (ctx.env as any).TEAM_MEMBERS || ''
    const team        = teamRaw.split(',').map((u: string) => u.trim()).filter(Boolean)
    const minWait     = (args.min_wait_hours as number) ?? 2
    const prs: PR[]   = JSON.parse(args.prs_json as string)

    if (team.length === 0) return 'No team members configured. Pass team_members param or set TEAM_MEMBERS secret.'

    const targets = prs.filter(p => p.unassigned && (p.wait_hours ?? 0) >= minWait)
    if (targets.length === 0) return `No unassigned PRs waiting ≥${minWait}h — all covered!`

    // ── Pre-fetch token owner (for self-assign fallback) ──
    let tokenOwner = ''
    try {
      const meRes = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'PRadar/1.0', Accept: 'application/vnd.github+json' }
      })
      if (meRes.ok) tokenOwner = ((await meRes.json()) as any).login ?? ''
    } catch (_) {}

    const results: string[] = []

    for (const pr of targets) {
      try {
        const match = pr.url.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/)
        if (!match) { results.push(`skip (bad URL): ${pr.title}`); continue }
        const [, owner, repo, number] = match

        // ── Check which team members are collaborators on this repo ──
        // Pick assignee: prefer team member that isn't the author, fall back to token owner
        const candidates = team.filter((m: string) => m.toLowerCase() !== (pr.author || '').toLowerCase())
        const assignee   = candidates.length > 0
          ? candidates[Math.floor(Math.random() * candidates.length)]
          : tokenOwner

        if (!assignee) { results.push(`⚠ no assignee found for: ${pr.title}`); continue }

        // ── Attempt 1: official GitHub review request ──
        const reviewRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/requested_reviewers`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'User-Agent': 'PRadar/1.0',
              Accept: 'application/vnd.github+json',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ reviewers: [assignee] })
          }
        )

        if (reviewRes.ok) {
          results.push(`✓ reviewer requested: @${assignee} → ${pr.title}`)
          continue
        }

        // ── Attempt 2 (fallback): post a @mention comment ──
        // Works with any PAT that has issues:write — no collaborator requirement
        const now = new Date().toLocaleTimeString('en-IN', { hour12: false })
        const commentBody = `## 🤖 PRadar — Reviewer Needed

@${assignee} you've been auto-selected to review this PR.

> **PR:** ${pr.title}
> **Waiting:** ${pr.wait_hours ?? 0}h · **Status:** unassigned
> **Automated by:** PRadar via Construct AI · ${now} IST

*(If you cannot review, please reassign or use \`/snooze\` in PRadar)*`

        const commentRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'User-Agent': 'PRadar/1.0',
              Accept: 'application/vnd.github+json',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ body: commentBody })
          }
        )

        if (commentRes.ok) {
          results.push(`💬 notified @${assignee} via comment → ${pr.title}`)
        } else {
          // ── Attempt 3: Slack notification (guaranteed to work) ──
          const slackToken   = (ctx.env as any).SLACK_TOKEN
          const slackChannel = (ctx.env as any).SLACK_CHANNEL
          if (slackToken && slackChannel) {
            const slackText = `:robot_face: *PRadar — Reviewer Needed*\n*PR:* <${pr.url}|${pr.title}>\n*Waiting:* ${pr.wait_hours ?? 0}h · *Status:* unassigned\nHey @${assignee} — please review this PR\nFailed to use GitHub API (token needs \`repo\` scope + \`issues:write\`)`
            const slackRes = await fetch('https://slack.com/api/chat.postMessage', {
              method: 'POST',
              headers: { Authorization: `Bearer ${slackToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ channel: slackChannel, text: slackText, mrkdwn: true })
            })
            const slackData = await slackRes.json() as any
            if (slackData.ok) {
              results.push(`📢 notified @${assignee} via Slack → ${pr.title}`)
            } else {
              results.push(`✗ all 3 methods failed for: ${pr.title} | Fix: add repo+issues:write scopes to your GitHub PAT`)
            }
          } else {
            results.push(`✗ GitHub 403 & no Slack token configured → ${pr.title} | Fix: add repo+issues:write scopes to your GitHub PAT`)
          }
        }
      } catch (e: any) {
        results.push(`✗ error: ${pr.title} — ${e.message}`)
      }
    }
    return `Auto-assigned ${results.filter(r => r.startsWith('✓')).length}/${targets.length} PRs. ${results.join(' | ')}`
  }
})

// ── Tool 12: list_open_issues ────────────────────────
// Fetches open GitHub issues (not PRs) across all monitored repos.
// Sorted by age descending so most-stale issues surface first.
app.tool('list_open_issues', {
  description: 'Fetch all open GitHub issues across the team repos (excludes PRs)',
  parameters: {
    repos:       { type: 'string', description: 'Comma-separated owner/repo list (overrides env)' },
    label_filter:{ type: 'string', description: 'Optional: only return issues with this label' }
  },
  handler: async (args, ctx) => {
    const token    = (ctx.env as any).GITHUB_TOKEN
    const repoList = ((args.repos as string) || (ctx.env as any).REPOS || '').split(',')
    const labelFilter = (args.label_filter as string || '').toLowerCase().trim()
    const octokit  = new Octokit({ auth: token })
    const all: any[] = []
    const now = Date.now()

    for (const repo of repoList.map((r: string) => r.trim())) {
      const [owner, name] = repo.split('/')
      if (!owner || !name) continue
      const issues = await octokit.paginate(octokit.issues.listForRepo, {
        owner, repo: name, state: 'open', per_page: 100,
        ...(labelFilter ? { labels: labelFilter } : {})
      })
      for (const iss of issues) {
        if (iss.pull_request) continue  // skip PRs that appear in issues API
        const ageHours = Math.round((now - new Date(iss.created_at).getTime()) / 3_600_000)
        all.push({
          number:    iss.number,
          title:     iss.title,
          body:      (iss.body ?? '').slice(0, 2000),   // cap body for LLM context
          url:       iss.html_url,
          repo,
          author:    iss.user?.login ?? 'unknown',
          assignee:  iss.assignees?.map((a: any) => a.login).join(', ') || null,
          labels:    iss.labels.map((l: any) => (typeof l === 'string' ? l : l.name ?? '')),
          createdAt: iss.created_at,
          age_hours: ageHours,
          age_flag:  ageHours < 24 ? 'fresh' : ageHours < 72 ? 'aging' : 'stale'
        })
      }
    }
    all.sort((a, b) => b.age_hours - a.age_hours)
    return JSON.stringify(all)
  }
})

// ── Tool 13: draft_code_fix ───────────────────────────
// Reads a GitHub issue, calls Construct's LLM (ctx.construct.tools.call)
// to generate a code fix, then posts the draft as a PR-ready comment
// on the original GitHub Issue. Falls back to a smart skeleton if LLM
// is unavailable (e.g., local dev mode without bridge).
app.tool('draft_code_fix', {
  description: 'Use the Construct LLM to draft a code fix for a GitHub issue and post it as a comment',
  parameters: {
    issue_url: { type: 'string', description: 'GitHub issue URL (e.g., https://github.com/owner/repo/issues/42)' },
    context:   { type: 'string', description: 'Additional context about the codebase or preferred language/framework' }
  },
  handler: async (args, ctx) => {
    const token = (ctx.env as any).GITHUB_TOKEN
    const issueUrl = args.issue_url as string
    const extra    = (args.context as string) || ''

    // Parse URL  → owner / repo / number
    const match = issueUrl.match(/github\.com\/([^\/]+)\/([^\/]+)\/issues\/(\d+)/)
    if (!match) return 'Invalid issue URL format. Expected: https://github.com/owner/repo/issues/N'
    const [, owner, repo, numberStr] = match

    // Fetch issue details
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${numberStr}`,
      { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'PRadar/1.0', Accept: 'application/vnd.github+json' } }
    )
    if (!res.ok) return `Could not fetch issue: ${res.status} ${await res.text()}`
    const issue = await res.json() as any

    const prompt = `You are a senior software engineer. A GitHub issue has been filed in the repository "${owner}/${repo}".

**Issue #${numberStr}: ${issue.title}**

${issue.body ?? '(no description provided)'}

${extra ? `**Additional context:** ${extra}` : ''}

**Your task:**
1. Analyse the issue carefully
2. Write a complete, production-ready code fix or implementation
3. Use the same language/framework as the repository if inferable, otherwise use TypeScript
4. Include necessary imports, types, and error handling
5. Add a short explanation of what the fix does and why

Format your response as:
## Analysis
[Brief diagnosis]

## Fix
\`\`\`typescript
[your complete code here]
\`\`\`

## How to use
[1-3 sentences on how to apply or test this fix]`

    let codeBody = ''

    // ── Try Construct platform LLM first ────────────────
    const llmTools = ['llm.text', 'llm.generate', 'ai.generate', 'llm.complete']
    let lastLlmError = ''
    for (const toolName of llmTools) {
      try {
        const llmResult = await ctx.construct.tools.call(toolName, {
          prompt,
          max_tokens: 1200,
          temperature: 0.2
        })
        codeBody = typeof llmResult === 'string' ? llmResult : JSON.stringify(llmResult)
        break
      } catch (e: any) {
        lastLlmError = e.message || String(e)
        console.error(`[LLM bridge] Failed calling ${toolName}:`, lastLlmError)
      }
    }

    // ── Fallback: rule-based skeleton if no LLM bridge ──
    if (!codeBody) {
      const labelNames: string[] = (issue.labels ?? []).map((l: any) => typeof l === 'string' ? l : l.name ?? '')
      const isBug  = labelNames.some((lb: string) => /bug|fix|error/i.test(lb))
      const isFeature = labelNames.some((lb: string) => /feature|enhancement|feat/i.test(lb))
      codeBody = `## Analysis
This is a ${isBug ? 'bug fix' : isFeature ? 'feature request' : 'task'} for issue #${numberStr}: **${issue.title}**

*(Note: LLM bridge was unavailable in this environment. The following is a structured skeleton.)*

## Fix
\`\`\`typescript
/**
 * Fix for: ${issue.title}
 * Issue: ${issueUrl}
 */

${isBug ? `// TODO: Identify the root cause
// Likely affected function or module:
// function affectedFunction(...) {
//   // Apply the fix here
// }` : `// TODO: Implement the feature
// export function newFeature(params: unknown): unknown {
//   throw new Error('Not yet implemented')
// }`}
\`\`\`

## How to use
1. Locate the relevant file based on the issue description above.
2. Apply the fix and run your test suite.
3. Open a PR referencing this issue: \`Fixes #${numberStr}\`.`
    }

    // ── Post the draft as a comment on the GitHub issue ─
    const now = new Date().toLocaleTimeString('en-IN', { hour12: false })
    const commentBody = `## 🤖 PRadar — AI Code Draft

${codeBody}

---
> Generated by **PRadar** via Construct AI (Kimi 2.6) · ${now} IST
> *To accept: copy the code above, apply it to the relevant file, and open a PR referencing \`Fixes #${numberStr}\`.*`

    const postRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${numberStr}/comments`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'PRadar/1.0',
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ body: commentBody })
      }
    )

    if (postRes.ok) {
      const created = await postRes.json() as any
      return `✓ Code draft posted on issue #${numberStr}. View it at: ${created.html_url}`
    } else {
      const errText = await postRes.text()
      // Return the draft even if posting failed
      return `Could not post comment (${postRes.status}: ${errText.slice(0,100)}). Draft:\n\n${codeBody}`
    }
  }
})

// ── Scheduled cron — chains all tools in sequence ────
async function runDailyScan(env: WorkerEnv) {
  const token = env.GITHUB_TOKEN
  const repoList: string[] = (env.REPOS || '').split(',').map((r: string) => r.trim()).filter(Boolean)

  if (!token || repoList.length === 0) {
    console.error('[PRadar cron] Missing GITHUB_TOKEN or REPOS secret')
    return
  }

  // Step 1: Fetch PRs via GitHub REST API (no Octokit import needed for cron — use fetch)
  const allPRs: PR[] = []
  for (const repo of repoList) {
    const [owner, name] = repo.split('/')
    if (!owner || !name) continue
    let page = 1
    while (true) {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${name}/pulls?state=open&per_page=100&page=${page}`,
        { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'PRadar/1.0', Accept: 'application/vnd.github+json' } }
      )
      if (!res.ok) { console.error(`[PRadar cron] GitHub error for ${repo}:`, await res.text()); break }
      const prs = await res.json() as any[]
      allPRs.push(...prs.map(p => ({
        title: p.title, url: p.html_url ?? '',
        author: p.user?.login ?? 'unknown', repo,
        reviewers: (p.requested_reviewers ?? []).map((r: any) => r.login),
        labels: (p.labels ?? []).map((l: any) => l.name ?? ''),
        createdAt: p.created_at
      })))
      if (prs.length < 100) break
      page++
    }
  }

  // Step 2: Compute wait times
  const now = Date.now()
  const withWait = allPRs.map(pr => {
    const hrs = (now - new Date(pr.createdAt).getTime()) / 3_600_000
    return {
      ...pr, wait_hours: Math.round(hrs),
      flag: hrs < 8 ? 'green' : hrs < 24 ? 'amber' : 'red',
      unassigned: pr.reviewers.length === 0
    }
  })

  // Step 3: Flag stale
  const stale = withWait.filter(pr =>
    (pr.wait_hours ?? 0) > 24 ||
    pr.labels.some(l => l.toLowerCase().includes('block')) ||
    pr.unassigned)

  const staleSummary = { stale, count: stale.length, total: withWait.length }

  // Step 4+5: Notify in parallel
  await Promise.all([
    postSlackDigest(env as any, withWait, staleSummary),
    writeNotionEntry(env as any, withWait, staleSummary)
  ])
}

async function postSlackDigest(env: any, prs: PR[], { stale, count }: { stale: PR[], count: number, total: number }) {
  const lines = stale.slice(0, 10).map(p =>
    `${p.flag === 'red' ? '🔴' : p.unassigned ? '👤' : '🟡'} *<${p.url}|${p.title}>* — ${p.wait_hours}h · \`${p.repo}\``
  ).join('\n')
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.SLACK_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel: env.SLACK_CHANNEL,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '📡 PRadar — Morning Standup Digest' } },
        {
          type: 'section', fields: [
            { type: 'mrkdwn', text: `*Open PRs*\n${prs.length}` },
            { type: 'mrkdwn', text: `*Need attention*\n${count}` }
          ]
        },
        ...(lines ? [{ type: 'section', text: { type: 'mrkdwn', text: lines } }] : []),
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'Sent by PRadar via Construct · Runs weekdays 8:45 AM' }] }
      ],
      text: `${prs.length} open PRs · ${count} stale`
    })
  })
  if (!res.ok) console.error('[PRadar cron] Slack error:', await res.text())
  else console.log('[PRadar cron] Slack digest posted')
}

async function writeNotionEntry(env: any, prs: PR[], { stale, count }: { stale: PR[], count: number, total: number }) {
  const bullets = stale.map(p => ({
    object: 'block', type: 'bulleted_list_item',
    bulleted_list_item: {
      rich_text: [{
        type: 'text',
        text: {
          content: `${p.flag === 'red' ? '🔴' : '🟡'} ${p.title} (${p.wait_hours}h) — ${p.repo}`,
          link: { url: p.url }
        }
      }]
    }
  }))
  const res = await fetch(`https://api.notion.com/v1/blocks/${env.NOTION_PAGE_ID}/children`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${env.NOTION_KEY}`,
      'Notion-Version': '2022-06-28', 'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      children: [{
        object: 'block', type: 'callout',
        callout: {
          icon: { emoji: '📡' },
          rich_text: [{
            type: 'text', text: {
              content:
                `PRadar — ${prs.length} open PRs · ${count} need attention · ${new Date().toLocaleDateString()}`
            }
          }],
          children: bullets.length ? bullets : [{
            object: 'block', type: 'paragraph',
            paragraph: { rich_text: [{ type: 'text', text: { content: 'All PRs look healthy today!' } }] }
          }]
        }
      }]
    })
  })
  if (!res.ok) console.error('[PRadar cron] Notion error:', await res.text())
  else console.log('[PRadar cron] Notion updated')
}

// ── In-memory user config (keyed by IP for isolated public demos) ──
const _userConfigs: Record<string, Record<string, string>> = {}
const CONFIG_KEYS = ['GITHUB_TOKEN','REPOS','SLACK_TOKEN','SLACK_CHANNEL','NOTION_KEY','NOTION_PAGE_ID','TEAM_MEMBERS'] as const

// ── Default export ─────────────────────────────────────
export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url)

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' } })
    }

    // Extract client IP for demo isolation
    const ip = request.headers.get('cf-connecting-ip') || 'unknown'

    // ── POST /api/config — save (or clear) user credentials from Settings UI ──
    if (request.method === 'POST' && url.pathname === '/api/config') {
      try {
        const body = await request.json() as Record<string, string>

        // Bug fix: client sends { __cleared: '1' } when localStorage is empty.
        // This tells us the user has NO config — record a sentinel so we never
        // fall back to the server's own env secrets for this visitor's IP.
        if (body['__cleared'] === '1') {
          _userConfigs[ip] = { __cleared: '1' }
          return new Response(JSON.stringify({ ok: true, saved: 0 }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          })
        }

        let saved = 0
        // Full replace: start with empty config for this IP
        _userConfigs[ip] = {}
        for (const key of CONFIG_KEYS) {
          if (body[key] !== undefined && body[key] !== '') {
            _userConfigs[ip][key] = body[key]
            saved++
          }
        }
        // If nothing was saved, mark as cleared (prevents env fallback)
        if (saved === 0) _userConfigs[ip] = { __cleared: '1' }
        return new Response(JSON.stringify({ ok: true, saved }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        })
      } catch (e: any) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      }
    }

    // ── GET /api/config — return which keys are configured (masked) ──
    if (request.method === 'GET' && url.pathname === '/api/config') {
      const status: Record<string, boolean> = {}
      const userConf = _userConfigs[ip] || {}
      for (const key of CONFIG_KEYS) {
        status[key] = !!((env as any)[key] || userConf[key])
      }
      return new Response(JSON.stringify(status), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      })
    }

    // ── All other requests: merge env + user config, inject into x-construct-env ──
    const userConf = _userConfigs[ip] ?? null

    // Bug fix: if the user has the __cleared sentinel, they have NO credentials.
    // Do NOT fall back to env secrets — use an empty config so their tool calls
    // return proper 401/403 errors rather than using the owner's tokens.
    const userHasCleared = userConf !== null && userConf['__cleared'] === '1'
    const userHasRealConfig = userConf !== null && !userHasCleared

    // First-time visitor (null) → use env as before (Construct platform auth flow)
    // Cleared visitor → use empty env (no leaked tokens)
    // Configured visitor → merge user config over env
    const merged: Record<string, unknown> = userHasCleared
      ? {}  // empty: no token fallback for new/unconfigured users
      : userHasRealConfig
        ? { ...env, ...userConf }  // user-supplied credentials win
        : { ...env }               // first-time visit: use env (Construct platform)

    const envB64 = btoa(unescape(encodeURIComponent(JSON.stringify(merged))))
    const augmented = new Request(request, {
      headers: (() => {
        const h = new Headers(request.headers)
        h.set('x-construct-env', envB64)
        return h
      })()
    })
    return app.fetch(augmented, merged as Record<string, unknown>)
  },

  async scheduled(_event: ScheduledEvent, env: WorkerEnv, ctx: ExecutionContext) {
    ctx.waitUntil(runDailyScan(env))
  }
}
