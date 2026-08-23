import { db } from "../src/db/index.js";
import { users } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { hashPassword } from "../src/services/secrets/password.js";

async function main() {
  const email = process.argv[2];
  const newPassword = process.argv[3];

  if (!email || !newPassword) {
    console.error("Usage: npx tsx scripts/reset-password.ts <email> <new-password>");
    process.exit(1);
  }

  const passwordHash = await hashPassword(newPassword);
  const [updated] = await db
    .update(users)
    .set({ passwordHash })
    .where(eq(users.email, email.toLowerCase()))
    .returning({ id: users.id, email: users.email });

  if (!updated) {
    console.error(`User not found: ${email}`);
    process.exit(1);
  }

  console.log(`Password reset for ${updated.email} (${updated.id})`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
