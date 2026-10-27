---
title: "feat: Mirror the in-progress workout to the server so notes reach the listener mid-session"
type: feat
status: active
date: 2026-10-27
---

# feat: Mirror the in-progress workout to the server so notes reach the listener mid-session

**Target repo:** its-everdred/openGym (fork)

## Overview

Keep a read-only server-side copy of the workout you are running, refreshed on every push, and
expose it to the owner's token. The notes listener reads it, so a session or exercise note you
save mid-workout is picked up within about a minute instead of only after Finish. The `active`
workout itself stays device-local: no client ever receives, merges or resumes the copy.

---

## Problem Frame

Notes written during a workout only reach the server when the workout is finished: the client
already sends the whole state (including `active`) on every `update()` after a 1.5 s debounce
(`frontend/src/store/useStore.js` persist/doPush), but `PUT /api/data` drops it
(`delete body.state.active` in `api/server.js`). The owner wants to leave a note, tap Save, and
have the agent watching `scripts/notes-listener.mjs` act on it while they are still in the gym.

Separately, the listener misses notes written on a single exercise during a session
(`entries[].note` on finished workouts, written by `buildCompletedWorkout` in
`frontend/src/lib/finish-workout.js`).

---

## Requirements Trace

- R1. A session note or exercise note saved mid-workout is visible to the owner's token within one push (≈1.5 s) and to the listener within one poll.
- R2. Progress so far (exercises, done sets) is visible in the same copy.
- R3. No client ever adopts, merges or resumes the copy; the synced profile document is unchanged.
- R4. The copy is removed with the account, and is not served once its workout is finished or stale.
- R5. The listener reports live notes, and exercise notes on finished workouts, once per text.
- R6. No new dependencies; no auth/session changes; existing API tests stay green; `api/openapi.yaml` documents the route.

---

## Scope Boundaries

- No frontend change: the client already pushes `active`. (So no Netlify deploy is needed.)
- No cross-device resume of an in-progress workout — the upstream design keeps that device-local on purpose.
- No change to the merge/stamp rules (`api/sync-stamps.js`, `frontend/src/lib/sync-merge.js`): the copy lives outside the state document.
- MCP server does not read the copy (could later; not asked).

---

## Context & Research

### Relevant Code and Patterns

- `api/server.js` `PUT /api/data`: conflict check, then `delete body.state.active`; `stateFile(uid)`; `atomicWrite`; admin user delete unlinks `stateFile(u.id)`.
- `api/server.js` `GET /api/data/rev`: minimal authed read route to mirror.
- `api/test/server-data-rev-endpoint.test.js`: spawn-the-server test pattern (PORT=0, `boundPort`, HMAC cookie).
- `api/test/openapi-routes.test.js`: every route must be in `api/openapi.yaml`; `website/api.html` is generated (`scripts/build-api-docs.mjs --check` in CI).
- `frontend/src/lib/finish-workout.js`: entry note shape (`entry.note`, `notePin`) and session note (`active.note`).
- `scripts/notes-listener.mjs` + `scripts/notes-listener.test.mjs`: `collectNotes` / `newNotes`.

### Institutional Learnings

- None in `docs/solutions/` (directory absent).

### External References

- None needed: strong local patterns.

---

## Key Technical Decisions

- **Sidecar file, not a field in the state document** (`live-<uid>.json` beside `state-<uid>.json`): a field would flow through pull/merge/stamp on every device and need parity changes on both sides; a sidecar touches none of it (R3).
- **Distilled copy, not the raw `active`**: store start time, name, routine ids, session note, and per entry the exercise id, note and done/total sets, plus `at`. Bounded size, nothing a client needs to resume, and no media/blob fields.
- **Written only after the conflict check passes**: a 409'd push is retried by the client with the same `active`, so nothing is lost and a refused write never moves the copy.
- **A push without `active` does not clear the copy**: another device of the same person pushes without it. Instead the read route serves nothing when a finished workout with the same start exists in the stored state, or when the copy is older than 12 h (R4).
- **Read route `GET /api/data/live`**: owner session/bearer only, `{ live: null }` when none. Separate from `GET /api/data` so the listener can poll it every tick (the client's active-only pushes still bump `rev`, so the existing rev poll also catches them).

---

## Open Questions

### Resolved During Planning

- Does the client push while a workout runs? Yes: `update()` → `persist(S, true)` → debounced `pushState()` sends `{ state: S }` with `active` (`useStore.js` doPush).
- Is `rev` bumped by an active-only push? Yes: every accepted PUT writes `_rev = curRev + 1`.

### Deferred to Implementation

- Exact field list of the distilled copy, beyond the essentials above, after reading `active`'s shape in `frontend/src/lib/workout-model.js`.

---

## Implementation Units

- [x] U1. **Server: keep a distilled live copy on each accepted push**

**Goal:** Write `live-<uid>.json` from `body.state.active` before it is dropped; remove it with the account.

**Requirements:** R1, R2, R3, R4

**Dependencies:** None

**Files:**
- Modify: `api/server.js`
- Test: `api/test/server-data-live.test.js`

**Approach:**
- After the 409 check, if `body.state.active` is an object, write the distilled copy with `atomicWrite` (0600). Never fail the PUT because of it (log and continue).
- Admin user delete also unlinks the live file.

**Patterns to follow:** `stateFile`, `atomicWrite`, the admin-delete unlink beside it.

**Test scenarios:**
- Happy path: PUT with `active` (note + one entry with a note and one done set) → `GET /api/data/live` returns the note, the entry note, done 1/2, and `GET /api/data` has no `active` and no copy fields.
- Edge: a later PUT without `active` keeps the copy (another device's push).
- Edge: once the stored state holds a workout whose `start` equals the copy's start, `GET /api/data/live` returns `{ live: null }`.
- Error path: a PUT refused with 409 does not change the copy.
- Error path: unauthenticated `GET /api/data/live` → 401.

**Verification:** new test file passes; full api suite green.

- [x] U2. **Server: `GET /api/data/live` route + OpenAPI**

**Goal:** Serve the copy to its owner, applying the finished/stale rules.

**Requirements:** R1, R4, R6

**Dependencies:** U1

**Files:**
- Modify: `api/server.js`, `api/openapi.yaml`, `website/api.html` (regenerated)
- Test: `api/test/server-data-live.test.js`, `api/test/openapi-routes.test.js` (existing, must pass)

**Approach:** mirror `GET /api/data/rev`; stale after 12 h by `at`.

**Test scenarios:** covered in U1's file; plus the openapi route test enumerates the new route.

**Verification:** `openapi-routes` test and `build-api-docs --check` pass.

- [x] U3. **Listener: live notes and exercise notes**

**Goal:** Report notes from the live copy and from finished workouts' entries.

**Requirements:** R5

**Dependencies:** U2

**Files:**
- Modify: `scripts/notes-listener.mjs`
- Test: `scripts/notes-listener.test.mjs`

**Approach:**
- `collectNotes(S, live)`: add `workout:<id>:ex:<exId>` for finished entry notes, and `live:<start>` / `live:<start>:ex:<exId>` for the copy.
- Each tick also GETs `/api/data/live`. A live note that later lands on the finished workout fires once more under the workout id; acceptable (text is the same — the agent sees it was already handled) — or dedupe by text; decide in implementation.

**Test scenarios:**
- Happy path: a live copy with a session note and an entry note yields two notes with the session name.
- Happy path: a finished workout's entry note is reported; a plan cue (`target.note`) still is not.
- Edge: `live` null or malformed → no notes, no throw.
- Edge: an edited live note fires again; an unchanged one does not.

**Verification:** listener tests pass; live run prints a test note saved mid-workout.

---

## System-Wide Impact

- **Interaction graph:** only `PUT /api/data` (one added write) and a new read route; the reminder tick, Coach, MCP and admin readers keep reading the unchanged state file.
- **State lifecycle risks:** a discarded workout leaves a copy until a 12 h staleness cutoff — harmless (read-only, owner-only).
- **Unchanged invariants:** `GET /api/data` never returns `active`; clients never receive the copy; merge/stamp code untouched.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Extra disk write per push slows the hot path | Small distilled JSON; one write; failures logged not thrown |
| Upstream sync conflicts in `api/server.js` | Change is a few isolated lines + one route; weekly sync opens an issue on conflict |
| Privacy: another copy of training data on disk | Same directory/permissions as the state file; removed with the account |

---

## Documentation / Operational Notes

- Deploy: back end only (`railway up --service api`), then a live check with a note saved mid-workout. No Netlify deploy.

## Sources & References

- Related code: `api/server.js` (`PUT /api/data`, `GET /api/data/rev`), `frontend/src/store/useStore.js` (doPush), `scripts/notes-listener.mjs`
- Related PRs: its-everdred/openGym#5 (listener)
