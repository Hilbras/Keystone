import { test, expect } from "@playwright/test";

const SETUP_TOKEN = process.env.KEYSTONE_SETUP_TOKEN || "test-setup-token";
const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://hilbras:hilbras@localhost:5432/hilbras_test";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

export const OWNER_EMAIL = "e2e-owner@example.com";
export const OWNER_PASSWORD = "Str0ngP@ssw0rd!";

test.describe("Keystone simple setup wizard", () => {
  test.setTimeout(120000);

  test("configures a fresh install through the simple wizard", async ({ page }) => {
    await page.goto("/#/setup/simple");

    await expect(page.getByText("Welcome to Keystone")).toBeVisible();

    // Step 1: Welcome + token + environment
    await page.getByRole("button", { name: "Development Local machine with Docker" }).click();
    await page.getByPlaceholder("Paste the token from the server logs").fill(SETUP_TOKEN);
    await page.getByRole("button", { name: "Start setup" }).click();

    // Step 2: Dependencies
    await expect(page.getByText("Connect dependencies")).toBeVisible();
    await page.getByLabel("Database URL").fill(DATABASE_URL);
    await page.getByLabel("Redis URL").fill(REDIS_URL);
    await page.getByRole("button", { name: "Test database" }).click();
    await expect(page.getByText("Database connection successful")).toBeVisible();
    await page.getByRole("button", { name: "Test Redis" }).click();
    await expect(page.getByText("Redis connection successful")).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();

    // Step 3: Owner account
    await expect(page.getByText("Create owner account")).toBeVisible();
    await page.getByLabel("Full name (optional)").fill("E2E Admin");
    await page.getByLabel("Email").fill(OWNER_EMAIL);
    await page.getByLabel("Password").fill(OWNER_PASSWORD);
    await page.getByRole("button", { name: "Continue" }).click();

    // Step 4: First application
    await expect(page.getByText("Connect your first project")).toBeVisible();
    await page.getByLabel("Project name").fill("E2E Test App");
    await page.getByLabel("Project URL").fill("http://localhost:3000");
    await page.getByRole("button", { name: "Finish setup" }).click();

    // Step 5: Diagnostics
    await expect(page.getByText("System diagnostics")).toBeVisible();
  });
});
