import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type {
  ObjectStorage,
  ObjectStorageMetadata,
} from "./object-storage";

type ObjectStoragePutValue = ArrayBuffer | ArrayBufferView | ReadableStream | string;
type ObjectStoragePutOptions = { contentType?: string };
type ObjectStorageRange = { offset: number; length: number };
type ObjectStorageObject = ObjectStorageMetadata & { body: ReadableStream };

export class FilesystemObjectStorage implements ObjectStorage {
  constructor(private readonly basePath: string) {
    if (!fs.existsSync(this.basePath)) {
      fs.mkdirSync(this.basePath, { recursive: true });
    }
  }

  private getFilePath(key: string): string {
    // Sanitize key path
    const normalized = path.normalize(key).replace(/^(\.\.(\/|\\|$))+/, "");
    return path.join(this.basePath, normalized);
  }

  private getMetaPath(key: string): string {
    return this.getFilePath(key) + ".meta.json";
  }

  async put(
    key: string,
    value: ObjectStoragePutValue,
    options?: ObjectStoragePutOptions
  ): Promise<void> {
    const filePath = this.getFilePath(key);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (typeof value === "string") {
      await fs.promises.writeFile(filePath, Buffer.from(value, "utf-8"));
    } else if (value instanceof ArrayBuffer) {
      await fs.promises.writeFile(filePath, Buffer.from(value));
    } else if (ArrayBuffer.isView(value)) {
      await fs.promises.writeFile(
        filePath,
        Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      );
    } else if (value instanceof ReadableStream) {
      const chunks: Buffer[] = [];
      const reader = value.getReader();
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(chunk));
      }
      await fs.promises.writeFile(filePath, Buffer.concat(chunks));
    }

    if (options?.contentType) {
      await fs.promises.writeFile(
        this.getMetaPath(key),
        JSON.stringify({ contentType: options.contentType }),
        "utf-8"
      );
    }
  }

  async delete(key: string): Promise<void> {
    const filePath = this.getFilePath(key);
    const metaPath = this.getMetaPath(key);
    try {
      if (fs.existsSync(filePath)) await fs.promises.unlink(filePath);
      if (fs.existsSync(metaPath)) await fs.promises.unlink(metaPath);
    } catch {
      // Ignore delete errors
    }
  }

  async head(key: string): Promise<ObjectStorageMetadata | null> {
    const filePath = this.getFilePath(key);
    if (!fs.existsSync(filePath)) return null;

    const stats = await fs.promises.stat(filePath);
    let contentType = "application/octet-stream";
    const metaPath = this.getMetaPath(key);
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(await fs.promises.readFile(metaPath, "utf-8"));
        if (meta.contentType) contentType = meta.contentType;
      } catch {
        // Fallback
      }
    }

    const etag = `"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}"`;

    return {
      size: stats.size,
      httpEtag: etag,
      writeHttpMetadata(headers: Headers): void {
        headers.set("Content-Type", contentType);
        headers.set("Content-Length", stats.size.toString());
        headers.set("ETag", etag);
      },
    };
  }

  async get(
    key: string,
    options?: { range?: ObjectStorageRange }
  ): Promise<ObjectStorageObject | null> {
    const metadata = await this.head(key);
    if (!metadata) return null;

    const filePath = this.getFilePath(key);
    const start = options?.range?.offset ?? 0;
    const end = options?.range ? start + options.range.length - 1 : undefined;

    const nodeStream = fs.createReadStream(filePath, { start, end });
    const body = Readable.toWeb(nodeStream) as unknown as ReadableStream;

    return {
      ...metadata,
      body,
    };
  }
}
