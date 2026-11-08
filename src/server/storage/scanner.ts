import net from "node:net";
import { config, assertNotProduction } from "../config";

export interface ScanResult {
  clean: boolean;
  detail: string;
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

/** ClamAV clamd INSTREAM adapter. */
class ClamdScanner implements Scanner {
  readonly name = "clamd";
  scan(data: Buffer): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(config.clamd);
      let out = "";
      sock.setTimeout(30000, () => sock.destroy(new Error("clamd timeout")));
      sock.on("error", reject);
      sock.on("data", (c) => (out += c.toString()));
      sock.on("end", () => {
        const res = out.replace(/\0/g, "").trim();
        if (/OK$/.test(res)) resolve({ clean: true, detail: res });
        else if (/FOUND$/.test(res)) resolve({ clean: false, detail: res });
        else reject(new Error(`clamd: ${res}`));
      });
      sock.on("connect", () => {
        sock.write("zINSTREAM\0");
        for (let i = 0; i < data.length; i += 64 * 1024) {
          const chunk = data.subarray(i, i + 64 * 1024);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(chunk.length);
          sock.write(len);
          sock.write(chunk);
        }
        sock.end(Buffer.alloc(4));
      });
    });
  }
}

let scanner: Scanner | null = null;
export function documentScanner(): Scanner {
  if (!scanner) scanner = config.scannerDriver === "clamd" ? new ClamdScanner() : new DevScanner();
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
