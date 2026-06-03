import type { IncomingMessage, ServerResponse } from "node:http";

type QueryValue = string | string[] | undefined;

export interface VercelRequest extends IncomingMessage {
  query: Record<string, QueryValue>;
}

export interface VercelResponse extends ServerResponse {
  status(statusCode: number): VercelResponse;
  json(body: unknown): void;
  send(body: unknown): void;
}

export function rejectUnsupportedMethod(
  req: VercelRequest,
  res: VercelResponse,
  allowedMethods = ["GET"]
): boolean {
  const method = req.method ?? "GET";
  if (allowedMethods.includes(method)) return false;

  res.setHeader("allow", allowedMethods.join(", "));
  res.status(405).json({ error: "Method not allowed" });
  return true;
}
