// Content script: the bridge between the page and the extension.
//
// Jobs:
// - Inject the inpage provider script into the page world.
// - Relay provider requests from the page to the background service
//   worker, and relay the responses back.
// - Accept only messages that come from this frame's own window and
//   carry the expected envelope; everything else is ignored.

import {
  CONTENT_MESSAGE_SOURCE,
  PAGE_MESSAGE_SOURCE,
  type PageRequestMessage,
  type PageResponseMessage,
} from "../lib/rpc";

function injectProviderScript(): void {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("inpage.js");
  script.async = false;
  script.onload = () => script.remove();
  (document.head ?? document.documentElement).appendChild(script);
}

injectProviderScript();

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as Partial<PageRequestMessage> | undefined;
  if (!data || data.source !== PAGE_MESSAGE_SOURCE || data.kind !== "request") {
    return;
  }

  const requestMessage = data as PageRequestMessage;
  chrome.runtime.sendMessage(
    {
      kind: "nux-provider-request",
      origin: location.origin,
      request: requestMessage.request,
    },
    (response: { ok: boolean; result?: unknown; error?: { code: number; message: string } }) => {
      const reply: PageResponseMessage = {
        source: CONTENT_MESSAGE_SOURCE,
        kind: "response",
        id: requestMessage.id,
      };
      if (chrome.runtime.lastError) {
        reply.error = {
          code: -32603,
          message: chrome.runtime.lastError.message ?? "Extension unavailable.",
        };
      } else if (response?.ok) {
        reply.result = response.result;
      } else {
        reply.error = response?.error ?? {
          code: -32603,
          message: "Internal error.",
        };
      }
      window.postMessage(reply, location.origin);
    },
  );
});
