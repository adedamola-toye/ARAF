import { mkdir, readFile, writeFile, unlink, rename } from "node:fs/promises";
import path from "node:path";
import { config, assertNotProduction } from "../config";
import { encryptBlob, decryptBlob } from "../crypto";

/**
 * Private object storage. Objects are never publicly addressable: every read goes through an
 * authorised application route. Two adapters:
 *   - local: AES-256-GCM encrypted files on disk (DEVELOPMENT ADAPTER, blocked in production)
 *   - s3:    private S3-compatible bucket with SSE-KMS server-side encryption
 */
export interface ObjectStore {
  readonly name: string;
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  move(fromKey: string, toKey: string): Promise<void>;
  delete(key: string): Promise<void>;
}

class LocalEncryptedStore implements ObjectStore {
  readonly name = "local-encrypted (development adapter)";
  constructor(private root: string) {}
  private file(key: string) {
    if (!/^[a-zA-Z0-9/_.-]+$/.test(key) || key.includes("..")) throw new Error("Invalid object key");
    return path.join(this.root, key);
  }
  async put(key: string, data: Buffer) {
    const f = this.file(key);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, encryptBlob(data), { mode: 0o600 });
  }
  async get(key: string) {
    return decryptBlob(await readFile(this.file(key)));
  }
  async move(from: string, to: string) {
    const t = this.file(to);
    await mkdir(path.dirname(t), { recursive: true });
    await rename(this.file(from), t);
  }
  async delete(key: string) {
    await unlink(this.file(key)).catch(() => undefined);
  }
}

class S3Store implements ObjectStore {
  readonly name = "s3";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private clientPromise: Promise<any> | null = null;
  private async client() {
    if (!this.clientPromise) {
      this.clientPromise = import("@aws-sdk/client-s3").then((m) => ({
        m,
        c: new m.S3Client({
          region: config.s3.region,
          endpoint: config.s3.endpoint,
          forcePathStyle: config.s3.forcePathStyle,
        }),
      }));
    }
    return this.clientPromise;
  }
  async put(key: string, data: Buffer, contentType: string) {
    const { m, c } = await this.client();
    await c.send(
      new m.PutObjectCommand({
        Bucket: config.s3.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
        ServerSideEncryption: config.s3.kmsKeyId ? "aws:kms" : "AES256",
        SSEKMSKeyId: config.s3.kmsKeyId,
      }),
    );
  }
  async get(key: string) {
    const { m, c } = await this.client();
    const r = await c.send(new m.GetObjectCommand({ Bucket: config.s3.bucket, Key: key }));
    return Buffer.from(await r.Body.transformToByteArray());
  }
  async move(from: string, to: string) {
    const { m, c } = await this.client();
    await c.send(
      new m.CopyObjectCommand({
        Bucket: config.s3.bucket,
        CopySource: `${config.s3.bucket}/${from}`,
        Key: to,
        ServerSideEncryption: config.s3.kmsKeyId ? "aws:kms" : "AES256",
        SSEKMSKeyId: config.s3.kmsKeyId,
      }),
    );
    await this.delete(from);
  }
  async delete(key: string) {
    const { m, c } = await this.client();
    await c.send(new m.DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }));
  }
}

let store: ObjectStore | null = null;
export function objectStore(): ObjectStore {
  if (!store) {
    if (config.storageDriver === "s3") {
      if (!config.s3.bucket) throw new Error("S3_BUCKET is required for STORAGE_DRIVER=s3");
      store = new S3Store();
    } else {
      assertNotProduction("Local encrypted file storage");
      store = new LocalEncryptedStore(path.resolve(config.storageLocalDir));
    }
  }
  return store;
}
export function setObjectStoreForTests(s: ObjectStore | null) {
  store = s;
}
