import 'server-only';

/**
 * The application-service READ surface.
 *
 * Server components import from here and never from `@/server/sandbox/*`,
 * so the adapter behind these functions can be replaced without touching a
 * screen (UX-01 §9). The mutation half lives in `./actions`, which client
 * components import; the shared types live in `./contract`, which both may.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  WHY THIS IS A MODULE OF FUNCTIONS AND NOT A `useServices()` HOOK. │
 * │                                                                    │
 * │  UX-01 §9 was written against a React-context adapter, which is    │
 * │  the right shape when every call is a client-side fetch. This      │
 * │  application renders on the server: pages are async server         │
 * │  components that await data directly, and a context provider       │
 * │  cannot reach them. A module boundary achieves the same property   │
 * │  the document is protecting — one place to swap, no component      │
 * │  edits — in the idiom the framework actually uses.                 │
 * │                                                                    │
 * │  The boundary is enforced, not merely intended:                    │
 * │  `tests/serviceBoundary.test.ts` fails the build if any file under │
 * │  `src/app` or `src/components` imports `@/server/*` again.         │
 * └────────────────────────────────────────────────────────────────────┘
 */

/* ---- Session ------------------------------------------------------ */
export { currentUser, requireUser, setSessionCookie } from '@/server/sandbox/session';

/* ---- Chrome, deals, links ----------------------------------------- */
export { getChrome } from '@/server/sandbox/chrome';
export {
  dealIdForLink,
  getDeal,
  getLinkPreview,
  listDealsForUser,
  readEvidence,
  runLifecycleSweep,
  MAX_INR_MINOR,
  MIN_INR_MINOR,
} from '@/server/sandbox/service';

/* ---- Identity, trust, rewards ------------------------------------- */
export {
  countUnread,
  dealsToNextLevel,
  feeCreditMinorFor,
  getTrustProfile,
  levelFor,
  listNotifications,
  listPaymentMethods,
  listReferrals,
  listRewards,
  typicalResponseMinutes,
} from '@/server/sandbox/identity';

/* ---- Operator ------------------------------------------------------ */
export {
  AT_RISK_MINUTES,
  DESK_PAGE_SIZE,
  countBy,
  deskCounts,
  deskQueue,
  operatorCase,
  type DeskCounts,
  type DeskPage,
} from '@/server/sandbox/ops';
export type { OperatorCase } from '@/server/sandbox/ops';

/* ---- Command identity, for server-rendered forms -------------------- */
export { newCommandId } from '@/server/boundary/command';

/* ---- Deployment capability ----------------------------------------- */
export { deploymentMode, isSandboxDeployment } from '@/server/adapters/mode';
export {
  availableScenarios,
  scenarioAvailable,
  scenarioUnavailableReason,
} from '@/server/adapters/policy';
export { valueProtectionAvailable } from '@/server/adapters/valueProtection';
/*
 * The USDT balance and the sandbox claim beside it. Selling USDT now
 * takes the seller's balance into escrow, so a person has to be able to
 * see what they hold and how to get some to try the corridor with.
 */
export { balancesFor, type Balances } from '@/server/ledger/valueProtection';
export { claimTestFunds, type ClaimResult } from '@/server/sandbox/starterBalance';

/* ---- Identity mutations reached from route handlers ---------------- */
export { attachReferrer } from '@/server/sandbox/identity';

/* ---- Telegram ------------------------------------------------------ */
export { telegramConfigured, verifyInitData } from '@/server/telegram/verify';
export type { VerifyFailure } from '@/server/telegram/verify';
export { destinationForStartParam } from '@/server/telegram/auth';

/* ---- DEL-03 identity and access ------------------------------------ */
export {
  beginMfaEnrolment,
  confirmMfaEnrolment,
  linkTelegramIdentity,
  mfaEnrolled,
  redeemEmailSignIn,
  signInWithTelegramLaunch,
  startEmailSignIn,
  redeemRecoveryCode,
  verifyMfaForSession,
} from '@/server/identity/auth';
export {
  listSessions,
  revokeAllSessions,
  revokeSession,
  type SessionSummary,
} from '@/server/identity/sessions';
export {
  can,
  denialFor,
  permissionsFor,
  rolesFor,
  type Permission,
  type Principal,
} from '@/server/identity/rbac';
export {
  decideVerification,
  listVerificationCases,
  listVerificationQueue,
  submitVerification,
  type VerificationCase,
  type VerificationKind,
  type VerificationQueueRow,
  type VerificationState,
} from '@/server/identity/verification';
export { emailDeliveryAvailable, emailDeliveryStatus } from '@/server/adapters/emailDelivery';
/*
 * Health, for the two probe routes. The runbook has cited
 * `/api/health/ready` since DEL-09 and neither endpoint existed; they go
 * through this boundary like every other interface file, so
 * `tests/serviceBoundary.test.ts` covers them too.
 */
export { liveness, readiness, type Check, type Readiness } from '@/server/ops/readiness';
/*
 * The outbox worker, for the scheduler endpoint. One-shot by design —
 * see `runOnce` — and reached through this boundary like everything
 * else an interface file touches.
 */
export { recoverStaleLeases, runOnce, type RunResult } from '@/server/ops/outboxWorker';
export { outboxHandlers } from '@/server/ops/outboxHandlers';
export { currentCaller, requireCaller, rotateSessionIfDue } from '@/server/sandbox/session';

/* ---- Contract re-exports, so a server component needs one import --- */
export * from './contract';
