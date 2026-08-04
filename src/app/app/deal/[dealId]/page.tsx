import { FAILURE_COPY, SandboxFailure, getDeal } from '@/server/sandbox/service';
import { requireUser } from '@/server/sandbox/session';
import { DealRoomView } from '@/components/sandbox/DealRoomView';
import { BlockedState } from '@/components/sandbox/SandboxChrome';

export const dynamic = 'force-dynamic';

export default async function DealPage({ params }: { params: Promise<{ dealId: string }> }) {
  const { dealId } = await params;
  const user = await requireUser();

  try {
    const deal = await getDeal(user, dealId);
    return (
      <div className="mx-auto max-w-2xl">
        <DealRoomView deal={deal} />
      </div>
    );
  } catch (err) {
    // A non-participant sees why they cannot open it, never its contents.
    const code = err instanceof SandboxFailure ? err.code : 'NOT_FOUND';
    const copy = FAILURE_COPY[code] ?? FAILURE_COPY.NOT_FOUND;
    return (
      <div className="mx-auto max-w-lg">
        <BlockedState
          title="You cannot open this deal"
          reason={copy.reason}
          nextStep={copy.nextStep}
          action={{ href: '/app', label: 'Back to your deals' }}
        />
      </div>
    );
  }
}
