## What this changes

<!-- One or two sentences. -->

## Why

<!-- What did this cost, or what would it have cost? -->

## Checklist

- [ ] `npm test` passes
- [ ] `npm run check` passes (bouncer-gates on itself)
- [ ] `npm run build` passes

If this adds or changes a gate:

- [ ] At least one test asserting it **fires** on the bad case
- [ ] At least one test asserting it **stays quiet** on the near-miss
- [ ] Run against a real codebase, findings read by hand, count reported below
- [ ] `docs/gates.md` updated, including what the gate misses
- [ ] Severity chosen honestly (`error` stops someone's afternoon)

<!-- Findings on a real repository, if applicable:
     repo: ...   findings: ...   false positives: ... -->
