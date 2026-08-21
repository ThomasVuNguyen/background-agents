import { EventEmitter } from "node:events";

/**
 * In-memory WebSocket implementation that satisfies the standard EventTarget / WebSocket interface.
 */
export class MemoryWebSocket extends EventEmitter {
  public readyState: number = 1; // 1 = OPEN
  public static readonly CONNECTING = 0;
  public static readonly OPEN = 1;
  public static readonly CLOSING = 2;
  public static readonly CLOSED = 3;

  private peer: MemoryWebSocket | null = null;
  private _attachment: unknown = null;

  constructor() {
    super();
  }

  static createPair(): [MemoryWebSocket, MemoryWebSocket] {
    const a = new MemoryWebSocket();
    const b = new MemoryWebSocket();
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  // Cloudflare WebSocket attachment support
  serializeAttachment(value: unknown): void {
    this._attachment = value;
  }

  deserializeAttachment(): unknown {
    return this._attachment;
  }

  accept(): void {
    this.readyState = MemoryWebSocket.OPEN;
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== MemoryWebSocket.OPEN || !this.peer) {
      return;
    }
    const peer = this.peer;
    queueMicrotask(() => {
      if (peer.readyState === MemoryWebSocket.OPEN) {
        peer.emit("message", { data });
        if (typeof peer.onmessage === "function") {
          peer.onmessage({ data } as MessageEvent);
        }
      }
    });
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === MemoryWebSocket.CLOSED) return;
    this.readyState = MemoryWebSocket.CLOSED;
    const peer = this.peer;
    this.emit("close", { code, reason, wasClean: true });
    if (typeof this.onclose === "function") {
      this.onclose({ code, reason, wasClean: true } as CloseEvent);
    }
    if (peer && peer.readyState !== MemoryWebSocket.CLOSED) {
      peer.readyState = MemoryWebSocket.CLOSED;
      peer.emit("close", { code, reason, wasClean: true });
      if (typeof peer.onclose === "function") {
        peer.onclose({ code, reason, wasClean: true } as CloseEvent);
      }
    }
  }

  // Event listener helpers matching Web standard WebSocket
  addEventListener(event: string, listener: (...args: unknown[]) => void): void {
    this.on(event, listener);
  }

  removeEventListener(event: string, listener: (...args: unknown[]) => void): void {
    this.off(event, listener);
  }

  dispatchEvent(event: Event): boolean {
    this.emit(event.type, event);
    return true;
  }

  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onclose: ((event: CloseEvent) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onopen: ((event: Event) => void) | null = null;
}

export class StandaloneWebSocketPair {
  0: MemoryWebSocket;
  1: MemoryWebSocket;

  constructor() {
    const [a, b] = MemoryWebSocket.createPair();
    this[0] = a;
    this[1] = b;
  }
}

export function installGlobalWebSocketPair(): void {
  if (typeof (globalThis as unknown as { WebSocketPair?: unknown }).WebSocketPair === "undefined") {
    (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = StandaloneWebSocketPair;
  }
}
