import { test, expect } from "@playwright/test";

const OWNER_EMAIL = "e2e-owner@example.com";
const OWNER_PASSWORD = "Str0ngP@ssw0rd!";

test.describe("Security dashboard", () => {
  test.setTimeout(60000);

  test("shows security metrics after login", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Keystone Admin" })).toBeVisible();
    await page.getByLabel("Email").fill(OWNER_EMAIL);
    await page.getByLabel("Password").fill(OWNER_PASSWORD);
    await page.getByRole("button", { name: "Sign In", exact: true }).click();

    await page.waitForURL(/dashboard\/overview/);

    await page.goto("/#/dashboard/security");
    await expect(page.getByRole("heading", { name: "Security overview" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recent login activity" })).toBeVisible();

    // Key metric cards are rendered.
    await expect(page.getByText("24h logins")).toBeVisible();
    await expect(page.getByText("24h failed logins")).toBeVisible();
    await expect(page.getByText("Active sessions")).toBeVisible();
    await expect(page.getByText("MFA adoption")).toBeVisible();
  });
});
