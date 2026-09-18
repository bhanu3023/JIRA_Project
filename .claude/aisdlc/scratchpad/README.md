# Scratchpad

Throwaway working files for an in-progress investigation.

**Nothing here is committed.** See `.gitignore` in this directory.

## What goes here

- A probe written to answer one question, then discarded.
- Intermediate query output being compared across runs.
- A draft artifact still being assembled.

## What does not

| Instead of here | Put it |
|---|---|
| a diagnostic worth keeping | [../diagnostics/](../diagnostics/) |
| a test | a colocated `*.test.ts`, run by `npm test` |
| a production change | the application code, through a pipeline |
| a commit-gate approval | `../state/` — written by `approve-commit.mjs` |

## Note

The Claude Code session also has its own scratchpad outside the repository, which is isolated and needs no permission prompts. Prefer it for anything that does not need to sit beside the framework. This directory is for working files you want next to the pipeline artifacts while a multi-stage run is in flight.

Clear it out when the run is done. A stale probe read as current evidence is how a wrong conclusion gets carried into the next stage.
