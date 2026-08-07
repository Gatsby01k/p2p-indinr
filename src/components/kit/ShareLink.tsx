'use client';

import { useState } from 'react';
import { cn } from '@/lib/cn';
import { Icon } from './Icon';
import { CopyButton, useCopy } from './Feedback';
import { buttonClass } from './primitives';
import { useTelegram } from '@/components/telegram/TelegramProvider';
import { openLink } from '@/lib/telegramSdk';

/**
 * The share moment.
 *
 * Creating a link is the point at which a person has something to send, so
 * this makes sending it the obvious next act rather than something to hunt
 * for. The Web Share sheet is used where it exists — that is how a link
 * actually reaches WhatsApp on a phone — with named channels and copy as the
 * fallback everywhere else.
 *
 * ────────────────────────────────────────────────────────────────────
 * DISCLOSURE. The share text carries the ECONOMIC TERMS AND THE URL ONLY.
 * No name, no deal code, no reference to who created it. A forwarded
 * message is public and outside the sender's control, so it gets the same
 * treatment as the page's own Open Graph metadata.
 * ────────────────────────────────────────────────────────────────────
 */
export function ShareLink({
  url,
  headline,
  dealCode,
  miniAppUrl,
  className,
}: {
  url: string;
  headline: string;
  dealCode?: string;
  /**
   * A `t.me/<bot>/<app>?startapp=…` address that opens this deal INSIDE
   * Telegram. Present only when the deployment has a Mini App configured;
   * absent, the web URL is shared instead and everything still works.
   */
  miniAppUrl?: string | null;
  className?: string;
}) {
  const { copy } = useCopy();
  const { inTelegram, haptic } = useTelegram();
  const [sharing, setSharing] = useState(false);

  /*
   * Inside Telegram, share the Mini App address so the recipient lands in
   * the app rather than in Telegram's in-app browser — that is the whole
   * difference between "a website someone sent me" and "a thing that opens".
   * Outside Telegram the web URL is the right thing to send, because most
   * recipients will not have the bot.
   */
  const shareUrl = inTelegram && miniAppUrl ? miniAppUrl : url;

  // One sentence plus the link. Anything longer gets truncated by the
  // messaging app anyway, and the terms are what the recipient needs.
  const message = `${headline} — protected deal on INRP2P.\n${shareUrl}`;

  const nativeShare = async () => {
    /*
     * Telegram's own forward sheet, not the Web Share API. Inside a Mini
     * App `navigator.share` either does nothing or opens the OS sheet
     * behind Telegram's UI depending on the platform; `t.me/share/url`
     * through `openTelegramLink` is the only path that reliably lands in a
     * chat picker.
     */
    if (inTelegram) {
      haptic('light');
      const forward = `https://t.me/share/url?url=${encodeURIComponent(
        shareUrl,
      )}&text=${encodeURIComponent(headline)}`;
      if (openLink(forward)) return;
    }

    if (typeof navigator !== 'undefined' && 'share' in navigator) {
      setSharing(true);
      try {
        await navigator.share({ title: 'INRP2P protected deal', text: headline, url: shareUrl });
        return;
      } catch {
        /* dismissed, or unsupported at the last moment — fall through */
      } finally {
        setSharing(false);
      }
    }
    void copy(shareUrl, 'Link copied');
  };

  return (
    <div className={className}>
      <label
        htmlFor="deal-link"
        className="text-[length:var(--text-2xs)] font-semibold uppercase tracking-[0.07em] text-[var(--color-ink-4)]"
      >
        Deal link
      </label>
      <div className="mt-1.5 flex items-center gap-1 rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-sunken)] py-1 pl-3 pr-1">
        <input
          id="deal-link"
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 font-mono text-[length:var(--text-xs)] text-[var(--color-ink-2)] outline-none"
        />
        <CopyButton value={url} announce="Link copied" />
      </div>

      {dealCode ? (
        <div className="mt-2.5 flex items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-paper)] py-1 pl-3 pr-1">
          <span className="text-[length:var(--text-xs)] text-[var(--color-ink-3)]">Deal code</span>
          <span className="flex items-center gap-1">
            <span className="font-mono text-[length:var(--text-sm)] font-semibold tracking-[0.06em] text-[var(--color-ink)]">
              {dealCode}
            </span>
            <CopyButton value={dealCode} announce="Deal code copied" />
          </span>
        </div>
      ) : null}

      <div className="mt-3 space-y-2">
        <button
          type="button"
          onClick={() => void nativeShare()}
          disabled={sharing}
          className={buttonClass('primary', 'lg', true)}
        >
          <Icon name="share" className="h-4 w-4" />
          Share deal link
        </button>

        {/*
          Inside Telegram the named channels are dropped. A WhatsApp button
          that opens a browser that opens WhatsApp is a worse path than the
          forward sheet the person just used, and the row would be three
          taps competing with the one that works.
        */}
        {inTelegram ? (
          <button
            type="button"
            onClick={() => void copy(shareUrl, 'Link copied')}
            className={buttonClass('outline', 'md', true)}
          >
            <Icon name="link" className="h-4 w-4 text-[var(--color-ink-3)]" />
            Copy link instead
          </button>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            <ChannelButton
              href={`https://wa.me/?text=${encodeURIComponent(message)}`}
              icon="whatsapp"
              label="WhatsApp"
            />
            <ChannelButton
              href={`https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(headline)}`}
              icon="telegram"
              label="Telegram"
            />
            <button
              type="button"
              onClick={() => void copy(shareUrl, 'Link copied')}
              className={cn(
                'press tap flex flex-col items-center justify-center gap-1 rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-paper)] py-2',
                'text-[length:var(--text-2xs)] font-medium text-[var(--color-ink-2)] hover:bg-[var(--color-sunken)]',
              )}
            >
              <Icon name="link" className="h-[18px] w-[18px] text-[var(--color-ink-3)]" />
              Copy link
            </button>
          </div>
        )}
      </div>

      <p className="mt-3 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-ink-3)]">
        Only the first eligible person to open it can join. Everyone else is told it was already
        taken, and nothing is charged to them.
        {inTelegram && miniAppUrl
          ? ' This link opens INRP2P inside Telegram for whoever receives it.'
          : ''}
      </p>
    </div>
  );
}

/**
 * A named channel.
 *
 * `rel="noopener noreferrer"` matters here specifically: these open a third
 * party in a new tab with the deal URL in the address, and the opener
 * reference would otherwise let that page navigate this one.
 */
function ChannelButton({
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
