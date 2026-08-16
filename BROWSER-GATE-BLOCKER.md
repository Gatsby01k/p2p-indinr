# DEL-10 — the browser-gate blockers, and how each was closed

**Status: closed.** 229/229 browser checks pass against the built
application. This file is kept rather than deleted because what it
recorded is the most useful thing in the stage: three complete,
correct, tested server-side capabilities that **no person could reach**,
and the fact that only a browser running the real product could find
them.

The original text claimed one blocker. There were four, and the first
one hid the rest.

---

## 1 · There was no way to enrol a second factor · CLOSED

`beginMfaEnrolment`, `confirmMfaEnrolment` and `verifyMfaForSession` had
existed and been tested since DEL-03. No component called any of them, so
`/app/ops` refused every operator with *"set up an authenticator app in
Security"* and Security offered nothing.

**Closed by** `src/components/flows/MfaFlow.tsx` — enrolment with a QR
encoded in the browser, single-use recovery codes shown once, the
per-session challenge, and a validated same-origin return.

## 2 · Enrolling signed you out of the device you enrolled from · CLOSED

Even with the screen built, the journey ended at a login page.
`confirmMfaEnrolment` bumped the account's session version — correctly,
so no *other* device inherits the new authority — but it bumped the
session doing the confirming too. The person finished enrolling, was
signed out, and had no way to answer a factor they now held.

**Closed by** `bumpSessionVersionIn(tx, userId, keepSessionId)`. Every
other session still dies; the device that just proved possession of the
new factor survives, exactly as `revokeAllSessions` already treated
"sign out my other devices". Covered by
`tests/integration/verificationQueue.test.ts`, including that a session
id belonging to somebody else cannot be smuggled through it.

## 3 · No verification case could ever be decided · CLOSED

The largest of the four, and invisible until the gate ran against its own
fresh database.

Verification stopped being a boolean in DEL-03 and became a **case** that
a reviewer who is not the subject must decide. `decideVerification` was
written and tested. Nothing in the product could call it: no action, no
queue, no screen. So every submitted case stayed `SUBMITTED`,
`identity_verified` was never written, and **every attempt to join a
protected deal was refused, for everybody, permanently** — the core
journey of the product could not be completed by anyone.

It stayed hidden because the shared development database held accounts
the integration suite had verified by calling the function directly.

**Closed by** `/app/ops/verification` (a reviewer queue with a mandatory
written reason and no controls at all on one's own case),
`decideVerificationAction`, and an honest `/app/profile/verification`
that shows **In review** instead of a button that appears to do nothing.

## 4 · A tall dialog hung off the bottom of the screen · CLOSED

Found while driving the payment-method form at 1280×900. `.sheet` is
centred with `translate(-50%, -50%)`; its animation was `rise`, which
ends at `transform: none`, and `animation-fill-mode: both` made that
final value permanent. The dialog measured top 450, bottom 1136 in a
900px window, and could not scroll — its content fitted its own box. The
only submit button was off-screen. **Nobody on a laptop could add a way
to be paid**, and the same applied to every tall dialog.

**Closed by** `@keyframes dialog-in`, which expresses the same six-pixel
rise as an offset from the centred position. Guarded by a browser check
at all seven widths that requires an open dialog to fit the window or to
scroll.

---

## What actually found these

Not review, and not the unit or integration suites — all of which were
green throughout. Two changes to how the gate runs did it:

- **Running the built application** rather than `next dev`, so the
  timings, the bundles and the DOM are the ones people get;
- **Running against a database of its own**, empty at the start of every
  run, so no fixture created by a test could stand in for onboarding a
  real person has to complete.

Every journey in the gate now walks the whole path a person walks: sign
in with a code read from the sandbox mailbox, submit the three
verification steps, have a reviewer approve them, add a way to be paid,
create a deal, join it, pay it, confirm it. Nothing is seeded, and the
one out-of-band step — granting an operator role — goes through the same
CLI an administrator would use.
