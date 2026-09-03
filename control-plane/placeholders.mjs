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
