import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * The sign-in experience, as a state machine with a server in it.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  WHAT THESE TESTS ARE ACTUALLY DEFENDING.                          │
 * │                                                                    │
 * │  The rail is the whole risk of this screen. It is a picture of an  │
 * │  authentication having progressed, drawn by the client — so the    │
 * │  one property that must never break is that it draws only what     │
 * │  the SERVER has already confirmed. A rail that advances on a click │
 * │  is a screen telling somebody they are signed in when they are     │
 * │  not, which on a product about protected money is not a cosmetic   │
 * │  bug.                                                              │
 * │                                                                    │
 * │  So every failure path below asserts the same two things: the      │
 * │  refusal is shown, and the rail is exactly where it was.           │
 * └────────────────────────────────────────────────────────────────────┘
 */

const requestSignInCodeAction = vi.fn();
const verifySignInCodeAction = vi.fn();
const push = vi.fn();
const refresh = vi.fn();

vi.mock('@/services/actions', () => ({
  requestSignInCodeAction: (...args: unknown[]) => requestSignInCodeAction(...args),
  verifySignInCodeAction: (...args: unknown[]) => verifySignInCodeAction(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
}));

const { SignInExperience, maskEmail } = await import('@/components/auth/SignInExperience');

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

/** jsdom has no `matchMedia`; the component asks it about motion. */
function stubMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  }));
}

const ADDRESS = 'priya@example.in';
const CODE = '48213907';

const railStates = () =>
  screen.getAllByRole('listitem').map((node) => node.getAttribute('data-state'));

const nodeStates = () =>
  Array.from(document.querySelectorAll('.auth-node')).map((n) => n.getAttribute('data-state'));

function setup(next = '/app/deals') {
  return {
    user: userEvent.setup(),
    ...render(<SignInExperience next={next} invite="" />),
  };
}

/** Get as far as the code field, with the server having said yes once. */
async function reachCodeStage(next = '/app/deals') {
  requestSignInCodeAction.mockResolvedValue({ ok: true });
  const harness = setup(next);
  await harness.user.type(screen.getByLabelText('Email address'), ADDRESS);
  await harness.user.click(screen.getByRole('button', { name: /^Continue$/ }));
  await screen.findByRole('heading', { name: 'Check your email' });
  return harness;
}

beforeEach(() => {
  stubMotion(false);
  requestSignInCodeAction.mockReset();
  verifySignInCodeAction.mockReset();
  // A refusal is the safe default: no test can accidentally sign in, and
  // none can accidentally hit an unmocked action returning `undefined`.
  requestSignInCodeAction.mockResolvedValue({ ok: true });
  verifySignInCodeAction.mockResolvedValue({
    ok: false,
    code: 'AUTH_CHALLENGE_INVALID',
  });
  push.mockReset();
  refresh.mockReset();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(cleanup);

/* ================================================================== *
 * State 1 — the address
 * ================================================================== */

describe('state 1 · enter email', () => {
  it('opens on the address, with step 01 active and nothing else touched', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Sign in to INRP2P' })).toBeTruthy();
    expect(railStates()).toEqual(['active', 'idle', 'idle']);
    expect(nodeStates()).toEqual(['active', 'idle', 'idle']);
  });

  it('holds Continue shut until the address could actually be one', async () => {
    const { user } = setup();
    const button = screen.getByRole('button', { name: /^Continue$/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText('Email address'), 'priya@example');
    expect((button as HTMLButtonElement).disabled, 'no dot, no domain').toBe(true);

    await user.type(screen.getByLabelText('Email address'), '.in');
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not raise the keyboard by focusing the field on arrival', () => {
    setup();
    expect(document.activeElement).toBe(document.body);
  });

  it('offers the real create-deal route and no dead links', () => {
    setup();
    const link = screen.getByRole('link', { name: 'Create a protected deal' });
    expect(link.getAttribute('href')).toBe('/login?next=%2Fapp%2Fnew');
    for (const a of Array.from(document.querySelectorAll('a'))) {
      expect(a.getAttribute('href')).not.toBe('#');
    }
  });
});

/* ================================================================== *
 * 01 → 02
 * ================================================================== */

describe('requesting a code', () => {
  it('advances the rail only after the server confirms the send', async () => {
    let release: (value: { ok: boolean }) => void = () => {};
    requestSignInCodeAction.mockReturnValue(
      new Promise<{ ok: boolean }>((resolve) => {
        release = resolve;
      }),
    );

    const { user } = setup();
    await user.type(screen.getByLabelText('Email address'), ADDRESS);
    await user.click(screen.getByRole('button', { name: /^Continue$/ }));

    // The button has been pressed and the request is in flight.
    expect(railStates(), 'a press is not a confirmation').toEqual(['active', 'idle', 'idle']);

    release({ ok: true });
    await screen.findByRole('heading', { name: 'Check your email' });
    expect(railStates()).toEqual(['done', 'active', 'idle']);
  });

  it('sends the address the person typed, trimmed, and nothing else', async () => {
    requestSignInCodeAction.mockResolvedValue({ ok: true });
    const { user } = setup();
    await user.type(screen.getByLabelText('Email address'), `  ${ADDRESS}  `);
    await user.click(screen.getByRole('button', { name: /^Continue$/ }));
    await screen.findByRole('heading', { name: 'Check your email' });

    const form = requestSignInCodeAction.mock.calls[0]![0] as FormData;
    expect(form.get('email')).toBe(ADDRESS);
    expect([...form.keys()]).toEqual(['email']);
  });

  it('shows the refusal and leaves the rail alone when the send fails', async () => {
    requestSignInCodeAction.mockResolvedValue({
      ok: false,
      code: 'ADAPTER_UNAVAILABLE',
      message: 'This action is unavailable here.',
    });
    const { user } = setup();
    await user.type(screen.getByLabelText('Email address'), ADDRESS);
    await user.click(screen.getByRole('button', { name: /^Continue$/ }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(railStates()).toEqual(['active', 'idle', 'idle']);
    expect(screen.getByRole('heading', { name: 'Sign in to INRP2P' })).toBeTruthy();
    expect((screen.getByLabelText('Email address') as HTMLInputElement).value).toBe(ADDRESS);
  });

  it('survives a request that never reaches the server', async () => {
    requestSignInCodeAction.mockRejectedValue(new TypeError('Failed to fetch'));
    const { user } = setup();
    await user.type(screen.getByLabelText('Email address'), ADDRESS);
    await user.click(screen.getByRole('button', { name: /^Continue$/ }));

    expect((await screen.findByRole('alert')).textContent).toContain('could not reach');
    expect(railStates()).toEqual(['active', 'idle', 'idle']);
  });

  it('says the same thing whether or not the address is known', async () => {
    /*
     * The server answers identically for a known and an unknown address
     * so that this screen cannot be used to test who has an account.
     * The screen must not reintroduce the difference it was denied.
     */
    requestSignInCodeAction.mockResolvedValue({ ok: true });
    const { user } = setup();
    await user.type(screen.getByLabelText('Email address'), 'nobody@example.in');
    await user.click(screen.getByRole('button', { name: /^Continue$/ }));
    const heading = await screen.findByRole('heading', {
      name: 'Check your email',
    });
    expect(heading).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/no account|not registered|unknown address/i);
  });
});

/* ================================================================== *
 * State 2 — the proof
 * ================================================================== */

describe('state 2 · verify code', () => {
  it('asks for eight digits, because the server mints eight', async () => {
    const { user } = await reachCodeStage();
    expect(document.querySelectorAll('.auth-code-cell')).toHaveLength(8);

    // The cap lives after formatting is stripped, not in `maxLength` —
    // see `CodeField`. So it has to be proven by behaviour.
    const field = screen.getByLabelText('Sign-in code') as HTMLInputElement;
    await user.type(field, '4821390712345');
    expect(field.value).toBe(CODE);
  });

  it('drops anything that is not a digit', async () => {
    const { user } = await reachCodeStage();
    const field = screen.getByLabelText('Sign-in code') as HTMLInputElement;
    await user.type(field, 'ab48-21c39 07');
    expect(field.value).toBe(CODE);
  });

  it('carries the attributes a one-time code field is supposed to carry', async () => {
    await reachCodeStage();
    const field = screen.getByLabelText('Sign-in code');
    expect(field.getAttribute('autocomplete')).toBe('one-time-code');
    expect(field.getAttribute('inputmode')).toBe('numeric');
  });

  it('moves focus into the code field once the code is on its way', async () => {
    await reachCodeStage();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Sign-in code')));
  });

  it('shows a masked address, never the whole one', async () => {
    await reachCodeStage();
    expect(screen.getByText(maskEmail(ADDRESS))).toBeTruthy();
    expect(document.body.textContent).not.toContain(ADDRESS);
  });

  it('accepts a pasted code however it was formatted', async () => {
    verifySignInCodeAction.mockResolvedValue({
      ok: false,
      code: 'AUTH_CHALLENGE_INVALID',
    });
    const { user } = await reachCodeStage();
    const field = screen.getByLabelText('Sign-in code');
    await user.click(field);
    await user.paste('4821 3907');
    expect((field as HTMLInputElement).value).toBe(CODE);
  });

  it('never writes the code anywhere it could outlive its one use', async () => {
    verifySignInCodeAction.mockResolvedValue({
      ok: false,
      code: 'AUTH_CHALLENGE_INVALID',
    });
    const { user } = await reachCodeStage();
    await user.type(screen.getByLabelText('Sign-in code'), CODE);
    await screen.findByRole('alert');

    expect(Object.keys(localStorage)).toHaveLength(0);
    expect(Object.keys(sessionStorage)).toHaveLength(0);
    expect(document.cookie).not.toContain(CODE);
    expect(window.location.search).not.toContain(CODE);
  });

  it('goes back to the address without pretending step 02 happened', async () => {
    const { user } = await reachCodeStage();
    await user.click(screen.getByRole('button', { name: 'Use a different email' }));
    await screen.findByRole('heading', { name: 'Sign in to INRP2P' });
    expect(railStates()).toEqual(['active', 'idle', 'idle']);
    expect((screen.getByLabelText('Email address') as HTMLInputElement).value).toBe(ADDRESS);
  });

  it('resends through the same action, with no cooldown of its own invention', async () => {
    const { user } = await reachCodeStage();
    requestSignInCodeAction.mockClear();
    requestSignInCodeAction.mockResolvedValue({ ok: true });

    await user.click(screen.getByRole('button', { name: 'Send a new code' }));
    await waitFor(() => expect(requestSignInCodeAction).toHaveBeenCalledTimes(1));
    // Still step 02: a fresh code is not progress.
    expect(railStates()).toEqual(['done', 'active', 'idle']);
  });
});

/* ================================================================== *
 * Refusals
 * ================================================================== */

describe('a code the server will not take', () => {
  /*
   * `redeemEmailSignIn` answers AUTH_CHALLENGE_INVALID for a wrong code,
   * an expired one, an already-spent one and an unknown address — on
   * purpose, so that the refusal cannot be read as a hint. Both cases
   * below therefore assert the SAME presentation, and assert that the
   * screen does not invent a distinction the server refused to make.
   */
  it.each([
    ['incorrect', 'AUTH_CHALLENGE_INVALID'],
    ['expired', 'AUTH_CHALLENGE_INVALID'],
  ])('%s: refuses without advancing', async (_case, code) => {
    verifySignInCodeAction.mockResolvedValue({ ok: false, code });
    const { user } = await reachCodeStage();
    await user.type(screen.getByLabelText('Sign-in code'), CODE);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('not valid');
    expect(alert.textContent).not.toMatch(/expired|already used/i);
    expect(railStates()).toEqual(['done', 'active', 'idle']);
    expect(nodeStates()).toEqual(['done', 'active', 'idle']);
    expect(push).not.toHaveBeenCalled();
  });

  it('rate limiting keeps the last confirmed step and says to wait', async () => {
    verifySignInCodeAction.mockResolvedValue({
      ok: false,
      code: 'RATE_LIMITED',
    });
    const { user } = await reachCodeStage();
    await user.type(screen.getByLabelText('Sign-in code'), CODE);

    expect((await screen.findByRole('alert')).textContent).toMatch(/Too many attempts/i);
    expect(railStates()).toEqual(['done', 'active', 'idle']);
  });

  it('a session that could not be opened is not reported as a sign-in', async () => {
    verifySignInCodeAction.mockResolvedValue({ ok: false, code: 'UNKNOWN' });
    const { user } = await reachCodeStage();
    await user.type(screen.getByLabelText('Sign-in code'), CODE);

    expect((await screen.findByRole('alert')).textContent).toContain('No session was opened');
    expect(screen.queryByRole('heading', { name: 'Access confirmed' })).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it('treats an answer it cannot read as a refusal, not as a crash', async () => {
    // A deploy skew or a swallowed payload. This used to throw inside
    // the transition and leave the screen showing nothing at all.
    verifySignInCodeAction.mockResolvedValue(undefined);
    const { user } = await reachCodeStage();
    await user.type(screen.getByLabelText('Sign-in code'), CODE);

    expect((await screen.findByRole('alert')).textContent).toContain('No session was opened');
    expect(railStates()).toEqual(['done', 'active', 'idle']);
    expect(push).not.toHaveBeenCalled();
  });

  it('keeps the caret in the code field so the digits can be corrected', async () => {
    verifySignInCodeAction.mockResolvedValue({
      ok: false,
      code: 'AUTH_CHALLENGE_INVALID',
    });
    const { user } = await reachCodeStage();
    await user.type(screen.getByLabelText('Sign-in code'), CODE);
    await screen.findByRole('alert');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Sign-in code')));
  });
});

/* ================================================================== *
 * State 3 — released
 * ================================================================== */

describe('state 3 · continue securely', () => {
  it('confirms, completes the rail, then goes to the validated destination', async () => {
    verifySignInCodeAction.mockResolvedValue({ ok: true });
    const { user } = await reachCodeStage('/app/deals');
    await user.type(screen.getByLabelText('Sign-in code'), CODE);

    await screen.findByRole('heading', { name: 'Access confirmed' });
    expect(railStates()).toEqual(['done', 'done', 'confirmed']);
    expect(nodeStates()).toEqual(['done', 'done', 'confirmed']);

    await waitFor(() => expect(push).toHaveBeenCalledWith('/app/deals'), {
      timeout: 4000,
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('travels to the destination it was given and invents nothing', async () => {
    verifySignInCodeAction.mockResolvedValue({ ok: true });
    const { user } = await reachCodeStage('/d/INRP-ABCDEFGHJK');
    await user.type(screen.getByLabelText('Sign-in code'), CODE);
    await waitFor(() => expect(push).toHaveBeenCalledWith('/d/INRP-ABCDEFGHJK'), { timeout: 4000 });
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('hands the server the address and the destination it is holding', async () => {
    verifySignInCodeAction.mockResolvedValue({ ok: true });
    const { user } = await reachCodeStage('/app/rewards');
    await user.type(screen.getByLabelText('Sign-in code'), CODE);
    await screen.findByRole('heading', { name: 'Access confirmed' });

    expect(verifySignInCodeAction).toHaveBeenCalledWith({
      email: ADDRESS,
      code: CODE,
      next: '/app/rewards',
      invite: '',
    });
  });

  it('does not navigate before the confirmation it is showing', async () => {
    verifySignInCodeAction.mockResolvedValue({ ok: true });
    const { user } = await reachCodeStage();
    await user.type(screen.getByLabelText('Sign-in code'), CODE);
    await screen.findByRole('heading', { name: 'Access confirmed' });
    // The session exists — the cookie was set before `ok` came back — but
    // the person has not yet been told, so nothing has moved.
    expect(push).not.toHaveBeenCalled();
    await waitFor(() => expect(push).toHaveBeenCalled(), { timeout: 4000 });
  });
});

/* ================================================================== *
 * The demonstration loop
 * ================================================================== */

describe('the rail demonstrating itself', () => {
  const rail = () => document.querySelector('[data-auth-rail]');
  const looping = () => rail()?.hasAttribute('data-demo') ?? false;

  it('plays on an untouched form', () => {
    setup();
    expect(looping()).toBe(true);
    expect(document.querySelector('.auth-track-sled-demo')).toBeTruthy();
  });

  it('never claims a step the person has not reached', () => {
    /*
     * The loop is painted over `data-state` in CSS and must not change
     * it. What the markup says, and what a screen reader is told, stay
     * true for every second the animation runs.
     */
    setup();
    expect(looping()).toBe(true);
    expect(railStates()).toEqual(['active', 'idle', 'idle']);
    expect(nodeStates()).toEqual(['active', 'idle', 'idle']);
  });

  it('stops the moment somebody reaches for the field', async () => {
    const { user } = setup();
    expect(looping()).toBe(true);
    await user.click(screen.getByLabelText('Email address'));
    expect(looping()).toBe(false);
    expect(document.querySelector('.auth-track-sled-demo')).toBeNull();
  });

  it('stays stopped after coming back to a different email', async () => {
    /*
     * The one-way door. Somebody mid-authentication must never see a
     * rail cycling to `Continue securely` beside their own half-done
     * sign-in — that would be animating a claim about their session.
     */
    const { user } = await reachCodeStage();
    await user.click(screen.getByRole('button', { name: 'Use a different email' }));
    await screen.findByRole('heading', { name: 'Sign in to INRP2P' });
    expect(looping(), 'the demonstration must not restart').toBe(false);
  });

  it('is not running once the code has been asked for', async () => {
    await reachCodeStage();
    expect(looping()).toBe(false);
  });
});

/* ================================================================== *
 * Reduced motion
 * ================================================================== */

describe('prefers-reduced-motion', () => {
  beforeEach(() => stubMotion(true));

  it('never starts the demonstration at all', () => {
    setup();
    expect(document.querySelector('[data-auth-rail]')?.hasAttribute('data-demo')).toBe(false);
    expect(document.querySelector('.auth-track-sled-demo')).toBeNull();
  });

  it('never puts a travelling signal on the rail', async () => {
    verifySignInCodeAction.mockResolvedValue({ ok: true });
    const { user } = await reachCodeStage();
    expect(document.querySelector('.auth-track-sled')).toBeNull();

    await user.type(screen.getByLabelText('Sign-in code'), CODE);
    await screen.findByRole('heading', { name: 'Access confirmed' });
    expect(document.querySelector('.auth-track-sled')).toBeNull();
  });

  it('still reaches every state, and says all of them out loud', async () => {
    verifySignInCodeAction.mockResolvedValue({ ok: true });
    const { user } = await reachCodeStage();
    expect(railStates()).toEqual(['done', 'active', 'idle']);

    // The rail's meaning is in words, not only in colour.
    const steps = screen.getAllByRole('listitem');
    expect(within(steps[0]!).getByText(/Completed/)).toBeTruthy();
    expect(within(steps[1]!).getByText(/Current step/)).toBeTruthy();

    await user.type(screen.getByLabelText('Sign-in code'), CODE);
    await screen.findByRole('heading', { name: 'Access confirmed' });
    expect(railStates()).toEqual(['done', 'done', 'confirmed']);
    await waitFor(() => expect(push).toHaveBeenCalled(), { timeout: 4000 });
  });
});

/* ================================================================== *
 * The mask
 * ================================================================== */

describe('maskEmail', () => {
  it.each([
    ['priya@example.in', 'p•••••@example.in'],
    ['a@b.co', 'a•••••@b.co'],
    ['first.last+tag@sub.domain.in', 'f•••••@sub.domain.in'],
  ])('%s → %s', (input, expected) => {
    expect(maskEmail(input)).toBe(expected);
  });

  it('hides the length of what it hid', () => {
    // A mask one character per hidden character publishes the real length.
    expect(maskEmail('a@x.in').length).toBe(maskEmail('averylongname@x.in').length);
  });
});
