import { cn } from '@/lib/cn';

/**
 * The protected-access rail.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  THIS IS THE PRODUCT'S OWN RAIL, NOT A PROGRESS BAR.               │
 * │                                                                    │
 * │  Everywhere else in INRP2P a rail carries VALUE from an origin to  │
 * │  a destination and arrives with finality: three protected nodes,   │
 * │  one directional signal, orange while moving, green once settled.  │
 * │  Authentication is the same shape of promise —                     │
 * │                                                                    │
 * │      identity submitted → proof confirmed → access released        │
 * │                                                                    │
 * │  — so it is drawn the same way. It is deliberately NOT drawn in    │
 * │  the settlement green: signing in is not a financial event, and a  │
 * │  surface that borrowed the completion colour of a released deal    │
 * │  would be saying something untrue. The confirmed node is mint, a   │
 * │  hue reserved for this rail and used nowhere else in the product.  │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ⚠ THE RAIL IS A READOUT, NEVER A CONTROL. The steps are list items,
 * not links or buttons: there is nothing here to click, so there is no
 * way to reach step two without the server having said the code was
 * sent, and no way to reach step three without a session existing. The
 * stage is handed down from `SignInExperience`, which only ever advances
 * it on a confirmed server response.
 */

export type AccessStage = 'email' | 'code' | 'granted';

/** What one node is showing. `confirmed` is the mint terminal state. */
type NodeState = 'idle' | 'active' | 'done' | 'confirmed';

const STEPS = [
  { ordinal: '01', label: 'Enter email' },
  { ordinal: '02', label: 'Verify code' },
  { ordinal: '03', label: 'Continue securely' },
] as const;

/** How far the drawn line has run, as a fraction of node 01 → node 03. */
const FILL: Readonly<Record<AccessStage, number>> = {
  email: 0,
  code: 0.5,
  granted: 1,
};

function statesFor(stage: AccessStage): readonly NodeState[] {
  if (stage === 'email') return ['active', 'idle', 'idle'];
  if (stage === 'code') return ['done', 'active', 'idle'];
  return ['done', 'done', 'confirmed'];
}

/** Said aloud, because colour and fill are the only visual difference. */
const SPOKEN: Readonly<Record<NodeState, string>> = {
  idle: 'Not started',
  active: 'Current step',
  done: 'Completed',
  confirmed: 'Confirmed',
};

/**
 * One journey of the signal, as an instruction rather than a state.
 *
 * `id` exists so React remounts the element on every confirmed hand-off:
 * a CSS animation only replays when the node is new, and this rail must
 * run exactly once per transition and never loop.
 */
export interface RailTravel {
  readonly id: number;
  readonly from: AccessStage;
  readonly to: AccessStage;
}

export function AccessRail({
  stage,
  travel,
  demo = false,
  className,
}: {
  stage: AccessStage;
  travel: RailTravel | null;
  /**
   * Play the journey on a loop, before anybody has done anything.
   *
   * ┌────────────────────────────────────────────────────────────────┐
   * │  A DEMONSTRATION, AND IT HAS TO STAY READABLE AS ONE.          │
   * │                                                                │
   * │  It runs ONLY at `stage === 'email'`, and only until the       │
   * │  person touches the form — after that the rail is a readout of │
   * │  a real authentication again and never loops. That boundary is │
   * │  the whole safety of the idea: a rail that kept cycling to     │
   * │  `Continue securely` beside a filled-in code field would be    │
   * │  animating a claim about the person's session.                 │
   * │                                                                │
   * │  The `data-state` attributes below are NOT touched by it. The  │
   * │  loop is painted over them in CSS, so what a screen reader is  │
   * │  told, and what the component believes, stay true throughout.  │
   * └────────────────────────────────────────────────────────────────┘
   */
  demo?: boolean;
  className?: string;
}) {
  const states = statesFor(stage);

  return (
    <div
      data-auth-rail
      data-demo={demo ? '' : undefined}
      className={cn('select-none', className)}
      style={{ '--rail-fill': FILL[stage] } as React.CSSProperties}
    >
      <ol className="grid grid-cols-3">
        {STEPS.map((step, i) => (
          <li key={step.ordinal} data-state={states[i]} className="auth-step pr-3 sm:pr-4">
            <span aria-hidden className="auth-step-ordinal tnum">
              {step.ordinal}
            </span>
            <span className="auth-step-label">{step.label}</span>
            <span className="sr-only">
              {' '}
              — step {i + 1} of 3, {SPOKEN[states[i]!]}
            </span>
          </li>
        ))}
      </ol>

      {/*
        The drawing itself carries no information the list above has not
        already stated in words, so it is hidden from assistive
        technology rather than narrated a second time as decoration.
      */}
      <div aria-hidden className="auth-track">
        <span className="auth-track-base" />
        {/*
          The stub before node 01. Always lit: step one is active from the
          first paint and never returns to idle, so this is a constant of
          the drawing rather than a state of it.
        */}
        <span className="auth-track-lead" />
        <span className="auth-track-run">
          <span className="auth-track-fill" />
        </span>

        {demo ? (
          <span className="auth-track-sled auth-track-sled-demo">
            <span className="auth-signal" />
          </span>
        ) : null}

        {travel ? (
          <span
            key={travel.id}
            className="auth-track-sled"
            style={
              {
                '--from': `${FILL[travel.from] * 100}%`,
                '--to': `${FILL[travel.to] * 100}%`,
              } as React.CSSProperties
            }
          >
            <span className="auth-signal" />
          </span>
        ) : null}

        {states.map((state, i) => (
          <span
            key={i}
            data-state={state}
            data-node={i + 1}
            className="auth-node"
            style={{ '--i': i } as React.CSSProperties}
          />
        ))}
      </div>
    </div>
  );
}
