'use client';

import { cn } from '@/lib/cn';
import { Icon } from '@/components/kit/Icon';
import { CopyField, useCopy } from '@/components/kit/Feedback';
import { buttonClass } from '@/components/kit/primitives';

/**
 * The invite link and the ways to send it.
 *
 * The share text says what the recipient gets, not what the sender earns —
 * a referral message that leads with the referrer's reward is the reason
 * people are embarrassed to send one.
 */
export function InviteBlock({ url, code }: { url: string; code: string }) {
  const { copy } = useCopy();

  const message = `I use INRP2P for protected payments and INR ⇄ USDT deals — the money is held until both sides confirm. ${url}`;

  const share = async () => {
    if (typeof navigator !== 'undefined' && 'share' in navigator) {
      try {
        await navigator.share({ title: 'INRP2P — protected deals', text: message, url });
        return;
      } catch {
        /* dismissed — fall through to copy */
      }
    }
    void copy(url, 'Invite link copied');
  };

  return (
    <div>
      <CopyField label="Your invite link" value={url} announce="Invite link copied" />
      <CopyField
        className="mt-2.5"
        label="Invite code"
        value={code}
        announce="Invite code copied"
      />

      <div className="mt-3 space-y-2">
        <button
          type="button"
          onClick={() => void share()}
          className={buttonClass('primary', 'md', true)}
        >
          <Icon name="share" className="h-4 w-4" />
          Share invite
        </button>

        <div className="grid grid-cols-3 gap-2">
          <Channel
            href={`https://wa.me/?text=${encodeURIComponent(message)}`}
            icon="whatsapp"
            label="WhatsApp"
          />
          <Channel
            href={`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent('Protected payments and exchanges on INRP2P')}`}
            icon="telegram"
            label="Telegram"
          />
          <a
            href={`mailto:?subject=${encodeURIComponent('Protected deals on INRP2P')}&body=${encodeURIComponent(message)}`}
            className={cn(
              'press tap flex flex-col items-center justify-center gap-1 rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-paper)] py-2',
              'text-[length:var(--text-2xs)] font-medium text-[var(--color-ink-2)] hover:bg-[var(--color-sunken)]',
            )}
          >
            <Icon name="message" className="h-[18px] w-[18px] text-[var(--color-ink-3)]" />
            Email
          </a>
        </div>
      </div>
    </div>
  );
}

function Channel({
  href,
  icon,
  label,
}: {
  href: string;
  icon: 'whatsapp' | 'telegram';
  label: string;
}) {
  const tint =
    icon === 'whatsapp'
      ? 'text-[#1f9d55] dark:text-[#48c98a]'
      : 'text-[#1f7ab8] dark:text-[#54a9e0]';
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'press tap flex flex-col items-center justify-center gap-1 rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-paper)] py-2',
        'text-[length:var(--text-2xs)] font-medium text-[var(--color-ink-2)] hover:bg-[var(--color-sunken)]',
      )}
    >
      <Icon name={icon} className={cn('h-[18px] w-[18px]', tint)} />
      {label}
    </a>
  );
}
