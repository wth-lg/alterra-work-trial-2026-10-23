# Requirement source

Every sentence of the assignment's four sections, verbatim and in reading order, then every user
modification. Each line is one sentence with its id: the section letter (A, N, W, H, U) plus the
sentence's ordinal in that section. A bold lead-in such as "Something to act on." is its own
line. The cover page and the page headers and footers are left out.

`docs/requirements/trace.json` maps each id to code, tests, a UI screen and action, evidence and
an owning plan phase. `pnpm cli trace-check` fails when an id has no row, when a line holds more
than one sentence, when ids skip, or when a line changes and its row's `text_sha256` does not.

## A. The assignment

- **A1** Build a clinical environment an agent can act in, put a few tasks in it, and run Opus 5 against them.
- **A2** The shape is open.
- **A3** A bash container with MCP tools over a FHIR server.
- **A4** A mock EHR behind a handful of endpoints.
- **A5** A pile of clinical notes the agent has to search.
- **A6** Something we haven't thought of.

## N. What it needs

- **N1** Something to act on.
- **N2** State the agent can read and change, reachable only through a set of tools you define.
- **N3** A handful of tools is plenty — ours run from three to about forty.
- **N4** A few tasks.
- **N5** Enough that your design has to hold up past the first one.
- **N6** A grader.
- **N7** Something that turns a finished run into a score.
- **N8** A reference solution.
- **N9** A deterministic path through each task that earns full marks, so the task is known to be solvable and the grader is known to recognise a correct answer when it sees one.
- **N10** A way to run it.
- **N11** One entry point that takes a task and a model and hands back a result.
- **N12** Repeatable state.
- **N13** Every trial starts from the same place.
- **N14** A human-facing UI is out of scope.

## W. What we want to see

- **W1** Tasks pitched at the right difficulty.
- **W2** Opus 5 should pass somewhere between two and seven times out of ten.
- **W3** A task it always passes, or never passes, tells you nothing about the model.
- **W4** Real runs.
- **W5** Ten trials per task, and the pass rates that came out of them.
- **W6** Failures that are the model's fault.
- **W7** When a run fails we want that to be because the task was hard, not because the environment fell over or the grader was wrong.
- **W8** Show us how you told those apart.
- **W9** What you found.
- **W10** What surprised you, what you'd change, what you'd do next with more time.

## H. Handing it over

- **H1** The environment, and for each task the prompt, the grader and whatever rubric sits behind it, the reference solution, and the trajectories from your runs.
- **H2** Plus a writeup, in whatever form suits you.

## U. User modifications

Quoted from the run's request, the plan's user decisions (1)-(6), the user rows of the decision
log and the user addendum of 2026-10-24 (a)-(e). The API key is named only as "the temporary org
key"; a bracketed note under a line says where a quote replaces a name.

- **U1** "Opus 5" in the assignment means claude-opus-5-5 (user instruction).
  - from: run request, Assumptions; addendum (b) "Opus 5 = claude-opus-5-5"
- **U2** a human-facing UI is the main platform the interviewer operates
  - from: run request, user additions; supersedes N14
- **U3** only inputs are an Anthropic API key entered in the UI and internet access
  - from: run request, user additions
- **U4** realism over literal reading
  - from: run request, user additions
- **U5** latest (2025-2026) clinical research, datasets, rubrics and FHIR/MCP tooling, cited in README.md
  - from: run request, user additions (the plan moves the dated reference list to docs/writeup.html, addendum (e))
- **U6** every decision verified
  - from: run request, user additions
- **U7** hosting = GitHub Pages from a PUBLIC repo wth-lg/clinical-agent-env, deployed by Actions on merge to main
  - from: plan decision (1) [repo name as renamed on 2026-10-24, U19]
- **U8** all our runs use the temporary org key; the spend ledger has a projected cap and a hard actual cap: refuse a batch whose projection would cross PROJECTED_CAP_USD, stop at ACTUAL_CAP_USD actual
  - from: plan decision (2) [key name replaced]; values raised on 2026-10-24, U22
- **U9** superseded by (6): it said that if a real browser cannot POST to the Anthropic API, live runs are CLI-only, no relay
  - from: plan decision (3)
- **U10** headline effort = high
  - from: plan decision (4)
- **U11** UI accent = stone neutrals + one blue near #5C85FB, no logos, no licensed fonts
  - from: plan decision (5)
- **U12** the UI is the main surface and runs on a local machine with internet; one documented command from a clean clone (Node and pnpm assumed installed) starts a local Node runner that serves the built UI and exposes a local HTTP API with Server-Sent Events
  - from: plan decision (6), P2 checkpoint 2026-10-23; supersedes N14 and U9
- **U13** Run in the UI posts to the runner (same origin), which executes the trial in Node through the same packages/core run() path as the CLI and streams trajectory events and the graded result back
  - from: plan decision (6)
- **U14** the key typed into the UI goes only to the runner (bound to 127.0.0.1, never logged, held in memory) and from there only to api.anthropic.com
  - from: plan decision (6)
- **U15** every live call still goes through the P1 ledger and UI batches use the same caps
  - from: plan decision (6)
- **U16** the hosted Pages build stays as a secondary surface (browse, replay, grading, and browser-direct live runs only when the key's org allows browser access, otherwise the exact local command)
  - from: plan decision (6)
- **U17** Live demo runs through the local runner (P12b) serving the same web UI; the Pages link is browse and replay only; no relay
  - from: decision log, user, 2026-10-23 18:40
- **U18** judge could spend a little more, 0.06 seems a bit low, we can push it to $1 if needed
  - from: decision log, user, 2026-10-23 23:36 (JUDGE_MAX_CALL_USD)
- **U19** Rename repo to clinical-agent-env; rename the company identifiers in code (prefix clinenv)
  - from: decision log, user, 2026-10-24 00:29 [the company's short name replaced]; the public repo names no company
- **U20** pilot-0 exempt from --final-reserve: runs under hard ledger caps only; from P11 the final reserve uses pilot-0 measured p90
  - from: decision log, user, 2026-10-24T08:15:50Z
- **U21** Let's do 20 trials per task and then just keep a 20% to 70% pass rate
  - from: decision log, user, 2026-10-24T08:21:18Z; amends W2 and W5
- **U22** You can keep the projected cap under $1,000
  - from: decision log, user, 2026-10-24T08:22:34Z (PROJECTED_CAP_USD and ACTUAL_CAP_USD)
- **U23** final audit with the computer-use tool (orca computer) on this machine: drive the GitHub Pages site and the local app with the temporary org key
  - from: addendum (a) [key name replaced]; decision log, user, 2026-10-24T08:16:44Z
- **U24** trace every requirement and criterion of the assignment PDF (plus user modifications: Opus 5 = claude-opus-5-5, the UI as main surface) to evidence
  - from: addendum (b)
- **U25** 'What it needs' (each item actionable in the UI)
  - from: addendum (b)
- **U26** difficulty pitched right
  - from: addendum (b), 'What we want to see'
- **U27** a novel and clever design
  - from: addendum (b), 'What we want to see'
- **U28** real runs with pass rates clearly shown
  - from: addendum (b), 'What we want to see'
- **U29** possibly more than 10 trials per task
  - from: addendum (b), 'What we want to see'; decision log, user, 2026-10-24T08:16:44Z "trials per task may exceed 10"
- **U30** model-fault failures told apart from environment/grader faults with explicit criteria
  - from: addendum (b), 'What we want to see'
- **U31** the UI saying at once why each failure happened
  - from: addendum (b), 'What we want to see'
- **U32** audit tools, tasks (sense against the FHIR store and mock EHR), grader (professional clinical criteria), reference solution, run path and repeatable state against current research and public agent-environment repos
  - from: addendum (c)
- **U33** UI user-friendly and elegant vs enterprise-main
  - from: addendum (d)
- **U34** final writeup = one .html instruction/writeup file + a short root README.md with only what the interviewer needs to run it, both in ASD-STE 100
  - from: addendum (e)
