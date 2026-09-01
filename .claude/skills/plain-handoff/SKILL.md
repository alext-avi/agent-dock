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

**Never give a bare number.** An issue or pull request reference always carries its
title: "#26, connector credential types", not "#26". The number is a lookup key for
someone who already knows the work; the title is the only part that means anything to a
reader who does not. This applies to every mention, including ones in passing.

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

## When there is more to say

A request for a recommendation, a design discussion, or an explanation deserves real
substance — but substance is not the same as jargon, and a technical question is not a
licence to answer in technical register. Give the reasoning in plain words: what the
options mean, what each one costs, what you would choose. Product names, licence terms,
version numbers and internal identifiers earn their place only if they change the
decision.

If a reply is turning into a survey, it has probably stopped answering the question.
