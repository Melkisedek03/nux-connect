// Shared provider RPC types and error codes.
//
// The provider follows the EIP-1193 pattern. Error codes:
//   4001   the user rejected the request
//   4100   the method is not authorized for this origin
//   4200   the method is not supported
//   -32602 invalid parameters

export const ERROR_USER_REJECTED = 4001;
export const ERROR_UNAUTHORIZED = 4100;
export const ERROR_UNSUPPORTED_METHOD = 4200;
export const ERROR_INVALID_PARAMS = -32602;

export class ProviderRpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "ProviderRpcError";
    this.code = code;
  }
}

export interface ProviderRequest {
  method: string;
  params?: unknown;
}

/** Methods defined by the specification. */
export const KNOWN_METHODS = [
  "nux_requestAccounts",
  "nux_getAccounts",
  "nux_getBalance",
  "nux_getNetwork",
  "nux_sendTransaction",
  "nux_signMessage",
  "nux_signPsbt",
  "nux_sendPsbt",
] as const;

export type KnownMethod = (typeof KNOWN_METHODS)[number];

export function isKnownMethod(method: string): method is KnownMethod {
  return (KNOWN_METHODS as readonly string[]).includes(method);
}

/** Envelope used between the inpage provider and the content script. */
export const PAGE_MESSAGE_SOURCE = "nux-connect-inpage";
/** Envelope used between the content script and the inpage provider. */
export const CONTENT_MESSAGE_SOURCE = "nux-connect-content";

export interface PageRequestMessage {
  source: typeof PAGE_MESSAGE_SOURCE;
  kind: "request";
  id: number;
  request: ProviderRequest;
}

export interface PageResponseMessage {
  source: typeof CONTENT_MESSAGE_SOURCE;
  kind: "response";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Provider event relayed from the background through the content script. */
export interface PageEventMessage {
  source: typeof CONTENT_MESSAGE_SOURCE;
  kind: "event";
  event: string;
  args: unknown[];
}
