import { NextResponse } from 'next/server';
import { readEvidence } from '@/server/sandbox/service';
import { currentUser } from '@/server/sandbox/session';

export const dynamic = 'force-dynamic';

/**
 * Evidence bytes.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  AUTHORIZATION IS RE-DERIVED PER REQUEST, IN THE DATABASE.         │
 * │                                                                    │
 * │  `readEvidence` returns a row only when the caller is a            │
 * │  participant in the file's own deal, or an operator reviewing a    │
 * │  raised dispute. The check is a JOIN, not a filter the caller      │
 * │  supplies, so knowing an id grants nothing — there is no signed    │
 * │  URL, no token and no capability that outlives the check.          │
 * │                                                                    │
 * │  A refusal is 404, not 403: distinguishing "not yours" from "does  │
 * │  not exist" would confirm that a given evidence id is real, which  │
 * │  is itself a disclosure.                                           │
 * └────────────────────────────────────────────────────────────────────┘
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ evidenceId: string }> },
) {
  const { evidenceId } = await params;

  const user = await currentUser();
  if (!user) return new NextResponse('Not found', { status: 404 });

  // A malformed id is refused before it reaches the database.
  if (!/^[0-9a-f-]{36}$/i.test(evidenceId)) {
    return new NextResponse('Not found', { status: 404 });
  }

  const file = await readEvidence(user, evidenceId);
  if (!file) return new NextResponse('Not found', { status: 404 });

  /*
   * `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`
   * together are what stop a participant-uploaded file being rendered as
   * active content in the app's own origin. The filename is quoted and
   * stripped of quotes and control characters so it cannot break out of the
   * header — the stored name came from a browser and is not trusted here.
   */
  const safeName = file.filename.replace(/["\\\r\n]/g, '_').slice(0, 120) || 'evidence';

  return new NextResponse(new Uint8Array(file.bytes), {
    status: 200,
    headers: {
      'Content-Type': file.contentType,
      'Content-Length': String(file.bytes.byteLength),
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'X-Content-Type-Options': 'nosniff',
      // Evidence is private to two people; no shared cache may hold it.
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
}
