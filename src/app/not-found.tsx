import { TopBar } from '@/components/kit/AppChrome';
import { Notice, Shell } from '@/components/kit/primitives';

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar suffix="Sandbox" />
      <main id="main" className="flex flex-1 items-center py-10">
        <Shell width="prose">
          <Notice
            tone="idle"
            title="That page does not exist"
            body="The address may be mistyped, or a deal link may have been reissued under a new reference."
            reassurance="Nothing was changed and no transaction was affected."
            nextStep="Check the link you were sent, or start again from the calculator."
            action={{ href: '/', label: 'Go to the calculator' }}
          />
        </Shell>
      </main>
    </div>
  );
}
