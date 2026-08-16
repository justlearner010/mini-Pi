# README Repo Map Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the README accurately explain mini-Pi's delivered Repo Map navigation capability, experiment progression, evidence, and present limits.

**Architecture:** Documentation-only update. The README links to committed reports rather than copying sensitive traces or unverified claims. The existing Issue #20 branch supplies telemetry and the real-run report, so no source behavior changes are needed.

**Tech Stack:** Markdown, GitHub-relative links, existing npm validation commands.

---

### Task 1: Rewrite the Repo Map status section

**Files:**
- Modify: `README.md`
- Reference: `docs/experiments/9-query-aware-repo-map.md`
- Reference: `docs/experiments/18-scope-aware-repo-map-ranking.md`
- Reference: `docs/experiments/20-live-provider-repo-map-evaluation.md`

- [ ] **Step 1: Define the documentation acceptance checks**

The replacement section must state all of the following:

```text
Delivered: bounded TS/JS discovery, compact map, scoped ranking, tool-verified reads.
Evidence: #9, #16/#17, #18/#19, #20/#21 reports.
Limits: no call graph/body semantics/cross-language support; one live run is not universal.
Next: #10 reduces redundant exploration with evidence guardrails.
```

- [ ] **Step 2: Replace the README Repo Map section**

Use four Markdown subsections in this order:

```markdown
## 大型项目导航：当前阶段
### 已交付能力
### 实验阶段与证据
### 边界与下一步
```

Keep API-key, source-content, raw-prompt, raw-answer, request-ID, and price details out of the README.

- [ ] **Step 3: Validate documentation links and repository health**

Run:

```bash
rg -n "9-query-aware|10-deepseek|18-scope-aware|20-live-provider" README.md
npm test
npm run check
npm run build
git diff --check
```

Expected: every linked report exists, all tests and checks pass, and the diff has no whitespace errors.

- [ ] **Step 4: Commit and push the documentation update**

Run:

```bash
git add README.md docs/superpowers/plans/2026-08-16-readme-repo-map-status.md
git commit -m "docs: explain repo map capability stages"
git push
```

Expected: the existing Issue #20 pull request receives the rewrite without a new PR.
