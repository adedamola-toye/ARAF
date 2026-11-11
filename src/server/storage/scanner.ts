import { config, assertNotProduction } from "../config";

export interface ScanResult {
  clean: boolean;
  detail: string;
  /** True when scanning was intentionally skipped (e.g. SCANNER_DRIVER=defer); leave in quarantine for the worker. */
  deferred?: boolean;
}
export interface Scanner {
  readonly name: string;
  scan(data: Buffer): Promise<ScanResult>;
}

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

/** DEVELOPMENT ADAPTER: only detects the EICAR test signature. Blocked in production. */
class DevScanner implements Scanner {
  readonly name = "dev-signature-scanner (development adapter)";
  async scan(data: Buffer): Promise<ScanResult> {
    assertNotProduction("Development malware scanner");
    if (data.includes(Buffer.from(EICAR))) return { clean: false, detail: "EICAR test signature detected" };
    return { clean: true, detail: "dev scanner: no signature found" };
  }
}

/**
 * PRODUCTION PASSTHROUGH: malware scanning is disabled. Opt in explicitly with SCANNER_DRIVER=none.
 * Uploads are accepted and marked clean immediately. Use only when no scanning service is available.
 */
class NoScanScanner implements Scanner {
  readonly name = "none (scanning disabled)";
  async scan(): Promise<ScanResult> {
    return { clean: true, detail: "Scanning disabled (SCANNER_DRIVER=none)." };
  }
}

/**
 * Defers scanning to the background worker. Use on web nodes that cannot scan synchronously
 * (e.g. Vercel): uploads are accepted into quarantine and the worker clears them.
 * Must NOT be used by the worker itself, or nothing would ever leave quarantine.
 */
class DeferredScanner implements Scanner {
  readonly name = "defer (scan on background worker)";
  async scan(): Promise<ScanResult> {
    return { clean: false, deferred: true, detail: "Scan deferred to the background worker." };
  }
}

let scanner: Scanner | null = null;
export function documentScanner(): Scanner {
  if (!scanner) {
    if (config.scannerDriver === "none") scanner = new NoScanScanner();
    else if (config.scannerDriver === "defer") scanner = new DeferredScanner();
    else scanner = new DevScanner();
  }
  return scanner;
}

/** Validates upload type by extension + magic bytes. Returns the canonical MIME type. */
export function sniffAllowedType(filename: string, data: Buffer): string | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const head = data.subarray(0, 8);
  const isPdf = head.subarray(0, 5).toString("latin1") === "%PDF-";
  const isPng = head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  switch (ext) {
    case "pdf":
      return isPdf ? "application/pdf" : null;
    case "png":
      return isPng ? "image/png" : null;
    case "jpg":
    case "jpeg":
      return isJpg ? "image/jpeg" : null;
    case "docx":
      return isZip ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : null;
    case "xlsx":
      return isZip ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : null;
    default:
      return null;
  }
}
export const ALLOWED_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "docx", "xlsx"];
