import { Notice, Shell } from '@/components/kit/primitives';

/**
 * Not-found inside the authenticated section.
 *
 * Distinct from the root 404 because the reassurance differs: here the
 * person has deals, and the important thing to say is that none of them
 * were affected by opening a bad address.
 */
export default function AppNotFound() {
  return (
    <Shell width="prose" className="py-10">
      <Notice
        tone="idle"
        title="That page does not exist"
        body="The address does not match any screen in your account."
        reassurance="None of your deals were changed, and nothing was charged."
        nextStep="Go back to your deals and open the one you were looking for."
        action={{ href: '/app', label: 'Back to your deals' }}
      />
    </Shell>
  );
}
