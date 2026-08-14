import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { AdapterUnavailableError, deploymentMode } from './mode';

/**
 * Evidence storage and scanning.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  TWO SEPARATE CAPABILITIES, AND PRODUCTION HAS NEITHER.            │
 * │                                                                    │
 * │  STORAGE holds bytes nobody has inspected. SCANNING is what        │
 * │  decides whether those bytes may ever be handed to another human.  │
 * │  They are separate interfaces because they are separate trust      │
 * │  decisions, and a deployment can plausibly have one without the    │
 * │  other — at which point evidence must stop working rather than     │
 * │  quietly skip the half that is missing.                            │
 * │                                                                    │
 * │  So production refuses both. A deal room that accepts uploads and  │
 * │  serves them back unscanned is a malware distribution channel      │
 * │  with a receipt-shaped user interface, and "we'll add the scanner  │
 * │  later" is how that ships.                                         │
 * └────────────────────────────────────────────────────────────────────┘
 */

export interface StoredObject {
  readonly storageKey: string;
  readonly byteSize: number;
  readonly contentHash: string;
}

export interface EvidenceStorageAdapter {
  readonly providerKey: string;
  readonly kind: 'SANDBOX' | 'PRODUCTION';

  /**
   * Reserve a place for bytes that have not arrived yet.
   *
   * The key is derived from the evidence id rather than the filename: a
   * user-supplied filename in a storage path is a directory-traversal
   * bug waiting to be written, and two people uploading `receipt.pdf`
   * must not collide.
   */
  reserve(evidenceId: string): Promise<{ storageKey: string }>;

  /** Accept bytes against a reservation. Returns what actually arrived. */
  put(storageKey: string, bytes: Buffer): Promise<StoredObject>;

  /** Fetch bytes. Callers must have re-authorised first — this does not. */
  get(storageKey: string): Promise<Buffer | null>;
}

export type ScanVerdict = 'CLEAN' | 'INFECTED' | 'UNSCANNABLE';

export interface EvidenceScannerAdapter {
  readonly providerKey: string;
  readonly kind: 'SANDBOX' | 'PRODUCTION';
  scan(bytes: Buffer, mediaType: string): Promise<{ verdict: ScanVerdict; detail: string }>;
}

/* ------------------------------------------------------------------ *
 * Sandbox implementations
 * ------------------------------------------------------------------ */

/**
 * In-process storage.
 *
 * A `Map`, and deliberately not the database: the point of the interface
 * is that evidence bytes live somewhere the ledger does not, so the
 * sandbox honours that separation even though it could cheat. Keys are
 * `sbx/` prefixed so a key that escaped into a production bucket listing
 * would announce itself.
 */
class SandboxEvidenceStorage implements EvidenceStorageAdapter {
  readonly providerKey = 'sandbox-object-store';
  readonly kind = 'SANDBOX' as const;

  private static readonly objects = new Map<string, Buffer>();

  async reserve(evidenceId: string): Promise<{ storageKey: string }> {
    return { storageKey: `sbx/${evidenceId}/${randomUUID()}` };
  }

  async put(storageKey: string, bytes: Buffer): Promise<StoredObject> {
    SandboxEvidenceStorage.objects.set(storageKey, Buffer.from(bytes));
    return {
      storageKey,
      byteSize: bytes.byteLength,
      // Hashed from what ARRIVED, never from what the client claimed.
      contentHash: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  async get(storageKey: string): Promise<Buffer | null> {
    return SandboxEvidenceStorage.objects.get(storageKey) ?? null;
  }
}

/**
 * A stand-in scanner.
 *
 * It recognises the EICAR test string and a handful of executable magic
 * numbers, and it is honest about being a stand-in: it returns
 * `UNSCANNABLE` for anything it cannot positively judge rather than
 * assuming the best. That default is the whole design — a scanner that
 * says CLEAN when it does not know is worse than no scanner, because it
 * produces a green tick nobody should trust.
 */
class SandboxEvidenceScanner implements EvidenceScannerAdapter {
  readonly providerKey = 'sandbox-scanner';
  readonly kind = 'SANDBOX' as const;

  async scan(bytes: Buffer, mediaType: string): Promise<{ verdict: ScanVerdict; detail: string }> {
    const head = bytes.subarray(0, 512).toString('binary');

    if (head.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')) {
      return { verdict: 'INFECTED', detail: 'EICAR test signature.' };
    }
    // MZ (PE), ELF, Mach-O: an executable arriving as "image/png" is a
    // lie about content type, which is exactly what a scanner is for.
    if (
      head.startsWith('MZ') ||
      head.startsWith('\x7fELF') ||
      head.startsWith('\xcf\xfa\xed\xfe') ||
      head.startsWith('\xfe\xed\xfa\xcf')
    ) {
      return { verdict: 'INFECTED', detail: 'Executable image submitted as a document.' };
    }

    // The declared type must match what the bytes actually are.
    const magicOk =
      (mediaType === 'application/pdf' && head.startsWith('%PDF-')) ||
      (mediaType === 'image/png' && head.startsWith('\x89PNG')) ||
      (mediaType === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8) ||
      (mediaType === 'image/webp' && head.startsWith('RIFF') && head.includes('WEBP'));

    if (!magicOk) {
      return {
        verdict: 'UNSCANNABLE',
        detail: `Content does not match the declared type ${mediaType}.`,
      };
    }
    return { verdict: 'CLEAN', detail: 'Sandbox scanner: no signature matched.' };
  }
}

/* ------------------------------------------------------------------ *
 * Resolution — production refuses
 * ------------------------------------------------------------------ */

export function getEvidenceStorageAdapter(): EvidenceStorageAdapter {
  if (deploymentMode() === 'PRODUCTION') {
    throw new AdapterUnavailableError(
      'evidence-storage',
      'DEL-09 (Operations, Secrets and Dispatch)',
      'No object-storage provider is configured and no credentials exist. ' +
        'Refusing to accept a customer document with nowhere durable to put it.',
    );
  }
  return new SandboxEvidenceStorage();
}

export function getEvidenceScannerAdapter(): EvidenceScannerAdapter {
  if (deploymentMode() === 'PRODUCTION') {
    throw new AdapterUnavailableError(
      'evidence-scanning',
      'DEL-09 (Operations, Secrets and Dispatch)',
      'No malware-scanning provider is configured. Refusing to serve ' +
        'user-uploaded files that nothing has inspected.',
    );
  }
  return new SandboxEvidenceScanner();
}

/** Non-throwing probe, so a page render never 500s on a missing adapter. */
export function evidenceAvailable(): boolean {
  return deploymentMode() !== 'PRODUCTION';
}
