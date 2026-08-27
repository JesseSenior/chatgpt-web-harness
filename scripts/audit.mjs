import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .filter(key => value[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function permissionDigest(permissionRevision, allowedNextCalls) {
  return sha256(canonical({
    permission_revision: permissionRevision,
    allowed_next_calls: allowedNextCalls
  }));
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(temporary, text);
  fs.renameSync(temporary, file);
}

export function readEvents(runDirectory) {
  const directory = path.join(runDirectory, 'events');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter(name => /^\d{6}\.json$/.test(name))
    .sort()
    .map(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')));
}

export function lastEventHash(runDirectory) {
  return readEvents(runDirectory).at(-1)?.event_sha256 || null;
}

export function appendEvent(runDirectory, type, payload = {}) {
  const events = readEvents(runDirectory);
  const seq = events.length + 1;
  const record = {
    seq,
    event_id: crypto.randomUUID(),
    at: new Date().toISOString(),
    type,
    payload,
    prev_sha256: events.at(-1)?.event_sha256 || null
  };
  record.event_sha256 = sha256(canonical(record));
  atomicWrite(
    path.join(runDirectory, 'events', `${String(seq).padStart(6, '0')}.json`),
    JSON.stringify(record, null, 2) + '\n'
  );
  return record;
}

export function verifyEventChain(runDirectory) {
  const events = readEvents(runDirectory);
  let previous = null;
  let replayState = null;
  let replayPermission = null;
  const failures = [];

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.seq !== index + 1) failures.push(`event ${event.seq}: non-contiguous sequence`);
    if (event.prev_sha256 !== previous) failures.push(`event ${event.seq}: previous hash mismatch`);
    const { event_sha256, ...unsigned } = event;
    if (sha256(canonical(unsigned)) !== event_sha256) failures.push(`event ${event.seq}: hash mismatch`);
    if (event.payload?.state_before !== undefined) {
      if (replayState !== null && event.payload.state_before !== replayState) {
        failures.push(`event ${event.seq}: state replay mismatch`);
      }
      replayState = event.payload.state_after;
    }
    if (event.type === 'permissions_issued') {
      const revision = event.payload?.permission_revision;
      const calls = event.payload?.allowed_next_calls;
      const normalized = Array.isArray(calls) ? [...new Set(calls.map(String))].sort() : null;
      const expectedRevision = (replayPermission?.permission_revision || 0) + 1;
      if (!normalized || canonical(calls) !== canonical(normalized)) {
        failures.push(`event ${event.seq}: invalid permission calls`);
      }
      if (!Number.isInteger(revision) || revision !== expectedRevision) {
        failures.push(`event ${event.seq}: invalid permission revision`);
      }
      if (normalized && event.payload.permission_sha256 !== permissionDigest(revision, normalized)) {
        failures.push(`event ${event.seq}: invalid permission hash`);
      }
      if (normalized && Number.isInteger(revision)) {
        replayPermission = {
          permission_revision: revision,
          allowed_next_calls: normalized,
          permission_sha256: event.payload.permission_sha256,
          event_sha256
        };
      }
    }
    previous = event_sha256;
  }

  return {
    valid: failures.length === 0,
    failures,
    events,
    replay_state: replayState,
    replay_permission: replayPermission,
    head_sha256: previous
  };
}
