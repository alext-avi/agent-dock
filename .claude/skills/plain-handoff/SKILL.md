---
name: plain-handoff
description: Translate a technical status update into plain language before handing the conversation back. Use when finishing a piece of work and reporting what happened, what it means, or what decision is needed — especially after a security fix, a review, a refactor, or a deploy.
---

# Hand back in plain language

The detail already lives in the commits, the pull request, and the issues. Repeating
it in chat is duplication. What the reader needs is what changed for them and what,
if anything, they have to decide.

## Before replying, rewrite

**Lead with the consequence, not the mechanism.** Not "narrowed the resolver's
environment to a prefixed namespace" — "a connector can now only reach secrets you
deliberately gave it."

**Name things by what they do.** "The thing that hands credentials to a connector",
not `resolveServers`. Use an identifier only if the reader will go looking for it.

**Drop the evidence unless it changes the decision.** File paths, line numbers, test
counts, mutation results and review provenance are all reasons to trust the work, not
the work itself. One line at the end is usually enough: "tests pass" beats a table.

**Say who has to act.** Separate "done, nothing needed from you" from "this is
blocked on you". If a decision is needed, give the options as outcomes — what happens
either way — not as implementation routes.

**Keep the honesty.** Simplifying is not softening. If something is broken, unproven,
or was got wrong, that survives the translation. Removing a caveat to make a summary
shorter is the one thing this must never do.

## Length

A few sentences. A short list if there are genuinely separate items. If it wants to be
longer, that is usually a sign the reply is carrying detail that belongs in the
artifacts instead.

## When not to simplify

The reader asked for depth: a recommendation, a design discussion, an explanation of
how something works or why a position is wrong, or a written comparison. Those are
requests for substance and should get it. This skill governs the routine handoff, not
every reply.
