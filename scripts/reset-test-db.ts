import postgres from "postgres";

const DEFAULT_ADMIN_URL = "postgresql://hilbras:hilbras@localhost:5432/postgres";
const TEST_DB = "hilbras_test";

async function main() {
  const adminUrl = process.env.KEYSTONE_ADMIN_DATABASE_URL || DEFAULT_ADMIN_URL;
  const sql = postgres(adminUrl, { max: 1, idle_timeout: 5, connect_timeout: 10 });
  try {
    await sql`SELECT pg_terminate_backend(pg_stat_activity.pid)
              FROM pg_stat_activity
              WHERE pg_stat_activity.datname = ${TEST_DB}
                AND pid <> pg_backend_pid()`;
    await sql`DROP DATABASE IF EXISTS ${sql(TEST_DB)}`;
    await sql`CREATE DATABASE ${sql(TEST_DB)} OWNER hilbras`;
    console.log(`Test database ${TEST_DB} reset.`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
