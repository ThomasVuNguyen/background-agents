interface CacheEntry {
  value: string;
  expiresAt: number | null;
}

export class StandaloneKVNamespace {
  private readonly store = new Map<string, CacheEntry>();

  async get(key: string, options?: unknown): Promise<any> {
    const entry = this.store.get(key);
    if (!entry) return null;

    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    const type = typeof options === "string" ? options : (options as { type?: string })?.type;
    if (type === "json") {
      try {
        return JSON.parse(entry.value);
      } catch {
        return null;
      }
    }
    if (type === "arrayBuffer") {
      return Buffer.from(entry.value).buffer;
    }
    return entry.value;
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: { expirationTtl?: number; expiration?: number }
  ): Promise<void> {
    let strVal: string;
    if (typeof value === "string") {
      strVal = value;
    } else if (value instanceof ArrayBuffer) {
      strVal = Buffer.from(value).toString();
    } else if (ArrayBuffer.isView(value)) {
      strVal = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString();
    } else {
      strVal = String(value);
    }

    let expiresAt: number | null = null;
    if (options?.expirationTtl) {
      expiresAt = Date.now() + options.expirationTtl * 1000;
    } else if (options?.expiration) {
      expiresAt = options.expiration * 1000;
    }

    this.store.set(key, { value: strVal, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(): Promise<any> {
    const keys = Array.from(this.store.keys()).map((name) => ({ name }));
    return { keys, list_complete: true, cursor: "" };
  }

  async getWithMetadata(): Promise<any> {
    const val = await this.get(arguments[0], arguments[1]);
    return { value: val, metadata: null };
  }
}
