/**
 * PRadar — ui/app.js (v2)
 * SDK wiring for the Construct app. Calls tools, renders PR list, handles actions.
 */

// ── State ─────────────────────────────────────────────
let _prsJson = null;
let _waitedJson = null;
let _staleJson = null;
let _healthJson = null;
let _riskJson = null;   // enriched PRs with risk data
let _currentFilter = 'all';
let _allPRs = [];
let _stalePRs = [];
let _riskyPRs = [];      // PRs with risk = 'high'
let _issues = [];      // GitHub issues (not PRs)

// ── DOM refs ──────────────────────────────────────────
const el = id => document.getElementById(id);

// ── Toast ─────────────────────────────────────────────
let _toastTimer = null;
function showToast(msg, type = '') {
  const t = el('toast');
  t.textContent = msg;
  t.className = `show ${type}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.className = ''; }, 3500);
}

// ── Status pill ───────────────────────────────────────
function setStatus(state, text) {
  const pill = el('status-pill');
  pill.className = state;
  el('status-text').textContent = text;
}

// ── Stat counter animation ────────────────────────────
function animateCount(elId, target, color) {
  const node = el(elId);
  if (color) node.style.color = color;
  let start = 0;
  const step = Math.max(1, Math.ceil(target / 20));
  const timer = setInterval(() => {
    start = Math.min(start + step, target);
    node.textContent = start;
    if (start >= target) clearInterval(timer);
  }, 40);
}

// ── Health score ──────────────────────────────────────
function updateHealth(health) {
  const gradeEl = el('health-grade');
  const fillEl = el('health-score-fill');
  const msgEl = el('health-msg');

  gradeEl.textContent = health.grade;
  gradeEl.className = `grade-${health.grade}`;

  // Bar fill color matches grade
  const fillColor = health.grade === 'A' ? 'var(--green)'
    : health.grade === 'B' ? '#4ade80'
      : health.grade === 'C' ? 'var(--amber)'
        : health.grade === 'D' ? '#fb923c'
          : 'var(--red)';
  fillEl.style.background = fillColor;
  fillEl.style.width = `${health.score}%`;
  msgEl.textContent = `${health.score}/100 · ${health.message}`;

  // Bottom bar
  el('bar-avg').textContent = `${health.avg_wait_hours}h`;
  el('bar-longest').textContent = `${health.longest_wait_hours}h`;
}

// ── Render repos ──────────────────────────────────────
function renderRepos(prs) {
  const repos = [...new Set(prs.map(p => p.repo))];
  const list = el('repos-list');
  if (repos.length === 0) {
    list.innerHTML = '<div style="font-size:10px;color:var(--text-faint)">no repos found</div>';
    return;
  }
  list.innerHTML = repos.map(r => `<span class="repo-tag">${r}</span>`).join('');
}

// ── Render PR row ─────────────────────────────────────
function renderPR(pr) {
  const flag = pr.flag || 'green';
  const waitClass = `wait-${flag}`;
  const dotClass = `dot-${flag}`;
  const waitHrs = pr.wait_hours != null ? `${pr.wait_hours}h` : '';
  const reviewerChip = pr.reviewers && pr.reviewers.length > 0
    ? `<span class="pr-reviewer-chip">👥 ${pr.reviewers.length}</span>`
    : '<span class="pr-unassigned-tag">👤 unassigned</span>';
  const labels = (pr.labels || []).map(l => `<span class="pr-label">${l}</span>`).join('');

  // Risk badge
  let riskBadge = '';
  if (pr.risk) {
    const riskLabel = pr.risk === 'high' ? '🚨 HIGH' : pr.risk === 'medium' ? '⚠️ MED' : '✅ LOW';
    const reasons = (pr.risk_reasons || []).join(' · ');
    const stats = pr.files_changed != null
      ? `${pr.files_changed} files · +${pr.additions ?? 0}/-${pr.deletions ?? 0} lines`
      : '';
    riskBadge = `
      <div class="risk-badge risk-${pr.risk}">${riskLabel}
        <div class="risk-tooltip">
          <strong>Risk: ${pr.risk.toUpperCase()} (${pr.risk_score}/100)</strong><br>
          ${reasons}<br>
          <span style="color:var(--text-faint)">${stats}</span>
        </div>
      </div>`;
  } else {
    riskBadge = '<span class="risk-analyzing">●●●</span>';
  }

  return `
    <a class="pr-row" href="${pr.url}" target="_blank" rel="noopener" title="${pr.title}">
      <div class="pr-urgency-bar ${dotClass}"></div>
      <div class="pr-info">
        <div class="pr-title">${escHtml(pr.title)}</div>
        <div class="pr-meta">
          <span class="pr-repo">${escHtml(pr.repo)}</span>
          <span class="pr-author">@${escHtml(pr.author)}</span>
          ${labels}
          ${reviewerChip}
        </div>
      </div>
      <div class="pr-wait ${waitClass}">${waitHrs}</div>
      ${riskBadge}
      <button class="snooze-btn" onclick="snoozePR(event,'${escHtml(pr.url)}')" title="Snooze 24h">💤</button>
    </a>`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Render PR list ────────────────────────────────────
function renderPRList(prs) {
  const list = el('pr-list');
  if (!prs || prs.length === 0) {
    list.innerHTML = `
      <div id="pr-empty">
        <div id="pr-empty-icon">✅</div>
        <div>No PRs to show for this filter.</div>
      </div>`;
    return;
  }
  list.innerHTML = prs.map(renderPR).join('');
}

// ── Filter ────────────────────────────────────────────
function applyFilter(filter) {
  _currentFilter = filter;
  const filterMap = { all: 'filter-all', stale: 'filter-stale', red: 'filter-crit', risk: 'filter-risk', issues: 'filter-issues', flow: 'filter-flow' };
  Object.entries(filterMap).forEach(([f, id]) => {
    const btn = el(id); if (btn) btn.classList.toggle('active', f === filter);
  });

  if (filter === 'all') renderPRList(_allPRs);
  else if (filter === 'stale') renderPRList(_stalePRs);
  else if (filter === 'red') renderPRList(_allPRs.filter(p => p.flag === 'red'));
  else if (filter === 'risk') renderPRList(_riskyPRs);
  else if (filter === 'issues') renderIssueList(_issues);
  else if (filter === 'flow') renderFlowView();
}
window.applyFilter = applyFilter;

// ── Snooze a PR ───────────────────────────────────────
async function snoozePR(e, url) {
  e.preventDefault();
  e.stopPropagation();
  try {
    const result = await construct.tools.callText('snooze_pr', { pr_url: url, hours: 24 });
    showToast('💤 ' + result, 'success');
    // Remove from current view
    _allPRs = _allPRs.filter(p => p.url !== url);
    _stalePRs = _stalePRs.filter(p => p.url !== url);
    applyFilter(_currentFilter);
  } catch (err) {
    showToast('Snooze failed: ' + (err.message || err), 'error');
  }
}
window.snoozePR = snoozePR;

// ── Run scan chain ────────────────────────────────────
async function runScan() {
  const btnScan = el('btn-scan');
  btnScan.disabled = true;
  btnScan.textContent = '⟳ SCANNING...';
  setStatus('scanning', 'SCANNING');

  try {
    // 1. List open PRs
    const prsRaw = await construct.tools.callText('list_open_prs', { repos: '' });
    _prsJson = prsRaw;
    _allPRs = JSON.parse(prsRaw);

    // 2. Compute wait times
    const waitedRaw = await construct.tools.callText('compute_review_wait', { prs_json: prsRaw });
    _waitedJson = waitedRaw;
    _allPRs = JSON.parse(waitedRaw);

    // 3. Flag stale
    const staleRaw = await construct.tools.callText('flag_stale_prs', { prs_json: waitedRaw });
    _staleJson = staleRaw;
    const staleResult = JSON.parse(staleRaw);
    _stalePRs = staleResult.stale || [];

    // 4. Health score (parallel — non-blocking for UI)
    construct.tools.callText('get_repo_health', { prs_json: waitedRaw })
      .then(h => { _healthJson = h; updateHealth(JSON.parse(h)); })
      .catch(() => { });

    // 5. Update stat cards
    const blockedCount = _allPRs.filter(p => p.flag === 'red').length;
    animateCount('stat-open', _allPRs.length, 'var(--green)');
    animateCount('stat-stale', staleResult.count, 'var(--amber)');
    animateCount('stat-blocked', blockedCount, 'var(--red)');

    renderRepos(_allPRs);
    applyFilter(_currentFilter);

    const now = new Date();
    el('last-scan-text').textContent = `LAST SCAN: ${now.toLocaleTimeString('en-IN', { hour12: false })} IST`;

    el('btn-slack').disabled = false;
    el('btn-notion').disabled = false;
    el('btn-notify').disabled = false;

    setStatus('nominal', 'NOMINAL');
    showToast(`✓ Scan complete — ${_allPRs.length} PRs loaded`, 'success');

    // Background: run risk analysis (non-blocking)
    runRiskAnalysis(_waitedJson);

    // Auto-alert: if red PRs found, fire notify.send (graceful in dev)
    if (blockedCount > 0) {
      setTimeout(() => {
        construct.tools.callText('alert_critical_prs', { prs_json: waitedRaw })
          .then(r => showToast(`🔔 ${r}`, ''))
          .catch(() => { });
      }, 1000);
    }

  } catch (err) {
    console.error('[PRadar] scan error:', err);
    setStatus('error', 'ERROR');
    showToast(`✗ Scan failed: ${err.message || err}`, 'error');
  } finally {
    btnScan.disabled = false;
    btnScan.textContent = '▶ RUN SCAN NOW';
  }
}
window.runScan = runScan;

// ── Risk Analysis (background) ──────────────────────────
async function runRiskAnalysis(prsJson) {
  if (!prsJson) return;
  showToast('🔍 Analysing code risk in background…', '');
  try {
    const riskRaw = await construct.tools.callText('assess_pr_risk', { prs_json: prsJson });
    _riskJson = riskRaw;
    _allPRs = JSON.parse(riskRaw);           // replace with risk-enriched
    _riskyPRs = _allPRs.filter(p => p.risk === 'high');
    // Also re-enrich stale list
    _stalePRs = _stalePRs.map(sp => _allPRs.find(p => p.url === sp.url) ?? sp);

    applyFilter(_currentFilter);                    // re-render current view

    // Bottom bar: high risk count
    const highCount = _riskyPRs.length;
    if (el('bar-highrisk')) el('bar-highrisk').textContent = `${highCount} PR${highCount !== 1 ? 's' : ''}`;

    if (highCount > 0) {
      showToast(`🚨 Risk analysis done — ${highCount} high-risk PR${highCount > 1 ? 's' : ''}`, 'error');
    } else {
      showToast('✓ Risk analysis done — no high-risk PRs', 'success');
    }

    // Enable action buttons now that we have risk data
    el('btn-comment').disabled = false;
    el('btn-assign').disabled = false;

  } catch (err) {
    console.warn('[PRadar] Risk analysis failed:', err.message);
    // Non-fatal: existing scan data is still valid
  }
}
window.runRiskAnalysis = runRiskAnalysis;

// ── Notify Team ───────────────────────────────────────
async function notifyTeam() {
  if (!_waitedJson) { showToast('Run a scan first', 'error'); return; }
  const btn = el('btn-notify');
  btn.disabled = true;
  btn.textContent = '⟳ ALERTING...';
  try {
    const result = await construct.tools.callText('alert_critical_prs', { prs_json: _waitedJson });
    showToast('🔔 ' + result, 'success');
  } catch (err) {
    showToast('✗ Notify error: ' + (err.message || err), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🔔 NOTIFY TEAM';
  }
}
window.notifyTeam = notifyTeam;

// ── Post to Slack ─────────────────────────────────────
async function postToSlack() {
  if (!_waitedJson || !_staleJson) { showToast('Run a scan first', 'error'); return; }
  const btn = el('btn-slack');
  btn.disabled = true;
  btn.textContent = '⟳ POSTING...';
  try {
    const result = await construct.tools.callText('post_digest', { prs_json: _waitedJson, stale_json: _staleJson });
    showToast('✓ ' + result, 'success');
  } catch (err) {
    showToast('✗ Slack error: ' + (err.message || err), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '⬆ POST TO SLACK';
  }
}
window.postToSlack = postToSlack;

// ── Write to Notion ───────────────────────────────────
async function writeToNotion() {
  if (!_waitedJson || !_staleJson) { showToast('Run a scan first', 'error'); return; }
  const btn = el('btn-notion');
  btn.disabled = true;
  btn.textContent = '⟳ WRITING...';
  try {
    const result = await construct.tools.callText('write_standup_entry', { prs_json: _waitedJson, stale_json: _staleJson });
    showToast('✓ ' + result, 'success');
  } catch (err) {
    showToast('✗ Notion error: ' + (err.message || err), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '📝 WRITE TO NOTION';
  }
}
window.writeToNotion = writeToNotion;

// ── Comment risk on GitHub PRs ──────────────────────
// Uses risk-enriched JSON; falls back to waitedJson if risk hasn't run yet
async function commentRisks() {
  const json = _riskJson || _waitedJson;
  if (!json) { showToast('Run a scan first', 'error'); return; }
  if (_riskyPRs.length === 0 && _riskJson) {
    showToast('No high-risk PRs to comment on.', ''); return;
  }
  const btn = el('btn-comment');
  btn.disabled = true;
  btn.textContent = '⏳ COMMENTING...';
  try {
    const result = await construct.tools.callText('post_risk_comment', { prs_json: json });
    showToast('💬 ' + result, 'success');
  } catch (err) {
    showToast('✗ Comment error: ' + (err.message || err), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '💬 COMMENT RISKS';
  }
}
window.commentRisks = commentRisks;

// ── Auto-assign reviewers ──────────────────────────
async function autoAssign() {
  const json = _riskJson || _waitedJson;
  if (!json) { showToast('Run a scan first', 'error'); return; }

  // Prompt for team members (inline — no modal needed for a dev tool)
  const teamInput = prompt(
    'Enter GitHub usernames of team members (comma-separated):',
    'username1,username2'
  );
  if (!teamInput || !teamInput.trim()) return;

  const btn = el('btn-assign');
  btn.disabled = true;
  btn.textContent = '⏳ ASSIGNING...';
  try {
    const result = await construct.tools.callText('auto_assign_prs', {
      prs_json: json,
      team_members: teamInput.trim(),
      min_wait_hours: 2
    });
    showToast('🎯 ' + result, 'success');
    // Refresh scan to show updated reviewer chips
    setTimeout(runScan, 1500);
  } catch (err) {
    showToast('✗ Auto-assign error: ' + (err.message || err), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🎯 AUTO-ASSIGN';
  }
}
window.autoAssign = autoAssign;

// ── Render a single Issue row ──────────────────────────
function renderIssue(iss) {
  const ageClass = iss.age_flag === 'fresh' ? 'fresh' : iss.age_flag === 'aging' ? 'aging' : 'stale';
  const labels = (iss.labels || []).map(l => `<span class="pr-label">${escHtml(l)}</span>`).join('');
  const assigneeEl = iss.assignee
    ? `<span class="issue-assignee">${escHtml(iss.assignee)}</span>`
    : '<span class="issue-unassigned">👤 unassigned</span>';
  return `
    <div class="issue-row">
      <div class="issue-age-bar age-${ageClass}"></div>
      <span class="issue-number">#${iss.number}</span>
      <div class="pr-info">
        <div class="pr-title">${escHtml(iss.title)}</div>
        <div class="pr-meta">
          <span class="pr-repo">${escHtml(iss.repo)}</span>
          <span class="pr-author">@${escHtml(iss.author)}</span>
          ${labels}
          ${assigneeEl}
        </div>
      </div>
      <div class="pr-wait wait-${ageClass}" style="min-width:38px">${iss.age_hours}h</div>
      <button class="ai-fix-btn" onclick="draftFix(event,'${escHtml(iss.url)}')">🤖 DRAFT FIX</button>
      <a href="${iss.url}" target="_blank" rel="noopener"
         style="color:var(--text-faint);font-size:14px;text-decoration:none;flex-shrink:0" title="Open on GitHub">↗</a>
    </div>`;
}

// ── Render Issue list ──────────────────────────────────
function renderIssueList(issues) {
  const list = el('pr-list');
  if (!issues || issues.length === 0) {
    list.innerHTML = `<div id="pr-empty"><div id="pr-empty-icon">📋</div><div>No open issues found.</div></div>`;
    return;
  }
  list.innerHTML = `<div style="padding:6px 20px;font-size:9px;color:var(--text-faint);text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid var(--border)">— ${issues.length} open issue${issues.length !== 1 ? 's' : ''} —</div>` + issues.map(renderIssue).join('');
}

// ── Load Issues from GitHub ────────────────────────
async function loadIssues() {
  const btn = el('btn-issues');
  btn.disabled = true;
  btn.textContent = '⏳ LOADING...';
  try {
    const raw = await construct.tools.callText('list_open_issues', { repos: '' });
    _issues = JSON.parse(raw);
    applyFilter('issues');   // switch view to issues tab automatically
    showToast(`📋 ${_issues.length} open issue${_issues.length !== 1 ? 's' : ''} loaded`, 'success');
  } catch (err) {
    showToast('✗ Issues error: ' + (err.message || err), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '📋 LOAD ISSUES';
  }
}
window.loadIssues = loadIssues;

// ── Draft AI Code Fix ───────────────────────────────
function draftFix(e, issueUrl) {
  e.stopPropagation();
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = '⏳ THINKING...';

  const ctx = prompt(
    '🤖 Kimi will write a code fix for this issue.\nOptional: add context (e.g. "React TypeScript app, use hooks")\nLeave blank to skip:',
    ''
  ) ?? '';

  // Fire and handle result async
  construct.tools.callText('draft_code_fix', { issue_url: issueUrl, context: ctx.trim() })
    .then(draftContent => {
      // If the GitHub post failed (returns "Could not post..." and the raw draft)
      // or if we just want to ensure they see the full result, show it in a modal instead of a tiny toast.
      if (draftContent.includes('Draft:\n\n')) {
        showToast('GitHub post failed (403). View draft in popup.', 'error');
        showDraftModal(draftContent);
      } else {
        showToast(draftContent, 'success', 8000);
      }
    })
    .catch(err => {
      showToast('✗ Draft error: ' + (err.message || err), 'error');
    })
    .finally(() => {
      btn.disabled = false;
      btn.textContent = '🤖 DRAFT FIX';
    });
}
window.draftFix = draftFix;

function showDraftModal(content) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);backdrop-filter:blur(4px);z-index:9999;display:flex;align-items:center;justify-content:center;padding:40px;';

  const modal = document.createElement('div');
  modal.style.cssText = 'background:var(--bg2);border:1px solid var(--border);border-radius:8px;width:100%;max-width:800px;max-height:100%;display:flex;flex-direction:column;box-shadow:0 10px 30px rgba(0,0,0,0.5);';

  const head = document.createElement('div');
  head.style.cssText = 'padding:16px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;';
  head.innerHTML = '<div style="font-size:14px;font-weight:600;color:var(--amber)">⚠️ GitHub 403: Here is your AI Draft</div><button style="background:none;border:none;color:var(--text-faint);cursor:pointer;font-size:16px">✕</button>';

  const body = document.createElement('div');
  body.style.cssText = 'padding:20px;overflow-y:auto;flex:1;';
  const pre = document.createElement('pre');
  pre.style.cssText = 'margin:0;font-family:var(--mono);font-size:11px;color:var(--text);white-space:pre-wrap;word-break:break-word;';
  pre.textContent = content; // Safely escape HTML

  const foot = document.createElement('div');
  foot.style.cssText = 'padding:16px 20px;border-top:1px solid var(--border);display:flex;gap:10px;justify-content:flex-end;';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'settings-btn settings-btn-primary';
  copyBtn.textContent = '📋 Copy Code';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'settings-btn settings-btn-secondary';
  closeBtn.textContent = 'Close';

  head.querySelector('button').onclick = () => document.body.removeChild(overlay);
  closeBtn.onclick = () => document.body.removeChild(overlay);
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(content);
    copyBtn.textContent = '✓ Copied!';
    setTimeout(() => copyBtn.textContent = '📋 Copy Code', 2000);
  };

  body.appendChild(pre);
  foot.appendChild(closeBtn);
  foot.appendChild(copyBtn);
  modal.appendChild(head);
  modal.appendChild(body);
  modal.appendChild(foot);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

// ── Flow Summary View ─────────────────────────────────
function renderFlowView() {
  const list = el('pr-list');

  if (!_allPRs.length && !_issues.length) {
    list.innerHTML = `<div id="pr-empty"><div id="pr-empty-icon">📊</div><div>Run a scan first to see the flow summary.</div></div>`;
    return;
  }

  const prs = _allPRs;
  const total = prs.length;
  const waiting = prs.filter(p => (p.wait_hours || 0) >= 8).length;
  const critical = prs.filter(p => p.flag === 'red').length;
  const unassigned = prs.filter(p => p.unassigned).length;
  const low = prs.filter(p => p.risk === 'low').length;
  const med = prs.filter(p => p.risk === 'medium').length;
  const high = prs.filter(p => p.risk === 'high').length;
  const analyzed = low + med + high;

  // Per-repo grouping
  const repoMap = {};
  prs.forEach(p => { repoMap[p.repo] = (repoMap[p.repo] || 0) + 1; });
  const maxInRepo = Math.max(1, ...Object.values(repoMap));

  // Issue summary
  const issTotal = _issues.length;
  const issStale = _issues.filter(i => i.age_flag === 'stale').length;
  const issUnassigned = _issues.filter(i => !i.assignee).length;

  const lowPct = analyzed ? (low / analyzed * 100).toFixed(1) : 0;
  const medPct = analyzed ? (med / analyzed * 100).toFixed(1) : 0;
  const hiPct = analyzed ? (high / analyzed * 100).toFixed(1) : 0;

  const scanTime = el('last-scan-text')?.textContent || '—';

  list.innerHTML = `
  <div id="flow-view">

    <div>
      <div class="flow-section-title">📡 PR Pipeline — ${total} open pull request${total !== 1 ? 's' : ''}</div>
      <div class="pipeline">
        <div class="pipeline-stage">
          <div class="pipeline-count" style="color:var(--green)">${total}</div>
          <div class="pipeline-label">Open</div>
        </div>
        <div class="pipeline-stage">
          <div class="pipeline-count" style="color:var(--amber)">${waiting}</div>
          <div class="pipeline-label">Waiting &gt;8h</div>
        </div>
        <div class="pipeline-stage">
          <div class="pipeline-count" style="color:var(--red)">${critical}</div>
          <div class="pipeline-label">Critical &gt;24h</div>
        </div>
        <div class="pipeline-stage">
          <div class="pipeline-count" style="color:var(--text-dim)">${unassigned}</div>
          <div class="pipeline-label">Unassigned</div>
        </div>
      </div>
    </div>

    ${analyzed > 0 ? `
    <div>
      <div class="flow-section-title">🛡 Risk Distribution (${analyzed} analysed)</div>
      <div class="risk-bar-wrap">
        <div class="risk-bar">
          <div class="risk-seg risk-seg-low"    style="width:${lowPct}%"></div>
          <div class="risk-seg risk-seg-medium" style="width:${medPct}%"></div>
          <div class="risk-seg risk-seg-high"   style="width:${hiPct}%"></div>
        </div>
        <div class="risk-legend">
          <span><div class="legend-dot-sm" style="background:var(--green)"></div> Low ${low} (${lowPct}%)</span>
          <span><div class="legend-dot-sm" style="background:var(--amber)"></div> Medium ${med} (${medPct}%)</span>
          <span><div class="legend-dot-sm" style="background:var(--red)"></div> High ${high} (${hiPct}%)</span>
        </div>
      </div>
    </div>` : ''}

    ${Object.keys(repoMap).length > 0 ? `
    <div>
      <div class="flow-section-title">📁 Activity by Repository</div>
      <div class="repo-lanes">
        ${Object.entries(repoMap).sort((a, b) => b[1] - a[1]).map(([repo, count]) => `
          <div class="repo-lane">
            <div class="lane-repo-name" title="${escHtml(repo)}">
              ${escHtml(repo.includes('/') ? repo.split('/')[1] : repo)}
              <span style="font-size:9px;color:var(--text-faint)"> / ${escHtml(repo.split('/')[0] || '')}</span>
            </div>
            <div class="lane-bar-wrap">
              <div class="lane-bar-fill" style="width:${(count / maxInRepo * 100).toFixed(0)}%"></div>
            </div>
            <div class="lane-count">${count} PR${count !== 1 ? 's' : ''}</div>
          </div>`).join('')}
      </div>
    </div>` : ''}

    ${issTotal > 0 ? `
    <div>
      <div class="flow-section-title">📋 Issues Summary</div>
      <div class="issue-summary-grid">
        <div class="issue-summary-card">
          <div class="issue-summary-num" style="color:var(--text)">${issTotal}</div>
          <div class="issue-summary-label">Open Issues</div>
        </div>
        <div class="issue-summary-card">
          <div class="issue-summary-num" style="color:var(--red)">${issStale}</div>
          <div class="issue-summary-label">Stale (&gt;72h)</div>
        </div>
        <div class="issue-summary-card">
          <div class="issue-summary-num" style="color:var(--text-dim)">${issUnassigned}</div>
          <div class="issue-summary-label">Unassigned</div>
        </div>
      </div>
    </div>` : `
    <div style="font-size:10px;color:var(--text-faint);text-align:center;padding:8px 0">
      Click <strong>📋 LOAD ISSUES</strong> to include issue stats in this view.
    </div>`}

    <div style="font-size:9px;color:var(--text-faint);text-align:right;padding-top:4px;border-top:1px solid var(--border)">
      Generated from scan data · ${scanTime}
    </div>
  </div>`;
}
window.renderFlowView = renderFlowView;

// ══════════════════════════════════════════════════════
// ── SETTINGS MODULE ───────────────────────────────────
// ══════════════════════════════════════════════════════

const CFG_KEYS = ['GITHUB_TOKEN', 'REPOS', 'SLACK_TOKEN', 'SLACK_CHANNEL', 'NOTION_KEY', 'NOTION_PAGE_ID', 'TEAM_MEMBERS'];
const STORAGE_KEY = 'pradar_config_v1';

function openSettings() {
  loadSettingsFromStorage();
  checkConfigStatus();
  el('settings-overlay').classList.add('open');
  el('settings-panel').classList.add('open');
}
window.openSettings = openSettings;

function closeSettings() {
  el('settings-overlay').classList.remove('open');
  el('settings-panel').classList.remove('open');
}
window.closeSettings = closeSettings;

function toggleSection(id) {
  el(id).classList.toggle('collapsed');
}
window.toggleSection = toggleSection;

// ── Load from localStorage into form fields ────────────
function loadSettingsFromStorage() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    CFG_KEYS.forEach(key => {
      const input = el('cfg-' + key);
      if (input && stored[key]) input.value = stored[key];
    });
  } catch (_) { }
}

// ── Save form fields → localStorage → /api/config ─────
async function saveSettings() {
  const config = {};
  CFG_KEYS.forEach(key => {
    const input = el('cfg-' + key);
    if (input && input.value.trim()) config[key] = input.value.trim();
  });

  // 1. Save to localStorage
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));

  // 2. POST to server /api/config so tools use the values immediately
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    const data = await res.json();
    if (data.ok) {
      showToast(`✓ Config saved & connected (${data.saved} key${data.saved !== 1 ? 's' : ''})`, 'success');
      checkConfigStatus();
    } else {
      showToast('✗ Server rejected config: ' + JSON.stringify(data), 'error');
    }
  } catch (err) {
    // If /api/config fails (e.g., SDK intercepts), show helpful message
    showToast('✓ Saved locally. Restart npm run dev to apply.', '');
  }
}
window.saveSettings = saveSettings;

// ── Check config status from server ───────────────────
async function checkConfigStatus() {
  const bar = el('cfg-status-bar');
  if (!bar) return;
  try {
    const res = await fetch('/api/config');
    const status = await res.json();
    const chips = CFG_KEYS.map(key => {
      const ok = status[key];
      const label = key.replace('_', '\u00a0'); // non-breaking space
      return `<span class="cfg-status-chip ${ok ? 'cfg-ok' : 'cfg-err'}">${ok ? '✓' : '✗'} ${label}</span>`;
    }).join('');
    bar.innerHTML = `<span style="font-size:9px;color:var(--text-faint);margin-right:4px">STATUS:</span>${chips}`;
  } catch (_) {
    bar.innerHTML = `<span style="font-size:9px;color:var(--text-faint)">Status check unavailable in this environment</span>`;
  }
}
window.checkConfigStatus = checkConfigStatus;

// ── Onboarding Welcome Screen for new users ──────────
function showOnboarding() {
  const list = el('pr-list');
  list.innerHTML = `
    <div style="padding:32px 24px;display:flex;flex-direction:column;gap:20px;max-width:680px;">
      <div style="font-size:22px;font-weight:700;color:var(--green);font-family:var(--mono)">📡 Welcome to PRadar</div>
      <div style="font-size:12px;color:var(--text-dim);line-height:1.7">
        PRadar is your <strong style="color:var(--text)">autonomous AI Engineering Manager</strong>.
        It monitors pull requests, assigns reviewers, assesses code risk, and uses Construct’s Kimi 2.6 AI to write code fixes for open issues — all automatically.
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        ${[
          ['🤖','AI Code Drafts','Reads GitHub Issues and writes production-ready code fixes using Kimi 2.6, posted directly to GitHub'],
          ['🎯','Auto-Assign Reviewer','3-tier fallback: GitHub API → Comment → Slack. Reviewer notified 100% of the time'],
          ['🛡','Risk Analysis','Grades every PR Low / Medium / High risk based on diff and posts a Risk Report on GitHub'],
          ['📊','Flow Dashboard','Visual pipeline showing Open → Waiting → Critical → Unassigned PRs + risk distribution'],
          ['📡','Standup Digests','Daily engineering summaries auto-posted to Slack and logged to Notion on a schedule'],
          ['🔔','Critical Alerts','Native desktop notifications when a PR hits a critical wait time'],
          ['📋','Issue Tracker','Fetches open GitHub Issues sorted by age, ready for the AI to draft fixes'],
          ['💾','Persistent Cache','All scan data survives page refreshes — no re-scanning needed on reload']
        ].map(([icon, title, desc]) => `
          <div style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:12px 14px">
            <div style="font-size:18px;margin-bottom:4px">${icon}</div>
            <div style="font-size:11px;font-weight:600;color:var(--text);margin-bottom:4px">${title}</div>
            <div style="font-size:10px;color:var(--text-dim);line-height:1.5">${desc}</div>
          </div>`).join('')}
      </div>

      <div style="background:linear-gradient(135deg,rgba(0,229,160,.06),rgba(0,229,160,.02));border:1px solid rgba(0,229,160,.25);border-radius:8px;padding:16px 18px">
        <div style="font-size:11px;font-weight:600;color:var(--green);margin-bottom:8px">⚡ Get started in 2 steps</div>
        <div style="font-size:10px;color:var(--text-dim);line-height:2">
          <strong style="color:var(--text)">1.</strong> Click the <strong style="color:var(--text)">&#9881; gear icon</strong> (top right) → Enter your <strong style="color:var(--text)">GitHub Token</strong> + <strong style="color:var(--text)">Repo(s)</strong> → click <strong style="color:var(--text)">💾 Save &amp; Connect</strong><br>
          <strong style="color:var(--text)">2.</strong> Click <strong style="color:var(--green)">▶ RUN SCAN NOW</strong> to load your PRs and start the AI pipeline
        </div>
      </div>

      <button onclick="openSettings()" style="align-self:flex-start;background:var(--green);color:#000;border:none;border-radius:6px;padding:10px 20px;font-size:11px;font-weight:700;cursor:pointer;font-family:var(--mono);letter-spacing:.05em">⚙️ OPEN SETTINGS</button>
    </div>`;
  setStatus('nominal', 'READY');
  el('last-scan-text').textContent = 'LAST SCAN: configure & scan ↑';
}

// ── Startup logic ──────────────────────────────
function hasConfig() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return !!(s.GITHUB_TOKEN && s.REPOS);
  } catch(_) { return false; }
}

async function startup() {
  await initSettings();
  if (!hasConfig()) {
    // Brand new user — show welcome screen
    showOnboarding();
  } else {
    // Returning user — restore cache or re-scan
    if (!loadScanCache()) runScan();
  }
}

// ── Auto-load on construct.ready() ────────────────────
if (typeof construct !== 'undefined' && construct.ready) {
  construct.ready(() => startup());
} else {
  document.addEventListener('construct:ready', startup);
  window.addEventListener('load', () => {
    startup();
    if (typeof construct === 'undefined') {
      console.warn('[PRadar] Construct SDK not found — running in standalone mode');
    }
  });
}

// ── Generate .dev.vars file content ───────────────────
function generateDevVars() {
  const lines = CFG_KEYS.map(key => {
    const input = el('cfg-' + key);
    const val = input?.value.trim() || '';
    return val ? `${key}="${val}"` : `# ${key}=""`;
  });
  el('devvars-output').value = lines.join('\n');
}
window.generateDevVars = generateDevVars;

function copyDevVars() {
  generateDevVars();
  const ta = el('devvars-output');
  if (!ta.value) { showToast('Fill in fields first, then Generate.', 'error'); return; }
  navigator.clipboard.writeText(ta.value).then(() => {
    showToast('📋 .dev.vars content copied!', 'success');
  }).catch(() => {
    ta.select();
    document.execCommand('copy');
    showToast('📋 Copied (fallback).', 'success');
  });
}
window.copyDevVars = copyDevVars;

function resetSettings() {
  if (!confirm('Clear all saved PRadar credentials?')) return;
  localStorage.removeItem(STORAGE_KEY);
  CFG_KEYS.forEach(key => {
    const input = el('cfg-' + key);
    if (input) input.value = '';
  });
  el('devvars-output').value = '';
  showToast('🗑 Config cleared.', '');
}
window.resetSettings = resetSettings;

// ── Apply stored config to server on startup ──────────
async function initSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const hasAny = Object.values(stored).some(v => v);
    if (hasAny) {
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(stored)
      });
    }
  } catch (_) { }
}

// ── Auto-load on construct.ready() ────────────────────
if (typeof construct !== 'undefined' && construct.ready) {
  construct.ready(() => { initSettings().then(runScan); });
} else {
  document.addEventListener('construct:ready', runScan);
  window.addEventListener('load', () => {
    initSettings(); // always push stored config to server
    if (typeof construct === 'undefined') {
      console.warn('[PRadar] Construct SDK not found — running in standalone mode');
      setStatus('nominal', 'DEV MODE');
      el('last-scan-text').textContent = 'LAST SCAN: SDK required';
    }
  });
}
