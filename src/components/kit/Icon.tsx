import { cn } from '@/lib/cn';

/**
 * The icon set.
 *
 * One geometry for the whole product: a 24×24 box, 1.7px strokes, square-ish
 * joins, and no fill except where a shape is genuinely solid. Drawn as paths
 * in one module rather than pulled from a library, so the set stays small,
 * consistent and free of a runtime dependency — and so an icon can be
 * corrected in one place instead of forty.
 *
 * Icons are decorative by default (`aria-hidden`). Where an icon is the only
 * content of a control, the CONTROL carries the label, not the glyph.
 */

export type IconName =
  | 'home'
  | 'deals'
  | 'rewards'
  | 'profile'
  | 'bell'
  | 'shield'
  | 'shield-check'
  | 'arrow-right'
  | 'arrow-left'
  | 'arrow-down'
  | 'chevron-right'
  | 'chevron-down'
  | 'chevron-left'
  | 'copy'
  | 'check'
  | 'check-circle'
  | 'share'
  | 'whatsapp'
  | 'telegram'
  | 'link'
  | 'upload'
  | 'download'
  | 'file'
  | 'image'
  | 'paperclip'
  | 'message'
  | 'clock'
  | 'alert'
  | 'info'
  | 'plus'
  | 'close'
  | 'search'
  | 'filter'
  | 'menu'
  | 'settings'
  | 'lock'
  | 'help'
  | 'logout'
  | 'star'
  | 'users'
  | 'wallet'
  | 'bank'
  | 'rupee'
  | 'swap'
  | 'calendar'
  | 'edit'
  | 'trash'
  | 'more'
  | 'qr'
  | 'gift'
  | 'trend'
  | 'refresh'
  | 'flag'
  | 'receipt'
  | 'briefcase'
  | 'package'
  | 'sparkle';

/** Stroked paths. Anything solid is declared in SOLID below instead. */
const PATHS: Readonly<Record<IconName, string>> = {
  home: 'M3.5 10.2 12 3.6l8.5 6.6V19a1.5 1.5 0 0 1-1.5 1.5h-4v-6h-6v6H5A1.5 1.5 0 0 1 3.5 19z',
  deals: 'M3 7.5h8M13 16.5h8M4.5 16.5h3M16.5 7.5h3',
  rewards:
    'M4 11h16v8.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM3 7.5h18V11H3zM12 7.5v13M12 7.5S10.6 3.5 8.3 3.5a2 2 0 0 0 0 4zM12 7.5s1.4-4 3.7-4a2 2 0 0 1 0 4z',
  profile: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5a7.5 7.5 0 0 1 15 0',
  bell: 'M18 9a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16S18 14 18 9zM13.7 19.5a2 2 0 0 1-3.4 0',
  shield: 'M12 3.2 4.8 6v6c0 4.5 3 7.7 7.2 9.3 4.2-1.6 7.2-4.8 7.2-9.3V6z',
  'shield-check':
    'M12 3.2 4.8 6v6c0 4.5 3 7.7 7.2 9.3 4.2-1.6 7.2-4.8 7.2-9.3V6zM8.9 11.9l2.2 2.2 4-4.4',
  'arrow-right': 'M4 12h15m-5.5-5.5L19 12l-5.5 5.5',
  'arrow-left': 'M20 12H5m5.5-5.5L5 12l5.5 5.5',
  'arrow-down': 'M12 4v15m-5.5-5.5L12 19l5.5-5.5',
  'chevron-right': 'm9.5 5.5 6.5 6.5-6.5 6.5',
  'chevron-left': 'M14.5 5.5 8 12l6.5 6.5',
  'chevron-down': 'm5.5 9.5 6.5 6.5 6.5-6.5',
  copy: 'M9 9V5.5A1.5 1.5 0 0 1 10.5 4h8A1.5 1.5 0 0 1 20 5.5v8a1.5 1.5 0 0 1-1.5 1.5H15M5.5 9h8A1.5 1.5 0 0 1 15 10.5v8A1.5 1.5 0 0 1 13.5 20h-8A1.5 1.5 0 0 1 4 18.5v-8A1.5 1.5 0 0 1 5.5 9z',
  check: 'm5 12.5 4.5 4.5L19 7',
  'check-circle': 'M20.5 12a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0zm-12.1.4 2.7 2.7 4.9-5.4',
  share:
    'M12 15V4m-3.5 3.5L12 4l3.5 3.5M5 13.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-5.5',
  whatsapp:
    'M4 20l1.2-4a8 8 0 1 1 3 3zM9 9.5c0 3 2.5 5.5 5.5 5.5.6 0 1-.4 1-1v-.7l-1.8-.9-.9 1a4.6 4.6 0 0 1-2.2-2.2l1-.9L10.7 8.5H10c-.6 0-1 .4-1 1z',
  telegram: 'M21 4 3 11l5 2 2 6 3-3.5 5 3.5zM8 13l13-9-9 11',
  link: 'M10.5 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.3 1.3M13.5 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.3-1.3',
  upload: 'M12 16V4.5m-4 4 4-4 4 4M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15',
  download: 'M12 4.5V16m-4-4 4 4 4-4M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15',
  file: 'M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5zm0 0V8a.5.5 0 0 0 .5.5h4.5',
  /* Evidence is photographed far more often than it is typed. */
  image:
    'M4.5 4.5h15a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1zM3.5 16l4.6-4.1 3.4 3 3.6-3.3 5.4 4.9M9.2 9.1v.1',
  paperclip:
    'M18.6 11.4 12.3 17.7a4.1 4.1 0 0 1-5.8-5.8l7.2-7.2a2.7 2.7 0 0 1 3.8 3.8l-7.2 7.2a1.3 1.3 0 0 1-1.8-1.8l6.4-6.4',
  message:
    'M20.5 11.5c0 4-3.8 7.2-8.5 7.2-1 0-2-.15-2.9-.42L4 20l1.3-3.7A7 7 0 0 1 3.5 11.5c0-4 3.8-7.2 8.5-7.2s8.5 3.2 8.5 7.2z',
  clock: 'M20.5 12a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0zM12 7.2V12l3.2 2',
  alert:
    'M12 8.5V13m0 3.2v.1M10.3 4.4 2.9 17.2A1.5 1.5 0 0 0 4.2 19.5h15.6a1.5 1.5 0 0 0 1.3-2.3L13.7 4.4a2 2 0 0 0-3.4 0z',
  info: 'M20.5 12a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0zM12 11v5.2M12 7.7v.1',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6 6 18',
  search: 'M18 18l3 3m-2-9.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0z',
  filter: 'M3.5 6h17m-14 6h11m-8 6h5',
  menu: 'M3.5 7h17M3.5 12h17M3.5 17h17',
  settings:
    'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM19.4 15a1.5 1.5 0 0 0 .3 1.65l.06.06a1.8 1.8 0 1 1-2.55 2.55l-.06-.06a1.5 1.5 0 0 0-2.55 1.06V20.5a1.8 1.8 0 1 1-3.6 0v-.1a1.5 1.5 0 0 0-2.6-1.02l-.06.06a1.8 1.8 0 1 1-2.55-2.55l.06-.06A1.5 1.5 0 0 0 3.5 14.2H3.4a1.8 1.8 0 1 1 0-3.6h.1a1.5 1.5 0 0 0 1.02-2.6l-.06-.06A1.8 1.8 0 1 1 7.01 5.4l.06.06a1.5 1.5 0 0 0 2.55-1.06V4.3a1.8 1.8 0 1 1 3.6 0v.1a1.5 1.5 0 0 0 2.55 1.06l.06-.06a1.8 1.8 0 1 1 2.55 2.55l-.06.06A1.5 1.5 0 0 0 19.8 10.6h.1a1.8 1.8 0 1 1 0 3.6h-.1a1.5 1.5 0 0 0-1.38.8z',
  lock: 'M7 10.5V8a5 5 0 0 1 10 0v2.5M6 10.5h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z',
  help: 'M20.5 12a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0zM9.6 9.6A2.5 2.5 0 1 1 12 13v1.4M12 17.3v.1',
  logout:
    'M15 8V5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20h8a1.5 1.5 0 0 0 1.5-1.5V16m2.5-8L21 12l-3.5 4M20 12H9',
  star: 'm12 3.8 2.6 5.3 5.9.9-4.25 4.15 1 5.85L12 17.25 6.75 20l1-5.85L3.5 10l5.9-.9z',
  users:
    'M15.5 20.5v-1.8a4 4 0 0 0-4-4h-4a4 4 0 0 0-4 4v1.8M13 7.2a3.7 3.7 0 1 1-7.4 0 3.7 3.7 0 0 1 7.4 0zM20.5 20.5v-1.8a4 4 0 0 0-3-3.87M16 3.7a4 4 0 0 1 0 7.75',
  wallet:
    'M18.5 9V6.8a1.5 1.5 0 0 0-1.5-1.5H5.5A1.5 1.5 0 0 0 4 6.8v10.4a1.5 1.5 0 0 0 1.5 1.5H17a1.5 1.5 0 0 0 1.5-1.5V15M17 9h3.2a.8.8 0 0 1 .8.8v4.4a.8.8 0 0 1-.8.8H17a3 3 0 0 1 0-6z',
  bank: 'M3.5 9.5 12 4.5l8.5 5M5.5 9.5v8m4-8v8m5-8v8m4-8v8M3.5 20.5h17',
  rupee: 'M7.5 4.5h9M7.5 8.5h9M7.5 12.5h4.2a4 4 0 0 0 0-8M7.5 12.5h1.8l6.2 7',
  swap: 'M6.5 8.5h12m-3.5-3.5 3.5 3.5-3.5 3.5M17.5 15.5h-12m3.5-3.5L5.5 15.5 9 19',
  calendar:
    'M7.5 3.5V6m9-2.5V6M4.5 8.5h15M6 6h12a1.5 1.5 0 0 1 1.5 1.5v11A1.5 1.5 0 0 1 18 20H6a1.5 1.5 0 0 1-1.5-1.5v-11A1.5 1.5 0 0 1 6 6z',
  edit: 'M4.5 19.5h3.2l9.6-9.6a2.26 2.26 0 0 0-3.2-3.2l-9.6 9.6zM13.8 7.5l2.7 2.7',
  trash:
    'M4.5 6.5h15M9.5 6.5V4.8a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.7M6.5 6.5l.8 12.2a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12.2M10 10.5v6m4-6v6',
  more: 'M6 12h.1M12 12h.1M18 12h.1',
  qr: 'M4.5 4.5h5v5h-5zM14.5 4.5h5v5h-5zM4.5 14.5h5v5h-5zM14.5 14.5v2m0 3v.1m2.5-5v5m2.5-5v.1m0 2.4v2.5',
  gift: 'M4 11h16v8.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM3 7.5h18V11H3zM12 7.5v13M12 7.5S10.6 3.5 8.3 3.5a2 2 0 0 0 0 4zM12 7.5s1.4-4 3.7-4a2 2 0 0 1 0 4z',
  trend: 'M3.5 16.5 9 11l3.5 3.5L20.5 6.5m0 0h-5m5 0v5',
  refresh: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5',
  flag: 'M5.5 20.5V4.2m0 0h10.9l-2 3.6 2 3.6H5.5',
  receipt:
    'M6 3.5h12a.5.5 0 0 1 .5.5v16.5l-2.5-1.5-2.5 1.5-2.5-1.5-2.5 1.5-2.5-1.5V4a.5.5 0 0 1 .5-.5zM9 8.5h6M9 12.5h6',
  briefcase:
    'M8.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h4A1.5 1.5 0 0 1 15.5 5v1.5M4.5 6.5h15A1.5 1.5 0 0 1 21 8v10.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5V8a1.5 1.5 0 0 1 1.5-1.5zM3 12h18',
  package:
    'M12 3.2 20.5 7.6v8.8L12 20.8 3.5 16.4V7.6zM3.5 7.6 12 12l8.5-4.4M12 12v8.8M7.75 5.4l8.5 4.4',
  sparkle:
    'M12 3.5 13.6 9l5.4 1.6-5.4 1.6L12 17.6l-1.6-5.4L5 10.6 10.4 9zM18.5 16l.7 2.2 2.3.7-2.3.7-.7 2.2-.7-2.2-2.3-.7 2.3-.7z',
};

/** Icons whose shape is genuinely solid rather than stroked. */
const SOLID = new Set<IconName>([]);

export function Icon({
  name,
  className,
  strokeWidth = 1.7,
  label,
}: {
  name: IconName;
  className?: string;
  strokeWidth?: number;
  /** Supply ONLY when the icon is the sole content of a control. */
  label?: string;
}) {
  const solid = SOLID.has(name);
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn('h-[1.25em] w-[1.25em] shrink-0', className)}
      fill={solid ? 'currentColor' : 'none'}
      stroke={solid ? 'none' : 'currentColor'}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/**
 * The asset token that sits beside an amount.
 *
 * INR is saffron and carries the rupee sign; USDT is teal and carries its
 * ticker letter. They are visually distinct at a glance, which is the whole
 * point: a person scanning a list of deals must never confuse the two legs.
 * USDT is NEVER rendered with a dollar sign.
 */
export function AssetMark({
  asset,
  size = 'md',
  className,
}: {
  asset: 'INR' | 'USDT';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const box = { sm: 'h-5 w-5 text-[10px]', md: 'h-7 w-7 text-[12px]', lg: 'h-9 w-9 text-[15px]' }[
    size
  ];
  return (
    <span
      aria-hidden
      className={cn(
        'inline-grid place-items-center rounded-full font-semibold leading-none',
        box,
        asset === 'INR'
          ? 'bg-[var(--color-inr-tint)] text-[var(--color-inr)]'
          : 'bg-[var(--color-usdt-tint)] text-[var(--color-usdt)]',
        className,
      )}
    >
      {asset === 'INR' ? '₹' : 'T'}
    </span>
  );
}
