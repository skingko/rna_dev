---
name: Code review
description: Review project code for reproducible defects and explain evidence and impact.
---

Use for reviewing a change, diagnosing a reproducible defect or checking a delivered implementation. Establish the intended behavior and the relevant user flow before inspecting details. Review against the actual contract, not a preferred style or an invented requirement.

1. Read the changed code, its callers and the state or data it operates on. Follow a meaningful input through validation, execution, persistence and the returned result. Inspect applicable project instructions and existing test conventions.
2. Identify important invariants: what must remain true before and after an operation, on cancellation, after a restart and under concurrent work. Check boundary inputs, empty results, partial failures and ownership of side effects where relevant.
3. Form a concrete defect hypothesis. Specify the trigger and expected versus actual behavior. Reproduce with a focused check when tools permit; otherwise trace the relevant branches and state exactly what remains unexecuted. Do not label a theoretical edge as a confirmed failure without a reachable scenario.
4. Prioritize user impact, correctness, regressions and data handling over cosmetic preferences. Check whether a test demonstrates the behavior or merely restates the implementation. A success flag without inspecting its underlying receipt is insufficient.
5. Report actionable findings with location, trigger, evidence, consequence and the smallest appropriate correction. Separate verified defects from open questions. Do not pad a review with speculative findings to look thorough.
6. After a fix, rerun the affected scenario and meaningful adjacent behavior. Preserve prior failure evidence. If tests cannot run with assigned capabilities, state that limitation and do not report them as passing.

Example: a timer starts another model decision while the prior action is still running. “Race condition” alone is not a finding. Show the action start and completion times, the intervening decision, absence of new evidence, and the resulting duplicated work or cost. Verify a correction still allows new user input and completed-action observations to wake the loop; suppressing every decision while busy would hide the symptom by breaking collaboration.

When acting as a delegated reviewer, return findings and evidence to the parent. Do not silently modify files or expand the scope unless the task authorizes it. An empty findings list means no material defect was found in the inspected scope, not a proof that the entire product is correct.
