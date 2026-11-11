// Inpage provider: exposes `window.nux` to web pages.
//
// This is the only surface a dApp ever sees. It holds no keys, no
// balances, and no transaction logic; it forwards requests to the
// content script and returns the background's answers as Promises,
// following the EIP-1193 pattern.

import {
  CONTENT_MESSAGE_SOURCE,
  ERROR_INVALID_PARAMS,
  PAGE_MESSAGE_SOURCE,
  ProviderRpcError,
  type PageRequestMessage,
  type ProviderRequest,
} from "../lib/rpc";

type Listener = (...args: unknown[]) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: ProviderRpcError) => void;
}

class NuxProvider {
  readonly isNuxConnect = true;

  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor() {
    window.addEventListener("message", (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as
        | {
            source?: string;
            kind?: string;
            id?: number;
            result?: unknown;
            error?: { code: number; message: string };
            event?: string;
            args?: unknown[];
          }
        | undefined;
      if (!data || data.source !== CONTENT_MESSAGE_SOURCE) {
        return;
      }
      if (data.kind === "event") {
        if (typeof data.event === "string") {
          this.emit(data.event, ...(data.args ?? []));
        }
        return;
      }
      if (data.kind !== "response") {
        return;
      }
      const pending = this.pending.get(data.id as number);
      if (!pending) return;
      this.pending.delete(data.id as number);
      if (data.error) {
        pending.reject(new ProviderRpcError(data.error.code, data.error.message));
      } else {
        pending.resolve(data.result);
      }
    });
  }

  request(args: ProviderRequest): Promise<unknown> {
    if (!args || typeof args.method !== "string" || args.method.length === 0) {
      return Promise.reject(
        new ProviderRpcError(
          ERROR_INVALID_PARAMS,
          "A request must carry a method name.",
        ),
      );
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const message: PageRequestMessage = {
        source: PAGE_MESSAGE_SOURCE,
        kind: "request",
        id,
        request: { method: args.method, params: args.params },
      };
      window.postMessage(message, location.origin);
    });
  }

  on(event: string, listener: Listener): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  removeListener(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  /** Internal: used by later milestones to emit accountsChanged etc. */
  protected emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        listener(...args);
      } catch {
        // A faulty dApp listener must not break the provider.
      }
    }
  }
}

const provider = new NuxProvider();

Object.defineProperty(window, "nux", {
  value: provider,
  writable: false,
  configurable: false,
});

window.dispatchEvent(new Event("nux#initialized"));
