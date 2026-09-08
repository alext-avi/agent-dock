// Connector credentials: operator-managed API keys the control plane stores and
// hands to a worker at apply time, rather than variables baked into a container.
//
// On encryption. Values are wrapped with a per-credential data key, and that data
// key is wrapped by a key provider. With the default provider the key comes from
// this process's environment, which means the key and the ciphertext are equally
// reachable: that defeats a copied volume or a stray backup and nothing else. It
// is obfuscation, not confidentiality, and is documented as such. The envelope
// exists so a deployment with a hardware root of trust or an external key service
// can supply a provider instead without changing the stored format.

import { createCipheriv, createDecipheriv, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;
const HEADER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export const CREDENTIAL_TYPES = Object.freeze(['api-key']);
const ALGORITHM = 'aes-256-gcm';

function failure(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function text(value, field, { required = false, max = 500 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw failure(`${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw failure(`${field} must be a string`);
  const normalized = value.trim();
  if (required && !normalized) throw failure(`${field} is required`);
  if (normalized.length > max) throw failure(`${field} is too long`, 413);
  if (/\0|[\r\n]/.test(normalized)) throw failure(`${field} contains unsupported control characters`);
  return normalized;
}

// A key provider returns the 32 bytes used to wrap data keys. Swapping this is the
// whole point of the envelope; the stored format does not change with it.
export function environmentKeyProvider(environment = process.env) {
  const encoded = environment.CREDENTIAL_ENCRYPTION_KEY;
  return {
    name: 'environment',
    // Reported so the UI and docs can be honest about which mode is in force.
    protects: 'a copied volume or backup, not this host',
    available: Boolean(encoded),
    key() {
      if (!encoded) {
        throw failure(
          'Credential storage is unavailable: set CREDENTIAL_ENCRYPTION_KEY to 32 base64 bytes. '
          + 'A key is not generated automatically, because one written beside the data it protects '
          + 'would imply protection that does not exist.',
          503
        );
      }
      const key = Buffer.from(encoded, 'base64');
      if (key.length !== 32) throw failure('CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes', 500);
      return key;
    }
  };
}

function seal(plaintext, wrappingKey) {
  const dataKey = randomBytes(32);
  const valueIv = randomBytes(12);
  const valueCipher = createCipheriv(ALGORITHM, dataKey, valueIv);
  const value = Buffer.concat([valueCipher.update(plaintext, 'utf8'), valueCipher.final()]);

  const keyIv = randomBytes(12);
  const keyCipher = createCipheriv(ALGORITHM, wrappingKey, keyIv);
  const wrapped = Buffer.concat([keyCipher.update(dataKey), keyCipher.final()]);
  dataKey.fill(0);

  return {
    version: 1,
    value: value.toString('base64'),
    valueIv: valueIv.toString('base64'),
    valueTag: valueCipher.getAuthTag().toString('base64'),
    dataKey: wrapped.toString('base64'),
    dataKeyIv: keyIv.toString('base64'),
    dataKeyTag: keyCipher.getAuthTag().toString('base64')
  };
}

function open(sealed, wrappingKey) {
  const keyDecipher = createDecipheriv(ALGORITHM, wrappingKey, Buffer.from(sealed.dataKeyIv, 'base64'));
  keyDecipher.setAuthTag(Buffer.from(sealed.dataKeyTag, 'base64'));
  const dataKey = Buffer.concat([keyDecipher.update(Buffer.from(sealed.dataKey, 'base64')), keyDecipher.final()]);

  const decipher = createDecipheriv(ALGORITHM, dataKey, Buffer.from(sealed.valueIv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.valueTag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(sealed.value, 'base64')), decipher.final()]).toString('utf8');
  dataKey.fill(0);
  return plaintext;
}

function hostList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw failure(`${field} must be an array of hostnames`);
  if (value.length > 16) throw failure(`${field} supports at most 16 hosts`);
  return value.map((entry) => {
    const host = text(entry, `${field} entry`, { required: true, max: 253 }).toLowerCase();
    if (!HOST_PATTERN.test(host)) throw failure(`${field} entry ${host} is not a hostname`);
    return host;
  });
}

// A credential may only be sent where it was issued to be sent. Exact hostname, or
// one level of wildcard — deliberately not a substring match, which would let
// api.example.com.attacker.test through.
export function hostPermitted(hosts, url) {
  // No list means no restriction. That is the opt-in behaviour, and it is why
  // publicCredential reports `restricted` — a caller must be able to tell an
  // unrestricted key from one limited to a host, and so must the operator.
  if (!hosts?.length) return true;
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hosts.some((allowed) => {
    if (!allowed.startsWith('*.')) return allowed === hostname;
    const suffix = allowed.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  });
}

function makeId(name, existingIds) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'credential';
  if (!existingIds.has(base) && ID_PATTERN.test(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  return `${base}-${randomUUID().slice(0, 8)}`;
}

export function publicCredential(record) {
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    header: record.header,
    hosts: [...record.hosts],
    // Enough to tell one key from another without disclosing any of it. Null
    // until the key has a value at all.
    hint: record.hint,
    // A key created by writing a placeholder has no value yet and cannot be used.
    complete: Boolean(record.sealed),
    // Whether the host list actually limits anything. Reported rather than
    // inferred from an empty array, so the interface can say which it is.
    restricted: (record.hosts?.length ?? 0) > 0,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

// The last four characters, so an operator can recognise a key they already hold
// without the record disclosing it. Short values get no hint at all.
function hintFor(value) {
  return value.length >= 12 ? `…${value.slice(-4)}` : '…';
}

export function createCredentialStore({ records, persist, keyProvider = environmentKeyProvider() }) {
  function requireRecord(id) {
    const record = records.get(id);
    if (!record) throw failure('Credential not found', 404);
    return record;
  }

  // A key waiting to be completed is a normal state, not a corrupt one, so the
  // refusal names what to do rather than reporting a fault.
  function requireComplete(record) {
    if (!record.sealed) {
      throw failure(`The key ${record.name} has no value yet. Add its value before using it.`, 409);
    }
  }

  function normalize(input, { currentId = null } = {}) {
    const name = text(input.name, 'name', { required: true, max: 64 });
    if (!NAME_PATTERN.test(name)) throw failure('name must be alphanumeric with dashes or underscores');
    const duplicate = [...records.values()].find((item) => item.name.toLowerCase() === name.toLowerCase() && item.id !== currentId);
    if (duplicate) throw failure('A credential with that name already exists', 409);

    const type = text(input.type, 'type') ?? 'api-key';
    if (!CREDENTIAL_TYPES.includes(type)) {
      throw failure(`type must be one of ${CREDENTIAL_TYPES.join(', ')}`);
    }

    // Optional. It is only meaningful for the older path that sends a credential
    // as a header; a placeholder puts the value exactly where it is written.
    const header = text(input.header, 'header', { max: 64 }) ?? null;
    if (header && !HEADER_PATTERN.test(header)) throw failure('header must be a valid HTTP header name');

    // Opt-in. An empty list means this key is not limited to any host, which is
    // a real loss of protection for a remote connector and is reported as such
    // rather than left to be assumed — see hostPermitted.
    const hosts = hostList(input.hosts, 'hosts');
    return { name, type, header, hosts };
  }

  return {
    keyProviderStatus() {
      return { name: keyProvider.name, available: keyProvider.available, protects: keyProvider.protects };
    },

    list() {
      return [...records.values()].map(publicCredential);
    },

    get(id) {
      return publicCredential(requireRecord(id));
    },

    byName(name) {
      const match = [...records.values()].find((item) => item.name.toLowerCase() === String(name).toLowerCase());
      return match ? publicCredential(match) : null;
    },

    async create(input) {
      const fields = normalize(input);
      // A key with no value yet is a real record waiting to be completed, which
      // is what lets a placeholder in a connector create the entity to fill in.
      // It is deliberately not treated as an error: nothing can use it until it
      // has a value, and resolving one says exactly that.
      const value = input.value === undefined || input.value === null || input.value === ''
        ? null
        : text(input.value, 'value', { required: true, max: 4096 });
      // Without a key provider nothing can ever be sealed, so a record created
      // now could never be completed. Refusing is the same answer the store
      // gives a value, rather than accepting something permanently unusable.
      if (value === null && !keyProvider.available) keyProvider.key();
      const record = {
        ...fields,
        id: makeId(fields.name, new Set(records.keys())),
        sealed: value === null ? null : seal(value, keyProvider.key()),
        hint: value === null ? null : hintFor(value),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      records.set(record.id, record);
      await persist();
      return publicCredential(record);
    },

    async update(id, input) {
      const record = requireRecord(id);
      const fields = normalize({ ...record, ...input }, { currentId: id });
      // Validate everything before touching the record. Doing this after the
      // Object.assign below meant a `value` that was present but unusable — null,
      // empty, a number — cleared the host check, threw here, and left the
      // widened host list written and persisted with the original key intact.
      const value = input.value === undefined
        ? undefined
        : text(input.value, 'value', { required: true, max: 4096 });
      const sealed = value === undefined ? undefined : seal(value, keyProvider.key());

      // Widening where a credential may be sent is the same act as handing it to
      // a new destination, so it takes the same proof: supply the value again.
      // Without this, the host list defends the connector's url and nothing else —
      // an editor could simply move the allowlist to wherever they wanted the
      // credential sent, which is not a boundary at all.
      const hostsChanged = fields.hosts.join(',') !== record.hosts.join(',');
      // Keyed off whether a list existed to change, not off whether a value is
      // present. A key with hosts and no value could otherwise be repointed and
      // then completed, and the redirect was never proved.
      if (hostsChanged && value === undefined && record.hosts.length) {
        throw failure(
          'Changing permitted hosts requires supplying the credential value again, '
          + 'because it changes where the credential may be sent',
          403
        );
      }

      Object.assign(record, fields, { updatedAt: new Date().toISOString() });
      // A value is replaced, never read back and edited. Keyed off the value
      // rather than the sealed result: a key provider that returned something
      // falsy would otherwise skip this write and leave the hint and ciphertext
      // describing the old value, which is the bug this ordering exists to close.
      if (value !== undefined) Object.assign(record, { sealed, hint: hintFor(value) });
      await persist();
      return publicCredential(record);
    },

    async remove(id) {
      requireRecord(id);
      records.delete(id);
      await persist();
    },

    // Only for handing a credential to the worker that needs it, and only after
    // the destination has been checked. Never reachable from a browser route.
    resolveForHost(id, url) {
      const record = requireRecord(id);
      requireComplete(record);
      if (!hostPermitted(record.hosts, url)) {
        throw failure(
          `Credential ${record.name} is not permitted for ${url}; it is limited to ${record.hosts.join(', ')}`,
          403
        );
      }
      return { header: record.header, value: open(record.sealed, keyProvider.key()) };
    },

    // A local process has no destination, so a host list cannot constrain where
    // this value goes. Deliberately a separate, named method: reusing
    // resolveForHost with a fabricated url would hide that the check did not
    // happen, and this way the one caller that skips it is visible.
    resolveForLocalProcess(id) {
      const record = requireRecord(id);
      requireComplete(record);
      return { header: record.header, value: open(record.sealed, keyProvider.key()) };
    },

    // Constant-time comparison, used by tests and by any future verification path
    // so a value is never compared with ===.
    matches(id, candidate) {
      const record = requireRecord(id);
      requireComplete(record);
      const actual = Buffer.from(open(record.sealed, keyProvider.key()));
      const supplied = Buffer.from(String(candidate));
      const equal = actual.length === supplied.length && timingSafeEqual(actual, supplied);
      actual.fill(0);
      return equal;
    }
  };
}
