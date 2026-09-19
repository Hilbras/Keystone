import type { FastifyReply } from "fastify";

export function sendResultError(reply: FastifyReply, result: { success: false; error: { statusCode?: number; message: string; code: string } }) {
  return reply.status(result.error.statusCode ?? 400).send({ error: result.error.message, code: result.error.code });
}

/**
 * Escape special XML characters to prevent XML injection.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
