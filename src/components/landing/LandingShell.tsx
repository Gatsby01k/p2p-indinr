import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * The landing measure.
 *
 * Wider than `Shell width="wide"` (80rem), and on purpose: the product's
 * authenticated screens are reading surfaces that stop at 1280px, whereas
 * the landing hero is a COMPOSITION — a column of type on the left and a
 * three-layer product demonstration on the right — and it needs the room
 * to hold both without shrinking the demonstration into illegibility.
 *
 * One component so the header, the hero and every section below sit on the
 * same left edge. A marketing page whose logo, headline and first section
 * each start at a slightly different x is the fastest way to look cheap.
 */
export function LandingShell({
  children,
  className,
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'header' | 'section' | 'footer';
}) {
  return (
    <Tag className={cn('mx-auto w-full max-w-[92rem] px-5 sm:px-8 lg:px-10', className)}>
      {children}
    </Tag>
  );
}
