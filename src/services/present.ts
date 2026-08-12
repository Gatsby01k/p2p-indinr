import 'server-only';

/**
 * Presentation work that happens AFTER the database has decided.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  A CACHE REFRESH MAY NOT UNDO A COMMITTED COMMAND.                 │
 * │                                                                    │
 * │  The action wrappers used to wrap both the command and             │
 * │  `revalidatePath()` in one `try`. That produced a genuinely        │
 * │  dangerous sequence:                                               │
 * │                                                                    │
 * │    1. `runCommand()` commits — the deal exists;                    │
 * │    2. `revalidatePath()` throws;                                   │
 * │    3. the catch returns `UNKNOWN`;                                 │
 * │    4. the client treats that as an answer and settles its id;      │
 * │    5. the retry carries a NEW id and creates a SECOND deal.        │
 * │                                                                    │
 * │  The command boundary had done its job perfectly and the wrapper   │
 * │  threw the result away. Revalidation is best-effort presentation:  │
 * │  the worst outcome of skipping it is a stale screen that the next  │
 * │  navigation fixes. The worst outcome of conflating it with the     │
 * │  command is a duplicate financial mutation.                        │
 * │                                                                    │
 * │  This is NOT part of the database transaction and must never       │
 * │  become part of one — it runs strictly after the commit.           │
 * └────────────────────────────────────────────────────────────────────┘
 */
export function afterCommit(revalidate: () => void): void {
  try {
    revalidate();
  } catch (err) {
    // Loud in the log, invisible to the caller: they got their answer.
    console.error('[inrp2p] post-commit revalidation failed; result stands', err);
  }
}
