---
date: 2026-10-11
topic: apple-health-two-way-sync
---

# Apple Health Two-Way Sync

## Problem Frame

openGym on iPhone only reaches Apple Health through a one-time `export.xml` weight import (`docs/DATA_IMPORTS.md`). Weigh-ins from a smart scale, Apple Watch runs, and sleep/recovery never reach openGym, and openGym workouts never close Activity rings or show up in Health. Android already writes to Health Connect (write-only, `docs/MOBILE.md`). This feature adds a **two-way** HealthKit sync to the existing iOS Capacitor target (`frontend/ios`) so Apple Health and openGym stay in step. Upstream's roadmap plans HealthKit *export only* for an iOS App Store build (v1.4.8, 2027-03); this goes further on our fork.

---

## Actors

- A1. iPhone user: turns sync on, picks what moves in each direction, trains and weighs in.
- A2. Other Health sources: Apple Watch, smart scales, other fitness apps writing to HealthKit.
- A3. openGym server: the self-hosted sync server that carries Health-derived data to the user's other devices and to the AI coach.

---

## Key Flows

- F1. Turn on sync
  - **Trigger:** A1 opens Settings → Apple Health and turns it on.
  - **Steps:** pick read and write categories (all on by default) → iOS permission prompt for exactly those categories → full backfill both ways with visible progress → steady-state sync.
  - **Outcome:** past openGym workouts and weigh-ins are in Health; past Health weight, body composition, external workouts and recovery data are in openGym.
  - **Escape:** a denied category is shown as off with a link to iOS Settings; other categories still sync.
  - **Covered by:** R1–R4, R14, R15

- F2. Scale weigh-in arrives in the background
  - **Trigger:** A2 writes a weight sample to HealthKit while openGym is closed.
  - **Steps:** background delivery wakes openGym → it applies the weight conflict rule → syncs to A3.
  - **Outcome:** the weigh-in appears on the laptop without opening the phone app.
  - **Covered by:** R7, R11, R16

- F3. Turn off sync
  - **Trigger:** A1 turns sync off.
  - **Steps:** ask whether to keep or remove what openGym wrote to Health (same choice Health Connect offers).
  - **Outcome:** no further reads or writes; Health-derived data already in openGym stays unless the user removes it.
  - **Covered by:** R18

---

## Requirements

**Settings (every behavior is user-configurable; defaults below)**
- R1. An Apple Health card in Settings, shown only in the native iOS app, off until the user turns it on.
- R2. Per-category toggles for **read**: body weight, body composition, external workouts, recovery signals (sleep, resting HR, HRV). Default: all on.
- R3. Per-category toggles for **write**: workouts, body weight, active energy, body composition. Default: all on.
- R4. iOS permission is requested only for enabled categories, and only when toggled on.
- R5. Weight conflict policy setting. Default: **most recent wins**. Alternatives offered: openGym entry wins, keep all readings.
- R6. Backfill setting on first enable. Default: **all history, both directions**. Alternatives: last 90 days, none.
- R7. Background sync toggle. Default: on (foreground + background). Off = foreground only (after saves, on app foreground, at launch, like Health Connect).
- R8. Server-sync setting for Health-derived data, per read category. Default: **sync to server**. Off = that category stays on this iPhone only.

**Writing to Health**
- R9. Each finished openGym workout is written as a Health workout: start/end, name, type (strength vs the matching cardio type, same mapping logic as Health Connect), the exercises and sets as notes, and estimated active energy when enabled. Workouts without a real start and end are skipped, not given invented times.
- R10. Edits in openGym rewrite the Health record; deletes in openGym remove it. Re-writing never duplicates.

**Reading from Health**
- R11. Body weight and body composition from other sources merge into openGym's weigh-ins and measurements under the R5 policy.
- R12. Workouts from other sources appear as **read-only activities** in history, heatmap and calendar (e.g. "Run · 32 min · via Apple Watch"). They have no sets, are not editable, and do not affect progression, PRs, or volume.
- R13. Recovery signals show as trends on Stats/Home and are passed to the AI coach as context when the coach is enabled. They never change plans automatically.
- R14. Records openGym itself wrote are never read back as external data (no echo).
- R15. A record deleted in Health by its source disappears from openGym on next sync.

**Status and trust**
- R16. The card shows last sync time, per-category status (on, off, denied), and backfill progress.
- R17. Sync failures are visible on the card and never block saving a workout or weigh-in.
- R18. Turning sync off asks: keep what openGym wrote to Health, or remove exactly those records.

---

## Acceptance Examples

- AE1. **Covers R5, R11.** Given policy "most recent wins", openGym has 80.5 kg logged at 07:00 and a scale writes 80.2 kg at 07:30. The day's weigh-in becomes 80.2 kg. With "openGym entry wins" it stays 80.5 kg.
- AE2. **Covers R12, R14.** An Apple Watch run appears as a read-only activity. The openGym strength session written to Health the same day does not reappear as an external activity.
- AE3. **Covers R8, R13.** With recovery set to "this iPhone only", the laptop shows no sleep/HRV and the server-side AI coach gets no recovery context.
- AE4. **Covers R4, R16.** The user denies the HRV permission. The card shows HRV as "denied, open iOS Settings", and weight still syncs.

---

## Success Criteria

- A scale weigh-in shows up in openGym on the laptop without the user opening the iPhone app.
- An openGym workout closes Activity rings and appears in Health with correct type and times.
- No duplicates in either app after repeated syncs, edits, and an off-then-on cycle.
- A planner can write the implementation plan without inventing product behavior. Every open item below is technical or research.

---

## Scope Boundaries

- Android Health Connect stays write-only. Making it two-way is a separate ticket.
- PWA / browser builds: no HealthKit. The card does not appear.
- External workouts are not converted into editable openGym workouts and do not count toward volume, PRs, or progression.
- No readiness score or automatic deloads from recovery data.
- No Apple Watch app or watch-side rest timer.
- No public App Store release. Distribution is TestFlight for the user and a few testers.

---

## Key Decisions

- External workouts are read-only: this avoids conflicts with the source app and keeps progression data clean.
- Weight conflict default is "most recent wins" (user choice). This changes today's import rule ("existing days are left alone"), so the existing `export.xml` import should follow the same setting or be documented as different.
- Health-derived data syncs to the server by default, so the laptop and the AI coach can use it. This differs from Health Connect's "this phone only" state; sync *settings and fingerprints* can still stay device-local.
- All behavior is user-configurable; the defaults come from the user's answers.

---

## Dependencies / Assumptions

- Paid Apple Developer Program account ($99/yr) for TestFlight and the HealthKit entitlement.
- A Mac with Xcode to build and upload builds (not verified that the user has one).
- Sleep, resting HR and HRV have no existing data model in openGym (light grep found none; unverified). Body measurements, including body fat, already exist (`frontend/src/lib/measurements.js`).
- The existing `frontend/src/lib/health-sync.js` and `health-connect.js` are the pattern to extend, but they are not verified as platform-neutral.

---

## Outstanding Questions

### Resolve Before Planning

(none)

### Deferred to Planning

- [Affects R2, R3, R9][Needs research] Which Capacitor HealthKit plugin (community vs custom Swift plugin). `CLAUDE.md` makes dependency-light a hard constraint, and Health Connect used a hand-written plugin (`HealthConnectPlugin.java`), so a custom Swift plugin is the likely fit, and does it support workouts, background delivery, anchored queries and deletes?
- [Affects R7][Needs research] HealthKit background delivery limits (frequency, which types, app-killed behavior) and what is realistic for "scale weigh-in lands without opening the app".
- [Affects R14, R10][Technical] How to tag and recognize openGym-written records (source bundle, metadata sync identifier/version) and replace them without duplicates.
- [Affects R9][Needs research] How to estimate active energy for strength sessions (MET-based on duration and body weight?) and how to label it as an estimate.
- [Affects R8, R13][Technical] Where Health-derived data lives in the synced state and server model, and how per-category "this iPhone only" is enforced.
- [Affects R11, R5][Technical] How "keep all readings" fits the current one-weigh-in-per-day model.
- [Affects R6][Technical] Backfill performance for years of HealthKit samples, plus resumability if the app is killed mid-backfill.
- [Affects all][Needs research] TestFlight setup: entitlements, privacy strings (`NSHealthShareUsageDescription`, `NSHealthUpdateUsageDescription`), App Store Connect HealthKit review notes for external testers.
- [Affects all][Technical] Whether to contribute back upstream (the upstream roadmap overlaps v1.4.8) and how to keep the fork rebasable.

---

## Next Steps

-> /ce-plan for structured implementation planning
