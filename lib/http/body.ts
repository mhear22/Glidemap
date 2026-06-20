// Size-limited request body reading.
//
// The naive pattern of concatenating every chunk into a string lets a client
// exhaust server memory by streaming an unbounded body. This reader enforces a
// hard byte cap as chunks arrive and aborts early with a typed error the server
// can translate into a 413 response.

import type http from "node:http";
import { isRecord } from "../utils.js";

export class BodyTooLargeError extends Error {
  readonly statusCode = 413;
  constructor(public readonly limitBytes: number) {
    super(`Request body exceeds the ${limitBytes} byte limit`);
    this.name = "BodyTooLargeError";
  }
}

export class InvalidJsonError extends Error {
  readonly statusCode = 400;
  constructor(message = "Request body must be valid JSON") {
    super(message);
    this.name = "InvalidJsonError";
  }
}

/**
 * Read the full request body as a UTF-8 string, rejecting once more than
 * `maxBytes` have been received. Counts raw bytes (not characters) so multibyte
 * payloads can't slip past the cap.
 */
export function readRawBody(request: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      fn();
    };

    const onData = (chunk: Buffer): void => {
      received += chunk.length;
      if (received > maxBytes) {
        // Stop consuming and surface a typed error. We deliberately do NOT
        // destroy the socket here: the caller still needs to write a 413
        // response. Pausing leaves the connection intact long enough for that;
        // the response should set `Connection: close` to release it afterward.
        request.pause();
        finish(() => reject(new BodyTooLargeError(maxBytes)));
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = (): void => {
      finish(() => resolve(Buffer.concat(chunks).toString("utf8")));
    };

    const onError = (error: Error): void => {
      finish(() => reject(error));
    };

    function cleanup(): void {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
    }

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
  });
}

/** Read and parse a JSON request body, enforcing the byte cap. Empty body -> {}. */
export async function readJsonBody(request: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  const raw = await readRawBody(request, maxBytes);
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new InvalidJsonError();
  }
}

/** Read a JSON body and assert it is a plain object. */
export async function readJsonRecord(
  request: http.IncomingMessage,
  maxBytes: number
): Promise<Record<string, unknown>> {
  const body = await readJsonBody(request, maxBytes);
  if (!isRecord(body)) {
    throw new InvalidJsonError("Request body must be a JSON object");
  }
  return body;
}
