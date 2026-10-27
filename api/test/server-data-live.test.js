// GET /api/data/live: a copy of the workout a device is running, kept beside the profile so a
// script watching it sees notes and progress mid-session — while `active` itself stays
// device-local and never reaches the stored document or another device.
//
// Spawns the server the way server-data-rev-endpoint.test.js does (PORT=0, boundPort).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SECRET = 'test-secret-live';
const uid = 'u_live_1';
const cookie = () => { const p = `${uid}:${Date.now() + 86400000}:0`; return `gymsid=${p}.${crypto.createHmac('sha256', SECRET).update(p).digest('base64url')}`; };

const active = (over = {}) => ({
  id: 'w-live', d: '2026-10-27', start: 1793120000000, name: 'Lower Push', note: 'planks should be timed',
  entries: [
    { id: '0463', note: 'felt it in the low back', sets: [{ done: true, r: 12 }, { r: 12 }] },
    { id: '0605', sets: [{ done: true }] }
  ],
  ...over
});

test('the workout a device is running is readable mid-session, and only by its owner', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-live-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [{ id: uid, name: 'L', created: new Date().toISOString() }], creds: [], subs: [], invites: [] }));
  const child = spawn(process.execPath, ['server.js'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' } });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const base = `http://127.0.0.1:${await boundPort(child, () => log)}`;
  const h = { cookie: cookie(), origin: 'http://localhost:8080', 'content-type': 'application/json' };
  const live = async () => (await (await fetch(`${base}/api/data/live`, { headers: h })).json()).live;
  let rev = 0;
  const put = async (state, baseRev = rev) => {
    const r = await fetch(`${base}/api/data`, { method: 'PUT', headers: h, body: JSON.stringify({ state: { workouts: [], routines: [], ...state }, baseRev }) });
    if (r.status === 200) rev = (await r.json()).rev;
    return r.status;
  };

  await t.test('nobody signed in gets nothing', async () => {
    assert.equal((await fetch(`${base}/api/data/live`)).status, 401);
  });

  await t.test('no workout running: none', async () => {
    assert.equal(await live(), null);
  });

  await t.test('a push carrying a running workout makes its notes and progress readable', async () => {
    assert.equal(await put({ active: active() }), 200);
    const l = await live();
    assert.equal(l.note, 'planks should be timed');
    assert.equal(l.name, 'Lower Push');
    assert.deepEqual(l.entries[0], { id: '0463', done: 1, sets: 2, note: 'felt it in the low back' });
    assert.deepEqual(l.entries[1], { id: '0605', done: 1, sets: 1 });
    assert.equal(typeof l.at, 'number');
  });

  await t.test('the stored profile still never holds the running workout', async () => {
    const { state } = await (await fetch(`${base}/api/data`, { headers: h })).json();
    assert.equal('active' in state, false);
    assert.equal(fs.existsSync(path.join(dataDir, `live-${uid}.json`)), true);
  });

  await t.test('a refused (stale) push does not move the copy', async () => {
    assert.equal(await put({ active: active({ note: 'from a stale copy' }) }, rev - 1), 409);
    assert.equal((await live()).note, 'planks should be timed');
  });

  await t.test('a push without a running workout — another device — leaves the copy alone', async () => {
    assert.equal(await put({}), 200);
    assert.equal((await live()).note, 'planks should be timed');
  });

  await t.test('an edited note replaces the old one on the next push', async () => {
    assert.equal(await put({ active: active({ note: 'planks 60s' }) }), 200);
    assert.equal((await live()).note, 'planks 60s');
  });

  await t.test('once the profile holds the finished workout, none is served', async () => {
    assert.equal(await put({ workouts: [{ id: 'w-live', d: '2026-10-27', start: 1793120000000, entries: [] }] }), 200);
    assert.equal(await live(), null);
  });

  await t.test('a push refused after the conflict check (400) does not move the copy', async () => {
    // Nested deeper than JSON.stringify can walk: the server parses it, then refuses it at the
    // write (400 'invalid state'), after the conflict check has passed.
    const deep = '{"x":'.repeat(20000) + '{}' + '}'.repeat(20000);
    const r = await fetch(`${base}/api/data`, { method: 'PUT', headers: h, body: JSON.stringify({ state: { workouts: [], routines: [], active: active({ id: 'w-x', note: 'refused' }), deep: '{' }, baseRev: rev }).replace('"{"', deep) });
    assert.equal(r.status, 400);
    assert.equal(await live(), null, 'still the filed w-live, served as none');
  });

  await t.test('re-opening a filed workout to edit it is not a session running', async () => {
    assert.equal(await put({ workouts: [], active: active({ id: 'w-edit', editingWorkoutId: 'w-old', note: 'fixing history' }) }), 200);
    assert.notEqual((await live())?.note, 'fixing history');
  });

  await t.test('notes are kept to a bounded length', async () => {
    assert.equal(await put({ active: active({ id: 'w-long', note: 'x'.repeat(5000) }) }), 200);
    assert.equal((await live()).note.length, 2000);
  });

  await t.test('a copy not refreshed for 12 hours is stale', async () => {
    assert.equal(await put({ workouts: [], active: active({ id: 'w-next' }) }), 200);
    const f = path.join(dataDir, `live-${uid}.json`);
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), at: Date.now() - 13 * 3600 * 1000 }));
    assert.equal(await live(), null);
  });
});

test('deleting an account removes its running-workout copy too', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-live-del-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({ users: [{ id: 'u_admin', name: 'A', created: now }, { id: uid, name: 'L', created: now }], creds: [], subs: [], invites: [] }));
  fs.writeFileSync(path.join(dataDir, `live-${uid}.json`), JSON.stringify({ id: 'w', note: 'private', entries: [], at: Date.now() }));
  const child = spawn(process.execPath, ['server.js'], { cwd: API, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost', ADMIN_UIDS: 'u_admin' } });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const base = `http://127.0.0.1:${await boundPort(child, () => log)}`;
  const p = `u_admin:${Date.now() + 86400000}:0`;
  const adminCookie = `gymsid=${p}.${crypto.createHmac('sha256', SECRET).update(p).digest('base64url')}`;
  const r = await fetch(`${base}/api/admin/user/delete`, { method: 'POST', headers: { cookie: adminCookie, origin: 'http://localhost:8080', 'content-type': 'application/json' }, body: JSON.stringify({ id: uid }) });
  assert.equal(r.status, 200, await r.text());
  // A deleted person's notes must not outlive the account on disk.
  assert.equal(fs.existsSync(path.join(dataDir, `live-${uid}.json`)), false);
});
