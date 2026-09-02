# Scoped data attachments

Agent Dock keeps each managed agent's CLI installation, provider login, telemetry, and default `/workspace` in four private Docker volumes. A folder mapping adds an explicit fifth-or-later mount without weakening that baseline. From the agent's **Data** tab, an administrator chooses a folder and maps it read-only or read/write in one operation. The control plane creates the underlying attachment-scoped source record internally.

## Source types

- **Host directory** — an exact subfolder beneath a deployment allowlist root. The registry stores only a root ID and relative path; the raw host root remains in `ATTACHMENT_ROOTS_JSON` and is never returned by the REST API or browser.
- **Managed volume** — a Docker named volume created and identity-labelled by Agent Dock. Its engine name is private control-plane state and is not returned to the browser.

For a remote Docker Engine, a host-directory source is local to that engine host, not to the browser or control-plane filesystem; a managed volume is owned by that engine's provisioner. A future synchronized object-store source will be a separate source kind with its own materialization contract rather than overloading `relativePath`.

Configure roots as one-line JSON:

```dotenv
ATTACHMENT_ROOTS_JSON={"projects":{"label":"Projects","hostPath":"/Users/you/Projects","allowWrite":true},"reference":{"label":"Reference","hostPath":"/Users/you/Documents/reference","allowWrite":false}}
```

`allowWrite` is an operator deployment decision. A source below a read-only root can never be attached read/write. Prefer multiple narrow roots over one home-directory root; never approve SSH, cloud-credential, browser-profile, Docker-socket, or other secret-bearing directories.

## Applying an attachment

Open an agent's **Data** tab, select **Map folder**, and choose:

- `read-only` or `read-write`;
- additional data or the task working directory;
- a container-safe mount name, rendered under `/data/<name>`.

The mapping form includes an administrator-only folder picker. It enumerates readable directories only beneath the selected configured root, as the target harness user, and stores the chosen relative path. The response contains the root label and relative directory names only—never the deployment's absolute host path. Symlinked folders are excluded and every breadcrumb navigation request is validated again inside the locked-down helper container.

An agent may have one attachment designated as its task working directory. The wrapper receives that target as `WORKSPACE_PATH`; its private `/workspace` volume remains mounted and available. This makes a read/write project source appropriate for an intentionally live coding workflow, while a self-contained clone in the private workspace remains the safer default when live host edits are unnecessary.

Applying, changing, or removing a mount requires an idle, managed, dedicated runtime. The control plane validates every source, replaces the container, and reattaches the same four private volumes, so provider authentication survives. If replacement fails it attempts to restore the previous mount set. If registry persistence fails after replacement it also attempts to restore the previous container state.

Read/write leases are exclusive across overlapping host paths and managed volumes. Read-only readers may overlap a writer. This avoids two autonomous agents concurrently writing the same working tree, but it is not distributed locking outside this control-plane process.

## Validation and security boundary

Before replacement, the Docker runtime manager starts a short-lived helper as the target worker's numeric user. It has no network, a read-only root filesystem, no Linux capabilities, `no-new-privileges`, and only the configured root mounted. It rejects missing/non-directory paths, parent traversal, and symlinks in the relative path, then verifies the requested access. The actual worker receives only the exact resolved subfolder, with Docker enforcing read-only mode when selected.

There is an unavoidable check-to-mount race in this Docker-socket POC if another host process can replace the validated directory between validation and container creation. Treat allowlisted roots as administrator-controlled. A production provisioner should own canonical path resolution and mount creation behind a narrower privileged boundary.

The control plane currently holds the Docker socket, which is host-level authority. Issue #13 tracks replacing that with a constrained provisioner. Storage registry and mount mutation require the `storage:manage` REST/UI permission (currently administrator only) and are deliberately absent from the control-plane MCP tool registry, so an agent cannot grant itself filesystem access.

## REST surface

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/v1/attachment-roots` | List safe root IDs, labels, and write eligibility; never host paths |
| `GET` | `/api/v1/attachment-roots/:rootId/directories?agentId=:id&path=:relativePath` | Browse readable folders beneath one configured root as the target agent user |
| `GET`, `POST` | `/api/v1/data-sources` | Low-level compatibility surface for reusable sources; not exposed in the normal agent UI |
| `GET`, `PATCH`, `DELETE` | `/api/v1/data-sources/:id` | Read, rename/repoint when detached, or delete a source |
| `GET`, `POST` | `/api/v1/agents/:id/attachments` | List mappings or map an inline approved folder in one operation; reusable `dataSourceId` payloads remain supported |
| `PATCH`, `DELETE` | `/api/v1/agents/:id/attachments/:attachmentId` | Change policy or detach and replace the idle runtime |

Deleting a managed volume requires `deleteVolume: true` plus exact source-ID confirmation. Unmapping an attachment-scoped folder removes only its internal registry record; it never deletes host data. An agent cannot be deleted until all of its additional attachments have been removed.
