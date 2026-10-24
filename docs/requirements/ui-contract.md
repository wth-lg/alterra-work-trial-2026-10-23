# UI contract

The routes, query parameters and exact strings that the expects in `docs/requirements/trace.json`
depend on, each with the plan phase that owns it. The P14, P14a, P15, P16, P24 and P25c briefs
quote this file. A phase that renders one of these strings renders it exactly as written here
(case, spacing and punctuation), because the final audit (P25c) checks it by substring or by
regular expression in the accessibility snapshot.

`pnpm cli trace-check` reads this file. Every `ui.route`, every `ax_text` text and every
`ax_match` pattern in trace.json must appear here as a backticked string, or the check fails.
To change a string, change it here and in trace.json in the same commit. Every `ui_required`
row has at least one `ax_text` or `ax_match` element, so its expect fails when the screen is
wrong.

## Base path and surfaces

Routes are relative to the app base: `/clinical-agent-env/` on the hosted Pages site and `/` on
the local runner. Each trace row with a `ui` names its surface:

| Surface | Where P25c takes the snapshot |
|---|---|
| `local` | The local runner (`pnpm start`), in P25c step (2). Live trials work here. |
| `hosted` | The Pages site, in P25c step (1). |
| `any` | The hosted site in step (1); the local runner shows the same screen. |

## Query parameters

| Parameter | Values | Owner |
|---|---|---|
| `view` | `overview` (default), `tasks`, `runs`, `findings`, `environment`, `glossary` | P13 (rail), P14 (`glossary`) |
| `task` | a task id, for example `renal-dose-review` | P14 |
| `tab` | on a task: `prompt` (default), `policy`, `chart`, `rubric`, `reference-solution`, `grader-validation`; on a trial: `grading` (default), `attribution`, `state-diff`, `environment`, `raw` | P14 (task tabs), P16 (trial tabs) |
| `run` | a run id, for example `final-1`, or the token `session` | P14, P15 (`session`) |
| `trial` | a trial id, or the token `first-nonpass` | P16 |

Every parameter round-trips: opening the URL shows the same screen, and moving between screens
updates the URL. An unknown value falls back to the default view and does not error.

### Tokens

A route never holds a placeholder such as `<trial>`; `trace-check --final` fails on `<` in a
route. A route that needs a run-specific trial uses a token that the UI resolves:

- `trial=first-nonpass`: the first valid trial whose outcome is not PASS, in summary order (the
  Overview's task order, then trial index). If the run has no such trial, the trial pane shows
  `No non-pass trial in this run` (for `run=session`, `No non-pass trial in this session`) and
  no trial header.
- `run=session`: the runs started by this local runner process. The UI builds it from
  `GET /api/runs`, which lists the runs the runner started since its process began, in start
  order; a runner restart empties it. On the hosted site, where there is no runner, the Runs
  view shows `No runs in this session`. Owner P15. It includes the P25c forced-fail smoke run
  (run id `smoke-<n>`, see "P25c follow-ups"), which is a valid FAIL, so `first-nonpass` can
  select it with the one definition above.

## Routes

| Route | Screen | Owner |
|---|---|---|
| `/` | App shell; key gate when no key is set | P13 |
| `/?view=overview` | Overview: one row per task of the official run | P14 |
| `/?view=tasks` | Tasks list | P14 |
| `/?view=tasks&task=renal-dose-review&tab=prompt` | Task prompt and Run trial | P14, P15 (Run trial) |
| `/?view=tasks&task=renal-dose-review&tab=policy` | Task policy text | P14 |
| `/?view=tasks&task=renal-dose-review&tab=chart` | Patient chart read from the FHIR store | P14 |
| `/?view=tasks&task=renal-dose-review&tab=rubric` | Rubric items with traces_to | P14 |
| `/?view=tasks&task=renal-dose-review&tab=reference-solution` | Reference solution steps and the oracle badge | P14 |
| `/?view=tasks&task=renal-dose-review&tab=grader-validation` | Matrix verdicts, the matrix count line and keyless oracle Run | P14 |
| `/?view=runs&run=final-1` | Runs, official run: header (k/N, pass definition, denominator rule), one row per task with its pass rate, one row per trial with attribution columns and reason | P14, P14a (reason) |
| `/?view=runs&run=final-1&trial=first-nonpass` | Trial detail with header (outcome, label, decisive check, reason), Grading tab | P16 |
| `/?view=runs&run=final-1&trial=first-nonpass&tab=grading` | Trial Grading tab: verdict chip, Score card, gate checks, rubric table | P16 |
| `/?view=runs&run=final-1&trial=first-nonpass&tab=attribution` | Trial Attribution tab, criteria table | P16 |
| `/?view=runs&run=final-1&trial=first-nonpass&tab=state-diff` | Trial State diff tab: initial hash against the manifest, then the diff | P16 |
| `/?view=runs&run=session&trial=first-nonpass` | First non-pass trial started by this local runner process | P15, P16 |
| `/?view=environment` | Environment: counts, tool catalogue, Try a tool, Verify reset | P14 |
| `/?view=glossary` | How failures are attributed (definitions) | P14 |
| `/?view=findings` | Findings, rendered from docs/findings.md and summary.json | P14, P24 (content) |
| `https://wth-lg.github.io/clinical-agent-env/` | Hosted Pages site, base URL | P25 |

## Strings on screen

Each string is the exact text the screen shows. Rows in trace.json name the snapshot it is
checked in. Where a pattern checks a value next to a label, the label and the value are in one
accessible name or text node, so they share one line of the snapshot.

### P13: shell, surface chip and key gate

- `Overview`, `Tasks`, `Runs`, `Findings`, `Environment`: the rail labels. All five show on
  every screen of the shell.
- `Add an API key`: the key gate heading, shown when no key is set and again after Forget key.
- `Local runner` and `Browser-direct`: the surface chip on the local runner and on the hosted
  site.

### P14: browse views

- `6 of 6 tasks in band`: the Overview band line. It reads `<k> of 6 tasks in band`, where k is
  the number of tasks whose pass rate is in 0.20-0.70 inclusive, so it shows exactly this text
  only when every task is in band. The count of tasks comes from the official run's summary.
- The pass rate is the text `<k>/<N> passed, Wilson 95% <lo>-<hi>%`, with k the passes out of N
  valid trials, N read from the run (never a constant), and lo and hi whole percentages joined
  by an ASCII hyphen. A 12-trial sample shows `/12`. It shows on each Overview task row, on the
  Runs header (over the whole run), on each per-task row of the Runs view and on each interval
  label of the Findings chart. Each task row and interval label holds the task id and its pass
  rate in one accessible name: `<task id> <k>/<N> passed, Wilson 95% <lo>-<hi>%`. The Runs
  header holds the run id and the whole run's pass rate in one accessible name:
  `<run id> <k>/<N> passed, Wilson 95% <lo>-<hi>%`. On final-1 N is 20 per task and 120 over
  the run, so the per-task patterns under Patterns keep `/20` and the header pattern `/120`.
  This replaces the P13
  placeholder copy in apps/web/src/shell/views.ts ("pass k of 10", "ten trial swatches"), which
  P14 removes.
- The six task ids, in Overview order: `renal-dose-review`, `results-inbox`, `crc-care-gap`,
  `discharge-medrec`, `contrast-ct-prep`, `message-queue`.
- The Runs view of a run lists every trial in one list, with no paging and no virtualized rows,
  so the snapshot holds every row.
- `claude-opus-5-5`: the model on the Runs header of the official run.
- The Runs attribution summary for a run reads `<m> model, <e> environment, <g> grader` over the
  valid non-pass trials, with a fault from an INTERNAL tool error counted as environment (P14a).
  Two patterns under Patterns check it on final-1.
- `Source: FHIR R4 store`: the caption on the task Chart tab, naming where the chart comes from.
- `fhir_search` and `order_medication`: tool names in the Environment tool catalogue.
- `18 tools`: the tool count on Environment (it equals the registry length; update both here and
  in trace.json if the registry changes).
- `exposed_ids`: a field of the Try a tool result.
- `matches the manifest`: the Verify reset result when the state hash equals the manifest, and
  the first line of a trial's State diff tab (P16) when the trial's initial state hash equals
  the manifest hash.
- `message-queue`: a task id in the Tasks list.
- `traces_to`: the rubric column that names the policy line each item enforces.
- `oracle PASS 1.0`: the keyless oracle result on Grader validation, and the oracle badge on the
  Reference solution tab.
- The Grader validation tab shows the line `matrix: <k>/<n> probe verdicts as expected`, over
  every probe of the task's matrix (alternatives and mutants). The pattern under Patterns needs
  k equal to n.
- `RBC-PHARM-07`: the policy id at the top of renal-dose-review's Policy tab, followed by the
  policy text (content from the task, P17i may revise it).
- `How failures are attributed`: the glossary page title and the link text that opens it.

### P14a, P16: reasons and attribution

- The reason on each non-pass row of the Runs view and in the trial header is the one sentence
  `explainTrial` returns. Every valid non-pass trial has one, in one of three forms:
  - a trial with a failed gate check (FAIL, or LIMIT or REFUSAL with a failed check):
    `<check id> failed: expected <value>, found <value>`, for the decisive check. A check id is
    the gate check's id as the task's grader names it, a letter then letters, digits or
    underscores (`G1`, `note_on_patient`). A value may hold commas.
  - a LIMIT with no failed gate check, by the limit that stopped the loop (packages/core/events.ts
    LIMITS): `turn limit reached: <n> turns`, `cost limit reached: $<v> of $<cap>`,
    `time limit reached: <s> s of <cap> s` or `output limit reached: <n> cut-off responses in a row`.
  - a REFUSAL with no failed gate check: `refused: <first words>`, the first 12 words of the
    model's refusal text.
  One pattern under Patterns matches all three forms.
- The Attribution tab's criteria table shows, for each criterion, the text `<id>: met` or
  `<id>: not met` (M1-M5), then its evidence; M5 shows `<id>: pending` on an unaudited trial, and
  M1 shows `M1: not applicable` on a trial with no failed gate check (a LIMIT or REFUSAL).
  Criterion sentences come from FAULT_DEFINITIONS and are not copied here, because
  scripts/test/one-definition.test.ts forbids them outside packages/core/outcomes.ts.
- `not human-audited`: the marker next to the fault label on a trial with no audit row (every
  live trial run from the UI). Every non-pass trial of final-1 is audited in P23, so the marker
  is checked on the first non-pass trial of `run=session`.
- The Score card on a trial's Grading tab and on a graded live trial reads `Score <s>`, with s the
  score from 0.00 to 1.00 in two decimals. The empty states show the title `Score` with no
  value, which the pattern does not match.

### P15: live trial

- `claude-opus-5-5`: the model shown in the Run launcher.
- The spend meter in the top bar reads `Session spend $<a> of $<b> cap`, both in dollars with two
  decimals, b the session cap.

### P25: hosted site

- `Browser-direct`: the surface chip on the hosted site (P13 renders it).
- `pnpm start`: part of LOCAL_START_COMMAND, which the hosted key gate shows with its copy
  button when the key's organization blocks browser calls.

## Patterns

Regular expressions (JavaScript syntax) that `ax_match` expects use. `min_matches` in trace.json
says how many times each must match in the snapshot (default 1). Each pattern names one item,
so a repeated item cannot meet the count of another.

- One task's pass rate on final-1, one pattern per task (owner P14):
  `\brenal-dose-review\b[^\n]*\b(?:[0-9]|1[0-9]|20)/20 passed, Wilson 95% [0-9]{1,3}-[0-9]{1,3}%`,
  `\bresults-inbox\b[^\n]*\b(?:[0-9]|1[0-9]|20)/20 passed, Wilson 95% [0-9]{1,3}-[0-9]{1,3}%`,
  `\bcrc-care-gap\b[^\n]*\b(?:[0-9]|1[0-9]|20)/20 passed, Wilson 95% [0-9]{1,3}-[0-9]{1,3}%`,
  `\bdischarge-medrec\b[^\n]*\b(?:[0-9]|1[0-9]|20)/20 passed, Wilson 95% [0-9]{1,3}-[0-9]{1,3}%`,
  `\bcontrast-ct-prep\b[^\n]*\b(?:[0-9]|1[0-9]|20)/20 passed, Wilson 95% [0-9]{1,3}-[0-9]{1,3}%`,
  `\bmessage-queue\b[^\n]*\b(?:[0-9]|1[0-9]|20)/20 passed, Wilson 95% [0-9]{1,3}-[0-9]{1,3}%`.
- `\b[1-9][0-9]* model, 0 environment, 0 grader\b`: the Runs attribution summary with at least
  one model failure and no environment or grader failure (row W6). Owner P14, data from P23.
- `\b[0-9]+ model, 0 environment, 0 grader\b`: the whole Runs attribution summary with no
  environment or grader failure (row W7). It is anchored at the model count, so
  `3 model, 10 environment, 0 grader` does not match. Owner P14, data from P23.
- One row of the Attribution criteria table on an audited trial, one pattern per criterion
  (owner P16): `\bM1: (?:met|not met)\b`, `\bM2: (?:met|not met)\b`, `\bM3: (?:met|not met)\b`,
  `\bM4: (?:met|not met)\b`, `\bM5: (?:met|not met)\b`.
- `\b(?:[A-Za-z][A-Za-z0-9_]* failed: expected [^\n]+?, found |(?:turn|cost|time|output) limit reached: |refused: )`:
  a reason in any of the three forms under "P14a, P16: reasons and attribution". Row U31 needs
  it once on the Runs view and once in the trial header; `U31-reason-count.txt` checks that
  every valid non-pass row shows one. Owner P14a (text), P14 and P16 (rendering).
- `\bfinal-1 (?:[0-9]|[1-9][0-9]|1[01][0-9]|120)/120 passed, Wilson 95% [0-9]{1,3}-[0-9]{1,3}%`:
  the Runs header of final-1 with the whole run's pass rate (row U28). The per-task rows do not
  match it. Owner P14.
- `\bmatrix: ([0-9]+)/\1 probe verdicts as expected\b`: the Grader validation count line with
  every probe as expected. Owner P14.
- `\bScore (?:0\.[0-9]{2}|1\.00)\b`: a Score card with a value. Owner P16 (trial), P15 (live).
- `\bSession spend \$[0-9]+\.[0-9]{2} of \$[0-9]+\.[0-9]{2} cap\b`: the spend meter. Owner P15.

## Result lines in P25c evidence files

P25c writes these files under `verifier-phase-P25c-1/` in the run's evidence directory. Each
holds the exact line below when the check passes.

- `U2-rail-reach.txt`: for each trace row with a `ui`, on the surface it names, P25c starts at
  `/` and reaches the row's route by clicking the rail and links on screen only (no typed URL,
  no CLI). One line per row, `<id> <route>: <click path>` or `<id> <route>: not reached`, then a
  last line `rows not reached from the rail: <n>`. The expect is
  `rows not reached from the rail: 0`.
- `U25-needs-actions.txt`: for each N row, the action P25c did in the UI and what the screen
  showed, one line per row, `<id>: <action> -> <result>` or `<id>: not actionable in the UI`,
  then a last line `N rows not actionable in the UI: <n>`. The expect is
  `N rows not actionable in the UI: 0`.
- `U33-ui-audit.txt`, from P25c step (3): a table of every deviation (screen, screenshot,
  severity). The audit's scope is layout, density, clarity, palette (stone neutrals and one blue
  accent near #5C85FB, no other colour), logos (none) and font (the self-hosted OFL font). A deviation is open when its severity is must-fix and no retaken screenshot shows
  it fixed. The last line is `must-fix open: <n>`. The expect is `must-fix open: 0`.
- `U14-storage-count.txt`, from the devtools snippet after Forget key, run on both surfaces: the
  lines `local runner: sk-ant- values in storage: <n>` and
  `hosted site: sk-ant- values in storage: <n>`, each counted over localStorage, sessionStorage
  and every IndexedDB store, never the values. The expects are
  `local runner: sk-ant- values in storage: 0` and `hosted site: sk-ant- values in storage: 0`.
- `U6-phase-verdicts.txt`: one line per plan phase before P25c with its verifier report path and
  verdict, then a last line `phases without a VERIFIED report: <n>`. The expect is
  `phases without a VERIFIED report: 0`. P25c writes it so that `trace-check --final` in the
  P25c gate can read it; P26 checks the phases after it.
- `U31-reason-count.txt`: three lines. `valid non-pass trials in final-1: <n>`, with n from
  results/runs/final-1/summary.json (valid trials minus passes, summed over the six tasks);
  `non-pass rows with a reason on Runs: <m>`, with m the non-pass rows of
  `U31-runs-why-failed.ax.txt` that match the reason pattern under Patterns; then a last line
  `non-pass rows without a reason: <n-m>`. The expect is `non-pass rows without a reason: 0`.

## Writeup (P24)

docs/writeup.html carries these `<h2>` headings, exactly, and `pnpm docs:check` requires them in
its section list. The Findings view shows the same sections from docs/findings.md.

- `What is new in this design`: exposure-tagged tools, the grader validation matrix and the
  attribution criteria (rows A6, U27; checked with `grep -qF '>What is new in this design</h2>'
  docs/writeup.html` and on the Findings screen).
- `Audit against research and public environments`: one entry per P17r item and what P17i did
  with it (row U32; checked with grep on docs/writeup.html).
- `Surprises`, `Changes`, `Next steps`: shown on the Findings screen (row W10) as well as in the
  writeup.

## P25c follow-ups

The coordinator pastes this section into the P25c brief, and the "Other phases" lines into the
briefs they name. Every file below goes under `verifier-phase-P25c-1/` in the run's evidence
directory, under exactly this name, or `trace-check --final` reports it missing.

### Steps P25c adds

1. Step (1), on the hosted site, takes the snapshots of rows on surface `any` or `hosted` only;
   it skips rows on surface `local`, whose snapshots step (2) takes.
2. Forced-fail smoke trial: on the local runner, after the six live trials, P25c starts one
   smoke trial through the mocked Messages client that `runner-check --mock` uses (P15 exposes
   it on the runner when it starts with `CLINENV_FORCED_FAIL=1`), scripted to end without the
   task's required order, so its gate fails with no live call and no spend. The mock reports
   `claude-opus-5-5` as its response model, so models_returned is [claude-opus-5-5], the
   record is valid and its outcome is FAIL on the gate (an unexpected model would make it
   INVALID, which `first-nonpass` skips). This makes `run=session&trial=first-nonpass` land on a
   valid non-pass trial with no audit row whatever the six live trials did, so U23's
   `not human-audited` check is deterministic, with the one definition of `first-nonpass`.
   The model does not mark it as a smoke run; these do: its run id starts `smoke-` (`smoke-<n>`),
   its record carries the field `mock: true`, and it has no ledger rows. The P25c gate's check
   of "six records, each with models_returned [claude-opus-5-5]" and its match of ledger
   settle rows to trial records count only records without `mock: true`, so the smoke record
   is not one of the six. The record lives only in the runner's session store, the
   CLINENV_RUNS_DIR of the P25c session in the audited clone; it is never written under
   results/, and P25c never commits it (`git -C <clone> status --porcelain` stays empty).
3. Each command-output file: run the command from the root of the audited clone, and save its
   full output and a last line `exit: <code>`. Where a file names two commands, run them in
   order into the same file.
4. Each result-line file: write it as "Result lines in P25c evidence files" above says.

### Command-output files (36)

- A1: `A1-final-run-summary.txt` from `pnpm cli summary results/runs/final-1 --require valid=20,band=0.2-0.7,env_error_raw=0,grader_error=0,model=claude-opus-5-5,replay=all`
- A2: `A2-docs-check.txt` from `pnpm docs:check`
- N5: `N5-matrix-all.txt` from `pnpm cli matrix --task all`
- N8: `N8-oracle-all.txt` from `pnpm cli oracle --task all`
- N11: `N11-run-one-test.txt` from `pnpm vitest run packages/core/test/loop-run-one`
- N13: `N13-state-hash-test.txt` from `pnpm cli replay results/runs/final-1` then `pnpm vitest run packages/env/test/state-hash packages/env/test/hash`
- W1: `W1-final-run-summary.txt` from `pnpm cli summary results/runs/final-1 --require band=0.2-0.7`
- W2: `W2-final-run-summary.txt` from `pnpm cli summary results/runs/final-1 --require model=claude-opus-5-5,band=0.2-0.7`
- W3: `W3-final-run-summary.txt` from `pnpm cli summary results/runs/final-1 --require band=0.2-0.7`
- W4: `W4-replay-summary.txt` from `pnpm cli replay results/runs/final-1 && pnpm cli summary results/runs/final-1 --require model=claude-opus-5-5,replay=all,valid=20`
- W5: `W5-summary-valid.txt` from `pnpm cli summary results/runs/final-1 --require valid=20`
- W6: `W6-audit-check.txt` from `pnpm cli audit-check results/runs/final-1`
- W7: `W7-summary-faults.txt` from `pnpm cli summary results/runs/final-1 --require grader_error=0,env_error_raw=0`
- W7: `W7-audit-check.txt` from `pnpm cli audit-check results/runs/final-1`
- H1: `H1-replay-final.txt` from `pnpm cli replay results/runs/final-1`
- H2: `H2-docs-check.txt` from `pnpm docs:check`
- U5: `U5-docs-check-references.txt` from `pnpm docs:check`
- U6: `U6-donewhen.txt` from `pnpm donewhen`
- U8: `U8-ledger-tests.txt` from `pnpm vitest run packages/core/test/ledger cli/adapters/test/ledger-node`
- U9: `U9-runner-tests.txt` from `pnpm vitest run apps/runner`
- U10: `U10-final-run-efforts.txt` from `test "$(ls -d results/runs/final-1/trials/*/claude-opus-5-5/* | xargs -n1 basename | sort -u)" = high`
- U11: `U11-tokens-test.txt` from `pnpm vitest run apps/web/test/tokens`
- U13: `U13-same-path.txt` from `pnpm --filter web exec playwright test same-path.spec.ts`
- U15: `U15-ledger-tests.txt` from `pnpm vitest run packages/core/test/ledger apps/web/test/ledger-browser`
- U18: `U18-judge-tests.txt` from `pnpm vitest run packages/grader/test/judge`
- U19: `U19-no-company-names.txt` from `pnpm vitest run scripts/test/no-company-names`
- U20: `U20-ledger-cost-tests.txt` from `pnpm vitest run packages/core/test/ledger-cost`
- U21: `U21-final-run-summary.txt` from `pnpm cli summary results/runs/final-1 --require valid=20,band=0.2-0.7`
- U22: `U22-ledger-cap-tests.txt` from `pnpm vitest run packages/core/test/ledger-cost packages/core/test/ledger-admission`
- U24: `U24-trace-check.txt` from `pnpm cli trace-check`
- U25: `U25-trace-check-tests.txt` from `pnpm vitest run cli/test/trace-check`
- U26: `U26-final-run-summary.txt` from `pnpm cli summary results/runs/final-1 --require band=0.2-0.7`
- U29: `U29-summary-valid-20.txt` from `pnpm cli summary results/runs/final-1 --require valid=20`
- U32: `U32-matrix-after-audit.txt` from `pnpm cli matrix --task all`
- U32: `U32-writeup-audit.txt` from `grep -qF '>Audit against research and public environments</h2>' docs/writeup.html`
- U34: `U34-docs-check.txt` from `pnpm docs:check`

### Result-line files (6)

`U2-rail-reach.txt`, `U25-needs-actions.txt`, `U33-ui-audit.txt`, `U14-storage-count.txt`,
`U6-phase-verdicts.txt`, `U31-reason-count.txt`.

### Snapshots on the hosted site, step (1)

Each row's screenshot (.png) and accessibility snapshot (.ax.txt), taken on its `ui.route`.

- A3 (any): `A3-environment-fhir-store.png`, `A3-environment-fhir-store.ax.txt`
- A4 (any): `A4-task-chart.png`, `A4-task-chart.ax.txt`
- A5 (any): `A5-environment-try-search-notes.png`, `A5-environment-try-search-notes.ax.txt`
- A6 (any): `A6-findings-design.png`, `A6-findings-design.ax.txt`
- N1 (any): `N1-environment-try-tool.png`, `N1-environment-try-tool.ax.txt`
- N2 (any): `N2-environment-tool-catalogue.png`, `N2-environment-tool-catalogue.ax.txt`
- N3 (any): `N3-environment-tool-count.png`, `N3-environment-tool-count.ax.txt`
- N4 (any): `N4-tasks-list.png`, `N4-tasks-list.ax.txt`
- N5 (any): `N5-task-grader-validation-all.png`, `N5-task-grader-validation-all.ax.txt`
- N6 (any): `N6-task-rubric.png`, `N6-task-rubric.ax.txt`
- N7 (any): `N7-trial-grading.png`, `N7-trial-grading.ax.txt`
- N8 (any): `N8-task-reference-solution.png`, `N8-task-reference-solution.ax.txt`
- N9 (any): `N9-task-grader-validation-oracle.png`, `N9-task-grader-validation-oracle.ax.txt`
- N12 (any): `N12-environment-verify-reset.png`, `N12-environment-verify-reset.ax.txt`
- N13 (any): `N13-trial-state-diff.png`, `N13-trial-state-diff.ax.txt`
- N14 (any): `N14-app-shell.png`, `N14-app-shell.ax.txt`
- W1 (any): `W1-overview-band.png`, `W1-overview-band.ax.txt`
- W2 (any): `W2-overview-band.png`, `W2-overview-band.ax.txt`
- W3 (any): `W3-overview-band.png`, `W3-overview-band.ax.txt`
- W4 (any): `W4-runs-official.png`, `W4-runs-official.ax.txt`
- W5 (any): `W5-overview-pass-rates.png`, `W5-overview-pass-rates.ax.txt`
- W6 (any): `W6-runs-labels.png`, `W6-runs-labels.ax.txt`
- W7 (any): `W7-runs-no-env-grader-fault.png`, `W7-runs-no-env-grader-fault.ax.txt`
- W8 (any): `W8-trial-attribution-criteria.png`, `W8-trial-attribution-criteria.ax.txt`
- W9 (any): `W9-findings.png`, `W9-findings.ax.txt`
- W10 (any): `W10-findings-next.png`, `W10-findings-next.ax.txt`
- H1 (any): `H1-task-prompt.png`, `H1-task-prompt.ax.txt`
- U2 (any): `U2-overview.png`, `U2-overview.ax.txt`
- U3 (any): `U3-key-gate.png`, `U3-key-gate.ax.txt`
- U4 (any): `U4-task-policy.png`, `U4-task-policy.ax.txt`
- U7 (hosted): `U7-hosted-overview.png`, `U7-hosted-overview.ax.txt`
- U11 (any): `U11-overview-style.png`, `U11-overview-style.ax.txt`
- U15 (any): `U15-spend-meter.png`, `U15-spend-meter.ax.txt`
- U16 (hosted): `U16-hosted-key-gate.png`, `U16-hosted-key-gate.ax.txt`
- U21 (any): `U21-overview-k-of-20.png`, `U21-overview-k-of-20.ax.txt`
- U26 (any): `U26-overview-band.png`, `U26-overview-band.ax.txt`
- U27 (any): `U27-findings-design.png`, `U27-findings-design.ax.txt`
- U28 (any): `U28-runs-header.png`, `U28-runs-header.ax.txt`
- U30 (any): `U30-trial-attribution-criteria.png`, `U30-trial-attribution-criteria.ax.txt`
- U31 (any): `U31-runs-why-failed.png`, `U31-runs-why-failed.ax.txt`, `U31-trial-attribution-header.png`, `U31-trial-attribution-header.ax.txt`
- U33 (any): `U33-overview-ui-review.png`, `U33-overview-ui-review.ax.txt`

### Snapshots on the local runner, step (2)

- N10 (local): `N10-live-trial-graded.png`, `N10-live-trial-graded.ax.txt`
- N11 (local): `N11-run-launcher-model.png`, `N11-run-launcher-model.ax.txt`
- U1 (local): `U1-run-launcher-model.png`, `U1-run-launcher-model.ax.txt`
- U12 (local): `U12-local-overview.png`, `U12-local-overview.ax.txt`
- U13 (local): `U13-live-trial-runner.png`, `U13-live-trial-runner.ax.txt`
- U14 (local): `U14-key-gate-local.png`, `U14-key-gate-local.ax.txt`
- U17 (local): `U17-local-live-trial.png`, `U17-local-live-trial.ax.txt`
- U23 (local): `U23-local-live-trial.png`, `U23-local-live-trial.ax.txt`, `U23-local-key-forgotten.png`, `U23-local-key-forgotten.ax.txt`

### Other phases

Strings this file names that no merged code renders or serves yet, with the phase that builds
each (apps/runner does not exist yet):

| String | Owner |
|---|---|
| `GET /api/runs` and the `run=session` token | P15 |
| `CLINENV_FORCED_FAIL=1` and the smoke run (`smoke-<n>`, `mock: true`, model `claude-opus-5-5`) | P15 |
| the spend meter, `Session spend $<a> of $<b> cap` | P15 |
| the matrix count line, `matrix: <k>/<n> probe verdicts as expected` | P14 |
| the Runs header, `<run id> <k>/<N> passed, Wilson 95% <lo>-<hi>%` | P14 |
| the three reason forms, including `turn limit reached: <n> turns` and `refused: <first words>` | P14a |
| the Score card value, `Score <s>` | P16 |
| `U31-reason-count.txt` | P25c |

- P14: render the matrix count line, the oracle badge on Reference solution, the per-task pass
  rate rows and the Runs header with N read from the run, the Runs list with no paging, and the
  W7 summary text, as this file says.
- P14a: `explainTrial` returns a reason for every valid non-pass trial, in the three forms under
  "P14a, P16: reasons and attribution"; a LIMIT or REFUSAL with no failed gate check gets the
  limit or refusal sentence.
- P14 or P17i: confirm that renal-dose-review's Policy tab starts with `RBC-PHARM-07`, or switch
  row U4 to a dosing-criterion string from the policy.
- P15: serve `GET /api/runs` (the runs this runner process started) and resolve `run=session`
  from it; add the forced-fail smoke trial behind `CLINENV_FORCED_FAIL=1`, whose mock reports
  `claude-opus-5-5` and whose record has run id `smoke-<n>` and `mock: true`, is written only
  under CLINENV_RUNS_DIR and writes no ledger rows; render the spend meter text.
- P17: name each gate check with an id that matches `[A-Za-z][A-Za-z0-9_]*`, as the reason
  pattern needs.
- P16: render the trial tabs as listed under Query parameters (`grading` the default), the
  Score value, the empty first-nonpass text and the State diff manifest line.
- P24: add `What is new in this design` and `Audit against research and public environments`
  to the section list `pnpm docs:check` requires.
- P22: check the hosted site at `https://wth-lg.github.io/clinical-agent-env/`, not the old
  Pages URL.
