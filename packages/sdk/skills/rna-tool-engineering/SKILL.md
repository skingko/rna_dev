---
name: Tool and automation engineering
description: Design composable tools and scripts with explicit contracts, useful errors and executable evidence of behavior.
---

Use when a recurring operation, integration gap or independent verification need justifies a new tool. Prefer an existing general tool when it already solves the task. Do not create an echo, checklist generator or self-assigned score merely to increase the tool count.

Reuse mature skill procedures and existing integrations before writing another wrapper. Public skill catalogs provide source references, not installed host plugins. Inspect the exact source and resources, pin its revision, preserve provenance and check licensing before copying. Adapt assumptions and tool names to the actual Rna registry; a document mentioning a browser, shell or vendor SDK does not make it available. An installation receipt proves installation only. Exercise the assigned capability on a representative task and inspect its actual result before claiming it fills the gap.

1. State the job in user terms and identify the repeated cost or failure being removed. Inspect the actual API, input data and available runtime. Verify uncertain API behavior against authoritative documentation or a real call.
2. Specify a narrow contract: meaningful name, trigger, accepted inputs, units, defaults, ranges, output meaning, side effects, required permissions and resource limits. Describe the difference between missing data, a rejected request and an uncertain outcome. An error must help the caller decide the next action.
3. Compose with existing tools. Return concise structured results and references to large artifacts rather than flooding context. Keep credentials out of descriptions, logs and ordinary configuration. Paginate large results. A read operation must not silently write or make a paid mutation.
4. Implement real behavior with validation and deterministic transformations where possible. Observe cancellation. For a remote mutation, preserve the receipt; a transport error after dispatch is not proof the operation failed. Retry automatically only when the operation's semantics and receipt establish that it is safe.
5. Test the contract independently: ordinary input, empty/invalid input, numeric or format boundaries, and error behavior. Derive expected results from the specification, not from whatever the implementation returned. Inspect generated artifacts as well as return values. Do not delete a failing case, hard-code its answer or weaken a tolerance to make the test green.
6. Try the tool through the agent on realistic tasks. Check whether the description leads to the right arguments and whether the result enables the next decision. Improve ambiguous names and error messages from actual misuse.

Example: a currency total tool must state currency and decimal handling; summing raw floats and returning “correct: true” is not independent validation. A geometry tool must define whether distance means center-to-center or edge-to-edge. A compatibility change keeps the published meaning or introduces a new version/tool rather than silently changing units.

For skills/MCP installation, inspect the source and declared contract, register it through the host workflow and verify discovery plus a meaningful call. Successful installation alone does not prove usefulness or authorization for every exposed operation.
