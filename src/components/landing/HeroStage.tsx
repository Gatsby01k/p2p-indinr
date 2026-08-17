import { cn } from '@/lib/cn';
import { ChannelRow, DealCardPreview } from './DealCardPreview';
import { CompleteToast } from './CompleteToast';
import { DealRoomPreview } from './DealRoomPreview';
import { FlowConnector } from './Glyphs';
import { MiniAppPreview } from './MiniAppPreview';
import type { CapabilityDemo } from './demo';

/**
 * The product, in three layers, in the order it happens.
 *
 *   COMPOSE   the Mini App composer, where terms are set and locked
 *   SHARE     the card that gets pasted into a chat
 *   SETTLE    the deal room, its proofs, and the release
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  TWO LAYOUTS, ONE SET OF COMPONENTS.                               │
 * │                                                                    │
 * │  Below `lg` the three layers STACK in narrative order, at a size    │
 * │  that stays readable on a 390px phone. That is the whole reason    │
 * │  they are separate components rather than one drawing: a single    │
 * │  illustration would have to be shrunk to 320px wide and would be   │
 * │  unreadable, which is how product screenshots on marketing pages   │
 * │  usually end up as decoration nobody looks at.                     │
 * │                                                                    │
 * │  From `lg` they overlap into the layered composition the reference │
 * │  shows, with dashed connectors carrying the eye left to right.     │
 * │  Absolute positions are stated once, here, against a stage of      │
 * │  known height — never scattered through the three previews.        │
 * └────────────────────────────────────────────────────────────────────┘
 *
 * ⚠ The entire stage is `aria-hidden`. Everything in it is an illustration
 * of a flow the hero already describes in words, none of it is focusable,
 * and reading four nested fake interfaces aloud would bury the two real
 * controls on the page. The `sr-only` sentence below carries the meaning.
 */
export function HeroStage({
  capability,
  className,
}: {
  capability: CapabilityDemo;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="sr-only">
        An illustration of one deal: the Telegram Mini App composer with the terms locked, the
        shareable deal card that goes into a chat, the deal room where both sides upload proof, and
        the notification when the deal completes.
      </p>

      {/* ---- Stacked, up to `lg` -------------------------------- */}
      <div aria-hidden className="mx-auto flex max-w-[22rem] flex-col items-center lg:hidden">
        <MiniAppPreview capability={capability} className="w-[16.5rem]" />
        <FlowConnector direction="down" className="my-3 h-9 w-6" />
        <div className="w-full max-w-[15rem]">
          <DealCardPreview capability={capability} />
          <ChannelRow className="mt-3" />
        </div>
        <FlowConnector direction="down" className="my-3 h-9 w-6" />
        <DealRoomPreview className="w-full max-w-[19rem]" />
        <CompleteToast className="mt-4 w-full" />
      </div>

      {/* ---- Layered, from `lg` --------------------------------- */}
      <div
        aria-hidden
        className="relative mx-auto hidden h-[33.5rem] w-full max-w-[49.5rem] lg:block"
      >
        {/* The card, low and left — the thing that leaves the product. */}
        <div className="absolute left-0 top-[9.5rem] w-[12.5rem]">
          <DealCardPreview capability={capability} />
          <ChannelRow className="mt-3" />
        </div>

        <FlowConnector className="absolute left-[12.8rem] top-[16rem] h-4 w-[2rem]" />

        {/* The phone, front and centre. */}
        <MiniAppPreview
          capability={capability}
          className={cn(
            'absolute left-[14.9rem] top-0 w-[15.75rem]',
            /* Nudged forward so the card and the room read as behind it. */
            'z-10',
          )}
        />

        <FlowConnector className="absolute left-[30.8rem] top-[16rem] h-4 w-[1.6rem]" />

        {/* The room, tall and right — where the deal is finished. */}
        <DealRoomPreview className="absolute right-0 top-[2.25rem] w-[17.5rem]" />

        {/*
          The receipt, crossing both.

          Pushed 24px past the stage's right edge, into the page gutter,
          exactly as the reference does — and that offset is also what
          keeps its left edge clear of the phone's `1 counterparty only`
          line, which it was clipping the last two characters off.
        */}
        <CompleteToast className="absolute -right-6 bottom-0 z-20 w-[23.75rem]" />
      </div>
    </div>
  );
}
