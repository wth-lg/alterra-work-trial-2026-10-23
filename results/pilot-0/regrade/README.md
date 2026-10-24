# pilot-0 regrade (offline)

The three pilot-0 trials in `../trials/` regraded with the T1 grader at wth-lg/p10-t1 452c52f. No trial was run again and no API call was made: each regrade answers judge items only from the trial record's own judge cache, with no client.

How: each trajectory in `../trajectories/` is replayed in the environment the trial ran in (fixtures/world.ndjson.gz and tasks/ at 6c709c2, world state hash f8387483...a648, RBC-PHARM-07 v3), the replay reaches the record's final state hash, and the final state is graded with the current `tasks/renal-dose-review/tests/grader.ts`. The script is evidence/builder-39/regrade-pilot0.ts in the run ledger; its output is evidence/builder-39/pilot0-regrade.2.txt.

What changed between the recorded grade and this one:
- task_version 05264c371b03... -> 9cccf3d4d073... The task files changed (G1 grades the clinical dose in mg whichever tablet makes it up; note_uses_wrong_scr asks the judge to confirm a flagged value; RBC-PHARM-07 v4 wording and citations; overlay chart hygiene), and so did the world (state hash ebe40e00...fdf8a).
- grader_version 3 -> 4: packages/grader/normalize.ts converts a tablet or capsule dose to mg through the product's strength.

| Trial | Recorded | Regraded | Checks that changed |
|---|---|---|---|
| 0 | PASS 1.000 | PASS 1.000 | none |
| 1 | PASS 1.000 | PASS 1.000 | none |
| 2 | PASS 1.000 | PASS 1.000 | none |

Each trial ordered the apixaban 5 mg tablet in mg, so the G1 change does not apply to it. None of the notes states 1.88 or 1.71 as the current SCr, so note_uses_wrong_scr flags nothing and needs no judge answer. The old extractor answer for that item is still in each record's cache but is no longer asked, which is why judge.calls (the API calls recorded on the cached answers used) drops by one.
