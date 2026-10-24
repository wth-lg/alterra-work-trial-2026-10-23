# UI contract

The routes, query parameters and exact strings that the expects in `docs/requirements/trace.json`
depend on, each with the plan phase that owns it. The P14, P14a, P15, P16, P24 and P25c briefs
quote this file. A phase that renders one of these strings renders it exactly as written here
(case, spacing and punctuation), because the final audit (P25c) checks it by substring or by
regular expression in the accessibility snapshot.

`pnpm cli trace-check` reads this file. Every `ui.route`, every `ax_text` text and every
`ax_match` pattern in trace.json must appear here as a backticked string, or the check fails.
To change a string, change it here and in trace.json in the same commit.

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
| `tab` | on a task: `prompt`, `policy`, `chart`, `rubric`, `reference-solution`, `grader-validation`; on a trial: `attribution` and the other trial-detail tabs P16 names | P14 (task tabs), P16 (trial tabs) |
| `run` | a run id, for example `final-1`, or the token `session` | P14, P15 (`session`) |
| `trial` | a trial id, or the token `first-nonpass` or `latest` | P16 |

Every parameter round-trips: opening the URL shows the same screen, and moving between screens
updates the URL. An unknown value falls back to the default view and does not error.

### Tokens

A route never holds a placeholder such as `<trial>`; `trace-check --final` fails on `<` in a
route. A route that needs a run-specific trial uses a token that the UI resolves:

- `trial=first-nonpass`: the first valid trial whose outcome is not PASS, in summary order (the
  Overview's task order, then trial index). If the run has no such trial, the view says so.
- `run=session`: the runs started from this browser session on this surface (the live runs).
- `trial=latest`: the most recently started trial of the selected run.

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
| `/?view=tasks&task=renal-dose-review&tab=reference-solution` | Reference solution steps | P14 |
| `/?view=tasks&task=renal-dose-review&tab=grader-validation` | Matrix verdicts and keyless oracle Run | P14 |
| `/?view=runs&run=final-1` | Runs, official run, attribution columns and reason | P14, P14a (reason) |
| `/?view=runs&run=final-1&trial=first-nonpass` | Trial detail with header (outcome, label, decisive check, reason) | P16 |
| `/?view=runs&run=final-1&trial=first-nonpass&tab=attribution` | Trial Attribution tab, criteria table | P16 |
| `/?view=runs&run=session&trial=latest` | Latest live trial of this session | P15, P16 |
| `/?view=environment` | Environment: counts, tool catalogue, Try a tool, Verify reset | P14 |
| `/?view=glossary` | How failures are attributed (definitions) | P14 |
| `/?view=findings` | Findings, rendered from docs/findings.md and summary.json | P14, P24 (content) |
| `https://wth-lg.github.io/clinical-agent-env/` | Hosted Pages site, base URL | P25 |

## Strings on screen

Each string is the exact text the screen shows. Rows in trace.json name the snapshot it is
checked in.

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
- The pass rate on each Overview task row, on each task row of the Runs view for a selected run,
  and on each interval label of the Findings chart is the text
  `<k>/20 passed, Wilson 95% <lo>-<hi>%`, with k the passes out of 20 valid trials and lo and hi
  whole percentages joined by an ASCII hyphen. The pattern is listed under Patterns. This
  replaces the P13 placeholder copy in apps/web/src/shell/views.ts ("pass k of 10", "ten trial
  swatches"), which P14 removes.
- `claude-opus-5-5`: the model on the Runs header of the official run.
- `0 environment, 0 grader`: part of the Runs attribution summary for a run, which reads
  `<m> model, <e> environment, <g> grader` over the valid non-pass trials.
- `Source: FHIR R4 store`: the caption on the task Chart tab, naming where the chart comes from.
- `fhir_search` and `order_medication`: tool names in the Environment tool catalogue.
- `18 tools`: the tool count on Environment (it equals the registry length; update both here and
  in trace.json if the registry changes).
- `exposed_ids`: a field of the Try a tool result.
- `matches the manifest`: the Verify reset result when the state hash equals the manifest.
- `message-queue`: a task id in the Tasks list.
- `traces_to`: the rubric column that names the policy line each item enforces.
- `oracle PASS 1.0`: the keyless oracle result on Grader validation.
- `RBC-PHARM-07`: the policy id at the top of renal-dose-review's Policy tab, followed by the
  policy text (content from the task, P17i may revise it).
- `How failures are attributed`: the glossary page title and the link text that opens it.

### P14a, P16: reasons and attribution

- The reason on each non-pass row of the Runs view and in the trial header is the one sentence
  `explainTrial` returns, which starts `<check id> failed: expected <value>, found <value>`. The
  pattern is listed under Patterns.
- The Attribution tab's criteria table shows, for each criterion, the text `<id>: met` or
  `<id>: not met` (M1-M5), then its evidence; M5 shows `<id>: pending` on an unaudited trial.
  Criterion sentences come from FAULT_DEFINITIONS and are not copied here, because
  scripts/test/one-definition.test.ts forbids them outside packages/core/outcomes.ts.
- `not human-audited`: the marker next to the fault label on a trial with no audit row (every
  live trial run from the UI). Every non-pass trial of final-1 is audited in P23, so the marker
  is checked on a live trial of `run=session`.
- `Score`: the Score card title on a trial's Grading tab and on a graded live trial.

### P15: live trial

- `claude-opus-5-5`: the model shown in the Run launcher.

### P25: hosted site

- `Browser-direct`: the surface chip on the hosted site (P13 renders it).
- `pnpm start`: part of LOCAL_START_COMMAND, which the hosted key gate shows with its copy
  button when the key's organization blocks browser calls.

## Patterns

Regular expressions (JavaScript syntax) that `ax_match` expects use. `min_matches` in trace.json
says how many times each must match in the snapshot.

- `\b(?:[0-9]|1[0-9]|20)/20 passed, Wilson 95% [0-9]{1,3}-[0-9]{1,3}%`: one task's pass rate
  (6 matches: one per task). Owner P14.
- `\b[1-9][0-9]* model, 0 environment, 0 grader\b`: the Runs attribution summary with at least
  one model failure and no environment or grader failure. Owner P14, data from P23.
- `\bM[1-5]: (?:met|not met)\b`: one row of the Attribution criteria table on an audited trial
  (5 matches: M1-M5). Owner P16.
- `\b[A-Z]+[0-9]+ failed: expected [^,\n]+, found `: a reason naming the decisive check, its
  expected value and what was found. Owner P14a (text), P14 and P16 (rendering).

## Result lines in P25c evidence files

P25c writes these files under `verifier-phase-P25c-1/` in the run's evidence directory. Each
holds the exact line below when the check passes.

- `U33-ui-audit.txt`, from P25c step (3): a table of every deviation (screen, screenshot,
  severity) and a last line `must-fix open: <n>`. The expect is `must-fix open: 0`.
- `U14-storage-count.txt`, from the devtools snippet after Forget key on the local runner: the
  line `sk-ant- values in storage: <n>`, counted over localStorage, sessionStorage and every
  IndexedDB store, never the values. The expect is `sk-ant- values in storage: 0`.
- `U6-phase-verdicts.txt`: one line per plan phase before P25c with its verifier report path and
  verdict, then a last line `phases without a VERIFIED report: <n>`. The expect is
  `phases without a VERIFIED report: 0`. P25c writes it so that `trace-check --final` in the
  P25c gate can read it; P26 checks the phases after it.

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
