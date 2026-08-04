import { Skeleton } from '@/components/ui/States';

export default function Loading() {
  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-10">
      <Skeleton className="h-8 w-1/3" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}
