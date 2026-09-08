// Where a placeholder may appear in a connector definition.
//
// The syntax is part of `agent-wrapper/v1`, so both sides of the wrapper have to
// agree on it. The control plane cannot import the worker's copy — that would put
// worker code above the wrapper — so this is deliberately a second
// implementation, and `test/placeholders.test.mjs` asserts the two agree on a
// shared corpus. Duplication with a test beats an import that breaks the
// boundary, and beats duplication without one: two copies of the same credential
// description drifting apart is a bug this repository has already had.

export const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// Every distinct placeholder written into a definition, in first-seen order.
// Deliberately not `command`: an executable is checked against an allowlist and
// must be a literal, or the allowlist would be checking a template.
export function placeholderNames(server) {
  const found = new Set();
  const scan = (value) => {
    if (typeof value !== 'string') return;
    for (const match of value.matchAll(PLACEHOLDER)) found.add(match[1]);
  };
  scan(server?.url);
  scan(server?.cwd);
  for (const argument of server?.args ?? []) scan(argument);
  for (const value of Object.values(server?.headers ?? {})) scan(value);
  for (const value of Object.values(server?.environment ?? {})) scan(value);
  return [...found];
}

// The authority of a url — userinfo, host, port — must not contain a placeholder.
//
// The host check compares a credential's allowlist against the stored url, which
// is a template. A placeholder inside the authority parses as part of the
// hostname, so `https://${TENANT}.example.com` satisfies an allowlist of
// `*.example.com`; the worker then substitutes plain text, and a value of
// `attacker.test/collect?x=` moves the authority to a host nothing checked. That
// is the bypass the allowlist exists to prevent, so the template is refused
// rather than the check being quietly weakened.
//
// A placeholder in the path or query is fine: substitution cannot move the
// authority once it has been parsed past.
export function urlAuthorityPlaceholder(url) {
  if (typeof url !== 'string') return null;
  const scheme = url.indexOf('://');
  if (scheme === -1) return null;
  const start = scheme + 3;
  const end = url.slice(start).search(/[/?#]/);
  const authority = end === -1 ? url.slice(start) : url.slice(start, start + end);
  const match = authority.match(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/);
  return match ? match[1] : null;
}

// How a resolved value is addressed on the wire. Scoped to the definition,
// because a placeholder name is only meaningful inside the definition that wrote
// it: two connectors both naming ${TOKEN} are two different secrets, and sharing
// one entry meant the later one was delivered to both.
export function deliveryKey(server, name) {
  return `${server.id}\u0000${name}`;
}
