# Verdikt Product Principles

## Register

Product.

## Users

Verdikt is for developers who want to let coding agents work for long stretches without trusting a single agent's self-report. The core user is technical, impatient with vague status, and willing to review final patches when the tool gives a clear reason to trust or distrust them.

## Product Purpose

Verdikt turns one executor agent, one verifier agent, and objective acceptance commands into a local supervised coding loop. Its promise is simple: reduce false completion claims while keeping the human out of the loop until a real decision is needed.

## Core Commitments

- Show what is happening now, not only what happened at the end.
- Keep all source changes isolated until the user explicitly applies a passed patch.
- Make every failure recoverable with a clear next action.
- Treat patch application as a deliberate decision, never a hidden side effect.
- Support long-running, high-frequency use with search, grouping, archiving, and readable history.

## Out Of Scope

- Running tasks without objective acceptance commands.
- Automatically applying high-risk patches.
- Replacing human product judgment for visual, strategic, or ambiguous work.
- Managing production secrets, payments, migrations, or live systems without explicit human review.

## Success Criteria

- A user can start a task, leave it running, return later, and immediately know whether it passed, failed, got stuck, or needs a decision.
- A failed run can be edited and rerun without rebuilding the task from scratch.
- A passed run shows enough patch risk context for the user to decide whether to apply it.
- A heavy user can manage dozens of runs without losing important work.

## Reliability and Control Addendum

- Durable queue state is part of the product promise, not an optional convenience.
- Normal app shutdown must preserve resumable work; explicit user cancellation must remain final.
- High-risk work pauses before execution and is checked again when shell commands are issued.
- Approval, rejection, evidence verification, and restart recovery must be available in both the workbench and command line.
- Benchmark claims should be based on repeated attempts and disclose instability, environment, model, and source commit.
