# README Repo Map Status Design

## Purpose

Rewrite the README so a new reader can distinguish the delivered TypeScript/JavaScript repository-navigation capability from the longer-term goal of broad large-project understanding.

## Structure

The README will present four concise sections:

1. **Current capability** — bounded discovery, compact Repo Map, scope/package/role-aware ranking, and evidence-driven file reads.
2. **Experiment stages** — #9 query-aware map baseline, #16 external `deepseek-harness` evaluation, #18 scope-aware ranking, and #20 one budgeted real DeepSeek observation.
3. **Measured evidence** — link to the committed reports, retain their sample/Provider limits, and show no universal performance or cost claim.
4. **Limits and next step** — no complete call graph/body semantics/cross-language support; Issue #10 will reduce redundant exploration with tool orchestration and evidence guardrails.

## Accuracy and Safety

- Use only metrics recorded in committed experiment reports.
- Do not include API keys, raw prompts, source contents, full answers, request IDs, or inferred prices.
- State that real Provider evaluation is opt-in, can incur cost, and is not part of `npm test`.

## Validation

- Check all report links resolve to committed files.
- Confirm README claims match the #9/#18/#20 reports.
- Run `npm test`, `npm run check`, `npm run build`, and `git diff --check` after the documentation edit.
