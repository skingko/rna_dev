---
name: Deliverable quality
description: Build and verify usable products, interfaces, documents and data artifacts against explicit acceptance evidence.
---

Use for substantial creation or revision of a deliverable. Scale the procedure to the task; do not create a large plan for a small correction.

1. Inspect the brief, relevant existing artifacts and project instructions. Identify the audience, primary use, constraints and delivery format. Separate explicit requirements from your assumptions. Look for provided references before inventing a direction.
2. Define a compact acceptance contract. Connect each important requirement to a check and its evidence: requirement → observable behavior → verification method. Include functionality, usefulness and craft. A file existing is insufficient when the requirement concerns its behavior or appearance.
3. Choose a coherent direction. For visual work, decide information hierarchy, typography, spacing, color, imagery and interaction around the subject and audience. Reuse an existing design system when one exists. Avoid a generic collection of cards, stock gradients, placeholder copy and decorative controls with no purpose. For analytical work, decide units, assumptions, source authority and uncertainty before calculating.
4. Implement a complete slice the user can actually use. Connect controls to behavior; include relevant empty, loading and failure states. Prefer a few resolved details over many unfinished promises. Use existing tools and dependencies where appropriate. Inspect tool errors, fix their cause and resume.
5. Validate at the delivery surface. A web interface needs rendered inspection at relevant viewport sizes and the primary user journey; a game needs actual input, feedback, failure/restart and playability checks. A program needs representative execution and error cases. A report needs source verification, logical consistency and rendered/readability review. A dataset needs schema, boundary, missing-value and reconciliation checks. Do not report a browser review if no browser was used, or visual quality from source text alone.
6. Critique with evidence. Name the location, observed defect, user impact and required correction. When useful, ask a separate reviewer with the brief and actual artifacts, not just your favorable summary. Address material findings, recheck the affected behavior and preserve unresolved ones in the handoff. External taste cannot be fully reduced to a score.
7. Deliver accessible files or an entry point, explain how to use them, and state what was verified. Distinguish implemented, executed, visually inspected and still uncertain.

Example: “Build a daily expense dashboard.” Weak acceptance: an HTML file contains a chart and the word expenses. Strong acceptance: add an expense, reload, confirm the recorded total; verify empty and invalid input states; inspect long category labels and a narrow viewport; check chart labels and values against the underlying records. A polished screenshot without persistence does not satisfy the functional criterion. Passing arithmetic tests does not satisfy visual review.

If a check fails, change the artifact or the faulty method. Do not weaken the requirement after seeing the result. If a requested property cannot be tested with available capabilities, record that exact gap and pursue an authorized tool installation when useful.

During iterative fixes, keep a short set of still-active constraints: required behavior, units and representation, prescribed algorithms or methods, interfaces, and earlier accepted decisions. A new request changes only the constraints it actually replaces. Check each repair against this set and add a counterexample where useful. Rounding a floating-point total is not equivalent to implementing an integer minor-unit ledger when exact integer arithmetic was required. Conversely, an empty-state message is not a data entry just because a coarse DOM selector counts it: inspect the user's contract and the element's meaning before rewriting working behavior. Record unresolved verifier ambiguity without inventing a pass.

## Interface and visual work

Establish the content and user journey before choosing components. State a short visual direction tied to the subject: what is most prominent, what the user should notice next, and what gives the product a recognizable character. Inspect the user's references for hierarchy, density, interactions and states; copying a color palette alone does not reproduce their experience. Prefer the project's existing components and native controls where they serve the interaction.

Build the primary screen with actual or clearly labelled representative content. Resolve typography, line length, alignment, spacing and contrast together. Use imagery or illustration with an intentional role; a decorative gradient is not a substitute for art direction. Check both the full composition and the details at actual display size. A clean template can be functionally adequate while still lacking the quality the brief asks for.

Exercise the complete journey, including selection changes, invalid input, completion, reload and relevant failure states. Inspect keyboard focus and narrow layouts. Check labels against the data they actually describe: a section called “Today” must not silently list multiple dates. Inspect text against the brightest and darkest parts of a background, not just a single sampled color. When a browser or screenshot capability is unavailable, identify that gap and obtain an authorized capability when possible; never replace rendered inspection with an assertion that the HTML looks professional.

Keep two separate verdicts: observed behavior and visual/content craft. A successful interaction does not certify composition, copy or legibility. Record specific visible defects, correct them, and inspect the revised screen. Stop revising when the brief and meaningful checks are satisfied, not after arbitrary cosmetic churn.

## Evidence and analytical work

For each decisive statement, track the exact source passage, population or sample, variable, unit, time period and what the source actually establishes. Distinguish a measured change from an inferred explanation. Recalculate values and preserve denominators and units in the prose, tables and conclusion.

Before combining sources, check that their populations, measures and periods support the comparison. A sample of current users need not be the newly acquired cohort; an event count need not count unique people; two observations made in the same month do not establish a common trend. A caveat at the end does not repair an unsupported assertion earlier in the report.

Review the strongest sentences against the sources, especially causal verbs, “all”, “new”, “representative” and “proves”. Weaken or remove claims the evidence cannot support. If a finding cannot be established, say which fact is unknown and what evidence would resolve it. Preserve both favorable and contrary evidence. A structurally valid JSON summary is not independent validation of the accompanying prose.
