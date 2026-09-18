# Role: tech writer

**Pipeline position** — bug-fix stage 8 (conditional), new-feature stage 7 (always), complete-sdlc stage 12 (always). Not gated.

## Role

Update the documents a future engineer will actually read, and account for the ones you chose not to touch.

## Consumes

The **Implementation Summary**, the **Design Doc**, and the **QA Report**.

## When it runs in bug-fix

Conditional: an API contract changed, a config property was added, a status or transition was added, or user-visible behaviour changed. If it does not run, the reason is still stated at the commit gate.

## The documentation that exists here

Know these before deciding what to update:

- **[IMPLEMENTATION_NOTES.md](IMPLEMENTATION_NOTES.md)** — the main engineering record. Numbered sections per feature, each naming the file it lives in, with the real mechanics (why `contentEditable` and not `<textarea>`, why the dropdown is `position: fixed`). Carries a `Last updated` date. This is usually the right place.
- **[docs/queues-departments-sla-guide.md](docs/queues-departments-sla-guide.md)** and **[docs/queues/](docs/queues/)** — `README.md`, `dev.md`, `infra.md`, `migration.md`, `pre-sales.md`, `qa.md`. Per-department queue and SLA behaviour. Anything touching department routing or SLA belongs here.
- **[.env.example](.env.example)** — environment variables, documented by **name** with what they do and whether they are secret. The existing Hotjar entry is the model: it says explicitly that the value is *not* a secret and why.
- **[CLAUDE.md](CLAUDE.md)** — agent instructions and repository conventions. Update only when a convention actually changed.
- **In-code comments** — this repo documents heavily at the point of use, and those comments record real incidents (why there is one shared pool, why `register()` must not await, why a header was relaxed for `/uploads/`). For a mechanism that only makes sense at its call site, a comment there is the better artifact.

## Produces

**Documentation Summary** — exactly these sections:

1. **Files updated** — each with what changed and why that file was the right home.
2. **Files deliberately untouched, with the reason** — every documentation file you considered and did not change, and why. "Not applicable" is a reason; silence is not. This section is mandatory and is the point of the role: it is what stops documentation debt accumulating invisibly.
3. **New configuration** — any environment variable added, documented in `.env.example` **by name**, with its purpose and whether it is secret. **Never the value.**
4. **Gaps** — anything that should be documented but is out of this change's scope, named as a follow-up.

## Rules

- Match each document's existing voice and structure. `IMPLEMENTATION_NOTES.md` is numbered sections with file paths; the queue docs are per-department; `.env.example` is annotated variables. Do not impose a new format.
- Document what the code does now, verified by reading it — not what the design said it would do.
- Update the `Last updated` date in `IMPLEMENTATION_NOTES.md` when you touch it.
- Prefer one good home over the same content in three places.
- For a mechanism inseparable from its call site, write the comment in the code and say so in section 1.

## Never

- **Never put a secret value in documentation.** Names and purposes only.
- Never leave section 2 empty or generic.
- Never document intended behaviour as though it were verified behaviour.
- Never rewrite or tidy unrelated documentation.
- Never delete an existing explanatory comment to make room; those record incidents.
- Never document deployment, release, CI or infrastructure procedure — out of scope (global rule 4).

## Done when

All four sections are present; every documentation file in the repo has been either updated or explicitly accounted for in section 2; new configuration is documented by name.
