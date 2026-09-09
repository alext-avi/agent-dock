# Placeholder Credential Review

Three adversarial passes over the placeholder secret mechanism, the credential
simplification, and the contract, plus an independent control-plane/UI pass.
Branch `mcp-nav-and-workshop`, 13 commits.

The review originally found one credential exfiltration path, one silent
removal of authentication, and documentation that overstated the boundary. The
branch now contains the remediation described below; this document keeps the
original findings as an audit trail.

## Recommendation: ready after final verification

The credential collision, URL-authority bypass, destructive connector edit,
missing-reference validation, worker restart state, and workshop warning/error
paths are fixed with regression coverage. The three superseded credential
formats are rejected at the API and worker boundaries, are no longer emitted by
the UI, and no longer participate in delivery.

Two OpenCode-specific alignment items remain intentionally deferred to their own
ticket: resolving placeholders for health probes without transmitting literal
templates, and revalidating the resolved working directory. The unrestricted
stored-key and local-process cases are explicit product-security decisions,
documented under "Reasonable deferrals" below.

| | |
|---|---|
| Findings | 18 |
| Fixed in this branch | 15 |
| Deferred with an explicit boundary | 3 |
| Blocking | 0 |

## Resolution update

- The connector editor now represents and round-trips every canonical field:
  headers, environment, working directory, arguments, URL, timeouts, and
  placeholder bindings. A browser regression test edits only a timeout and
  proves that authentication and advanced fields survive.
- Legacy top-level `credentialId`, `secretHeaders`, and `secretEnvironment`
  inputs are rejected instead of migrated or silently ignored. Stored keys no
  longer own a header name; placement lives exclusively in the connector.
- Container secrets are included in unresolved-reference validation. Workshop
  proposals preserve placeholder-bearing headers and environment values, reject
  literal secret-looking values, and show the operator the actual validation
  warnings.
- Browser API errors retain their HTTP status, making adapter rejections
  distinguishable from infrastructure failures. Workshop copy now discloses
  that the selected harness may install or execute software in its container.
- Codex bearer values are delivered through an ephemeral environment variable
  rather than a command-line argument, both while configuring the native MCP and
  when each `codex exec` task starts. Rollback also removes previously managed
  servers when a prior credential value is no longer available.
- Contracts, security language, and the architecture source now describe the
  canonical placeholder model and the actual stored-key boundary.
- Final verification after remediation: **157/157** unit and integration tests
  and **34/34** Playwright tests.

### Reasonable deferrals

- **OpenCode adapter alignment.** Its health probe and resolved-working-directory
  behavior are adapter-specific and predate this credential simplification.
  Treating them together in a focused issue avoids inventing a partial fix in the
  shared contract.
- **Remote host lists do not authorize local processes.** A host list has no
  meaningful destination to compare with a `stdio` process, and asking for the
  same value again would prove possession without constraining where that local
  process can send it. For this local-container POC, the documented boundary is
  that any process inside that isolated agent can read a delivered key. A future
  policy should add an explicit `allowLocalProcess` grant or prohibit stored-key
  delivery to `stdio`; a transport-change re-entry prompt would be security
  theater rather than a fix.
- **Unrestricted-key confirmation and harness readiness.** The UI labels an empty
  host list as usable for any host, but does not add a second confirmation, and
  the workshop lists configured harnesses before proving they are logged in and
  ready. Both are useful hardening/UX work, but neither silently widens a key or
  bypasses an existing policy in this local POC.

### Deployment note for the current 8787 registry

A read-only shape audit of the live schema-v4 registry found one GitHub connector
still using `secretHeaders`. Its `sourceEnv` entry looks like credential material,
not an environment-variable name, which means credential-like text is currently
stored as plaintext legacy metadata even if the old worker cannot resolve it.
Do not copy that record into the canonical schema. Before deploying this branch,
delete and re-create the connector with an `Authorization: Bearer ${ACCESS_TOKEN}`
header plus a placeholder binding, and rotate the exposed token. The new loader
intentionally refuses a populated legacy field rather than starting after
silently removing authentication.

## What was reviewed

The three original passes ran independently, so that agreement between them
means something. A fourth pass reviewed the committed branch separately while
the remediation commit was being prepared. Each reviewer was told to assume the
work is wrong and prove it.

- **Substitution and delivery.** Whether a value can reach a connector that did
  not ask for it, what `argv` exposure actually costs, and whether the capability
  gate can fail open.
- **Credential state and the host default.** A key may now exist with no value,
  and an empty host list changed from deny to permit. Every consumer went from
  one state to three.
- **Contract and documentation.** Which written claims are now false rather than
  merely incomplete, and whether the protocol change needed a version bump.

## Findings

Deduplicated across the three passes. Where two reviewers reached the same
conclusion independently, that is noted — it is the strongest signal in the set.

### Critical · fixed · substitution pass
**Two connectors sharing a placeholder name shared a secret.**
Delivered values sat in one flat map per agent, keyed by placeholder name. Two
connectors both naming `${TOKEN}` shared an entry and the last one resolved won —
so a key scoped to one host was handed to a connector pointing anywhere.

Both host checks passed. Each ran against its own connector's URL and its own
binding; neither looked at the delivery. Reachable with ordinary API calls, and
reachable through the workshop by a prompt-injected agent that only has to name
`${TOKEN}`, because the dialog preselects a stored key whose name matches. Values
are now addressed per definition; a first attempt that merely prefixed the key
did not close it.

### High · fixed · substitution pass
**A routine edit removes a connector's authentication.**
The rebuilt dialog sends `headers: {}`, `secretHeaders: {}` and
`credentialId: null` unconditionally, and scans only arguments and URL for
placeholders. Change a timeout on a header-authenticated connector and it saves
unauthenticated, silently.

A header-borne `${TOKEN}` never gets a row, so the reconcile step sees no
placeholder in use and does not object. The same payload also wipes
`credentialId`, so any connector still on the legacy mechanism loses its
credential on first edit. The fix is to send only the fields the form controls,
and to keep bindings for placeholders living in fields it cannot show.

### High · fixed · substitution + contract
**A placeholder in a URL's authority defeated the host check.**
The check compares a key's host list against the stored URL, which is a template.
`https://${TENANT}.example.com` parses as a hostname and satisfies
`*.example.com`; substitution then moves the authority. A value of
`attacker.test/collect?x=` yields `https://attacker.test/collect?x=.example.com/mcp`.

Two calls: insert the placeholder, bind it, apply. Placeholders in the authority
are now refused; in the path or query they remain fine, because substitution
cannot move a host already parsed past.

### Medium · documented boundary · substitution pass
**Switching a connector to a local process skips the host check.**
One edit — transport to `stdio`, URL to null, the destination moved into an
argument — keeps the credential binding and routes it through the path that has
no URL to check.

The contract discloses that a local process has no destination to validate. What
it does not disclose is that the carve-out is reachable from an existing remote
connector in a single call, which is the shape the same section claims the list
prevents. Requires a non-empty command allowlist. The fix is to demand the value
again on a transport change, the same proof widening a host list already takes.

### Medium · fixed · credential + substitution
**A key bound by placeholder to a missing id broke a whole agent.**
Validation inspected only the legacy field, so a placeholder bound to a
credential id that does not exist saved with 201 and then failed the agent's
entire apply, marking every binding on it in error. One writable definition was a
denial of service on an agent's whole MCP configuration, and the control plane's
recorded states then disagreed with the runtime, which kept running the previous
config.

### Medium · fixed · credential pass
**A valueless key was written to disk and dropped on reload.**
The load filter still demanded a sealed value, so a key created by writing a
placeholder survived a save and vanished on the next boot — leaving a connector
referencing an id that no longer existed. Because ids derive from names, a
different key could later take that id and be delivered in its place. A restart
accomplished exactly the dangling state the deletion guard exists to prevent.

### Medium · fixed · substitution + contract
**A restarted worker did not report placeholder-only connectors as waiting.**
Delivered values are held in memory, and the pending list filtered on the legacy
field. A connector authenticating only through a placeholder reported nothing
after a restart, so the control plane believed the agent was whole until a task
died.

### Medium · fixed · credential pass
**The proof-of-ownership gate had a pre-completion window.**
Widening a host list is meant to require the value again. The gate keyed off
whether a value existed, so a key with hosts and no value could be repointed
freely and completed afterwards — the redirect never proved.

### Low · deferred to OpenCode alignment · substitution pass
**The OpenCode health probe runs a configuration nobody will run.**
The probe resolves without secrets, which previously still substituted the older
mechanisms. It now runs with a literal `${TOKEN}`, so a working connector is
reported failed to the browser — and the literal is sent to the connector's
remote host as its credential.

### Low · fixed · substitution pass
**Validation does not warn about an unprovisioned container secret.**
The unresolved-reference check reads only the older maps, so a placeholder bound
to a container secret that is not provisioned validates clean and fails at apply.
That is precisely the asymmetry the check was written to prevent.

### Low · fixed · substitution pass
**The workshop discards a proposed header without saying so.**
The instructions tell a harness a proposed header will be discarded, and it is —
silently. Extraction keeps it, so no warning fires, and the dialog never reads
it. A harness proposing an `Authorization` secret header produces a connector
saved with no authentication and no message.

### Low · deferred to OpenCode alignment · substitution + contract
**Working-directory confinement became a check on a template.**
The control plane confines a working directory before substitution. Claude's
adapter re-checks the resolved value; OpenCode's does not, so a placeholder there
escapes the stated confinement. Container-local, and the adapter gap predates
this work — placeholders are what turned the check into a template check.

### Low · fixed · credential pass
**Three smaller credential defects.**
A key that could never be sealed was accepted when no encryption key was
configured. Completing a placeholder-created key wrote back a default header it
never had. And the dialog said a URL is checked "when you save" when it is
checked at apply — a mismatched connector saves with 201.

## Independent control-plane/UI pass

This addendum records findings that were not already represented above. The
summary counts at the top remain the reconciled counts from the three original
reports; overlapping findings from this pass are deliberately not counted
again.

The independent pass reproduced the cross-connector placeholder collision and
the URL-authority bypass, and independently found the destructive connector edit
and valueless-key reload defect. That agreement is additional evidence for the
severity and ordering already assigned to those findings.

### Medium · fixed · control-plane UI
**Harness validation warnings are counted but never shown.**
`checkProposal` reduces the adapter's warning array to its length and tells the
operator only that there were, for example, "2 warnings". Warnings such as a
cleartext remote endpoint or use of a package runner are the information needed
to decide whether to save. Display the actual warning messages in the workshop
log or below the proposed definition, and cover more than one warning so the UI
cannot regress back to a count.

### Low · fixed · control-plane UI
**The harness-rejection branch is unreachable.**
The shared `api()` helper throws a plain `Error` without copying the HTTP status.
`checkProposal` then branches on `error.status === 400`, which can never be true.
An adapter's deliberate 400 rejection is consequently presented as a generic
failure to complete the compatibility check. Preserve `response.status` on the
error or return a structured error from the helper, then exercise the 400 and
non-400 paths independently.

### Medium · explicit product-security decision
**A newly created key is unrestricted unless the operator opts into hosts.**
This is deliberate in the implementation, but the placeholder workflow makes it
easy to create a key by name and complete it without ever choosing a permitted
host. At minimum, completing an unrestricted key should require an explicit
confirmation that the key may be delivered to any remote connector. If that is
not the intended normal case, derive or require an exact host from the connector
being bound instead.

### Low · deferred · workshop lifecycle
**The harness picker treats any agent with a runtime as usable.**
It does not require the worker to be online, authenticated, or otherwise ready to
accept a task. Stale or logged-out agents therefore appear as valid workshop
choices and fail only after dispatch. Filter on the same actionable runtime
state used by task execution, or label unavailable agents and disable them.

### Residual risk · fixed disclosure · workshop execution
The workshop prompt explicitly permits installing and running software before
the operator reviews the proposed connector. That may be the intended power of
the feature, but the current copy says only that the definition is reviewed
before it is saved. The UI should disclose that asking a harness can execute
third-party packages inside that agent's container, especially when the agent
has writable mounted data or outbound network access.

### Independent verification

- Committed branch before remediation: **152/152** unit and integration tests,
  plus **32/32** Playwright tests.
- Clean synthetic merge with the then-current `origin/main`: **167/167** unit and
  integration tests, plus **36/36** Playwright tests.
- Those green runs did not exercise the credential-collision or destructive-edit
  paths. The exploit-first tests added in `e5bc4f2` close part of that gap; the
  dialog round-trip and the UI warning/error paths still need regression tests.

## The documentation was not a footnote here

At the time of review, six written claims were false rather than incomplete. In
this repository the README's security section is the boundary artifact, so an
overclaim there was a defect in its own right. The README, both contracts, and
the architecture source have since been corrected.

- **The README still promises the guarantee the opt-in host list removed** — that
  a key is "sent only to the hosts named on it", released "only for a host on its
  list", and that widening the list requires the value. An empty list now permits
  any destination, a local process never consults the list, and the widening rule
  had the gap noted above.
- **The MCP contract contradicts itself.** The section added to correct the
  overclaim sits beside an older paragraph still saying the list is "enforced at
  the moment of use". A reader gets opposite answers depending on which they reach
  first.
- **The adapter contract says nothing about placeholders** — not the capability
  flag, which fields are substituted, why the command is excluded, the new error
  code, or the delivery keying. The repo's own rule makes that update part of the
  same change.
- **The architecture diagram has no credential store** and labels the worker
  payload as "same servers payload", which is no longer true: it carries resolved
  plaintext values.
- **The canonical example is the legacy shape.** The contract still presents
  header and environment references as the mechanism, and the README points
  operators at a page that is no longer where this work happens.
- **The workshop's worked example proposes a command denied by default**, steering
  every harness toward a connector that fails or pressures an operator into an
  allowlist entry the docs warn against.

## The pattern worth acting on

Six review rounds on this branch. Every one found something introduced by the
round before it.

Three separate defects this week came from **the same description existing in two
places**: a credential line duplicated between two pages that drifted, a
delete-protection check that knew one of two ways a key can be used, and a
pending-credential list that knew the other. The placeholder syntax now has three
implementations — control plane, worker, and a deliberately narrower one in the
browser — and that third one is the root of the blocking dialog finding.

Meanwhile four superseded mechanisms still decide the same thing with four
different security properties, and the operator interface can only see one of
them. There is no installed base to preserve. **Removing the legacy paths is the
single change that retires the most risk**, and it is the reason two of the fixed
findings existed at all.

## Remediation sequence

Sequenced, because the order carries information: each step removes a class of
defect the next one would otherwise have to work around.

1. **Done — stop the dialog removing authentication.** Send only the fields the form
   controls, and preserve bindings for placeholders in fields it cannot show.
   Until this lands, editing a connector is a destructive operation.
2. **Resolved as a documented boundary — local-process delivery.** Re-entry does
   not constrain a local process, so it would not fix the security property. The
   stronger future policy choices are described above.
3. **Done — delete the three legacy mechanisms.** Header references, environment
   references, and the bare credential reference. This retires the duality behind
   two findings above, and shrinks what the next reviewer has to hold in mind.
4. **Partly done, with OpenCode isolated.** Missing-secret validation and workshop
   header handling are fixed here. OpenCode probe and working-directory behavior
   move together to the dedicated adapter-alignment issue.
5. **Done — correct the documentation, then re-export the diagram.** The README's
   security section first, since it is the load-bearing claim; then the two
   contracts, then the diagram. Remove the contradicting paragraph rather than
   adding a third account.
6. **Done — add the missing tests, then re-review.** The capability gate's refusal
   path is untested on both flags — it is the only thing keeping the delivery
   change additive. Pin the deliberate local-process hole so it cannot be widened
   by accident. Then one more pass, scoped to what changed.

## What held up

Worth recording, because knowing which parts have stopped moving is worth as much
as the next finding.

- **Substitution itself is sound.** No re-expansion, no reaching a name the
  definition never bound, no interpretation of replacement patterns in a value.
  The command is excluded from both scanners, so the allowlist always checks a
  literal.
- **The argv exposure claim holds for reads** — no log line, event, response, or
  inspect output carries a filled value. One wrinkle: it is durable in provider
  config inside the agent's own volume, and for one adapter a revoked key keeps
  working until the next successful apply.
- **The capability gate cannot fail open.** Both flags compared strictly, an
  unreachable worker becomes an error, and no proxy route reaches the apply path.
- **The adapter boundary is intact.** No provider name, event, credential format,
  or CLI flag entered the control plane, including the new modules and the harness
  prompt.
- **No disclosure regression.** The new credential fields expose a boolean over
  "does a value exist" and one derived from already-public data. No route bypasses
  the public projection, and nothing logs a credential.
- **Duplicating the syntax scanner was the right call** — importing worker code
  above the wrapper would break the boundary, and the guard test is adequate for
  what it compares.

---

Counts are reconciled by hand across three reports. Severities are the
reviewers'; fixed/open statuses were verified against the commit rather than
taken from the summaries.
