import { db } from "../db/index.js";
import { passwordResetTokens } from "../db/schema.js";
import type { PasswordResetTokenRepository } from "./types.js";

export class DrizzlePasswordResetTokenRepository implements PasswordResetTokenRepository {
  async create(input: { userId: string; tokenHash: string; expiresAt: Date }): Promise<void> {
    await db
      .insert(passwordResetTokens)
      .values({
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
      });
  }
}