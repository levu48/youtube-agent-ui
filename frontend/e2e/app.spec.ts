import { appendFileSync } from "node:fs";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const IDEA = "Hồ Chí Minh: Nationalist or Communist?";
// Mirrors e2e/serve.mjs: "fake" replays captured engine output and supports slow jobs.
const ENGINE = process.env.E2E_ENGINE ?? "auto";

async function axe(page: Page) {
  // Let data-dependent UI render first so the scan is deterministic.
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(
    serious.map((v) => `${v.id}: ${v.help} -> ${v.nodes.map((n) => `${n.target.join(" ")} ${n.failureSummary ?? ""}`).join(" | ")}`),
  ).toEqual([]);
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test.describe.configure({ mode: "serial" });

test("dashboard empty state and health", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "My Projects" })).toBeVisible();
  await expect(page.getByText("No projects yet")).toBeVisible();
  await expect(page.getByRole("link", { name: "Create your first project" })).toBeVisible();
  // Engine is real and available; Ollama is deliberately unreachable in E2E.
  await expect(page.getByText(/Local · 0\.\d/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Ollama.*show details/ })).toContainText("Unavailable");
  // Future modules are visible but not links.
  const nav = page.getByRole("navigation", { name: "Main" }).first();
  await expect(nav.getByRole("link")).toHaveCount(2);
  await expect(page.getByRole("link", { name: "Dashboard" }).first()).toHaveAttribute("aria-current", "page");
  await axe(page);
});

test("create project with keyboard only", async ({ page }) => {
  await page.goto("/projects/new");
  await expect(page.getByRole("heading", { level: 1, name: "New Project" })).toBeVisible();
  await axe(page);

  // Submit empty: errors are announced and the first invalid field is focused.
  await page.getByRole("button", { name: "Create Project" }).focus();
  await page.keyboard.press("Enter");
  const idea = page.getByLabel(/Documentary topic/);
  await expect(idea).toBeFocused();
  await expect(idea).toHaveAttribute("aria-invalid", "true");

  await page.keyboard.type(IDEA);
  await expect(page.getByLabel(/Project slug/)).toHaveValue("ho-chi-minh-nationalist-or-communist");
  await page.keyboard.press("Tab");
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("hcm-demo");
  await expect(page.getByText(/projects\/hcm-demo/)).toBeVisible();
  await page.getByLabel(/Target duration/).fill("3");
  await page.getByLabel(/Audience/).fill("Khán giả Việt Nam");
  await page.getByRole("button", { name: "Create Project" }).focus();
  await page.keyboard.press("Enter");

  await page.waitForURL(/\/projects\/hcm-demo$/);
  await expect(page.getByRole("heading", { level: 1, name: IDEA })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Generate a draft" })).toBeVisible();
});

test("duplicate slug is rejected inline and input is kept", async ({ page }) => {
  await page.goto("/projects/new");
  await page.getByLabel(/Documentary topic/).fill("Another documentary idea");
  await page.getByLabel(/Project slug/).fill("hcm-demo");
  await page.getByRole("button", { name: "Create Project" }).click();
  await expect(page.getByLabel(/Project slug/)).toHaveAccessibleDescription(/already/);
  await expect(page.getByLabel(/Documentary topic/)).toHaveValue("Another documentary idea");
});

test("workspace: Ollama unavailable is explained; fixture draft streams real logs", async ({ page }) => {
  await page.goto("/projects/hcm-demo");
  await expect(page.getByText("Status unavailable")).toHaveCount(0);
  await expect(page.locator("#generate-draft").getByText(/not reachable/)).toBeVisible();
  const generate = page.locator("#generate-draft").getByRole("button", { name: /Generate Draft/ });
  await expect(generate).toBeDisabled();
  await axe(page);

  await page.getByLabel(/Offline fixture/).check();
  await expect(generate).toBeEnabled();
  await generate.click();

  await expect(page).toHaveURL(/\?job=/);
  const log = page.getByRole("log");
  await expect(log).toContainText("draft published", { timeout: 30_000 });
  await expect(log).toContainText("succeeded (exit 0)");
  await expect(page.getByText("Job status: Succeeded").first()).toBeAttached();
  // Engine stage (authoritative) is separate from the job state.
  await expect(page.getByRole("heading", { name: "Review the draft" })).toBeVisible();
  await expect(page.getByText("Awaiting review").first()).toBeVisible();

  // Refresh preserves the job and its logs (state comes from the API, not the browser).
  await page.reload();
  await expect(page.getByRole("log")).toContainText("draft published");
  await expect(page.getByText("Recent jobs")).toBeVisible();
});

test("draft viewer is read-only and renders Vietnamese", async ({ page }) => {
  await page.goto("/projects/hcm-demo");
  await page.getByRole("link", { name: "View Draft" }).first().click();
  await page.waitForURL(/\/draft$/);
  await expect(page.getByText("Read-only")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Projects");
  await expect(page.getByRole("navigation", { name: "Outline" })).toBeVisible();
  const script = page.getByRole("article");
  await expect(script).toHaveAttribute("lang", "vi");
  await expect(script.getByRole("heading", { level: 3 }).first()).toContainText(/Câu hỏi đặt ra/);
  await expect(page.getByRole("heading", { name: "Validation (draft-check)" })).toBeVisible();
  await expect(page.getByText(/G1 approval, as reported by the engine:/)).toContainText("Not approved");
  // The draft text itself is not editable yet (editing needs an engine edit command).
  await expect(page.getByRole("button", { name: /\b(save|edit)\b/i })).toHaveCount(0);
  await expect(page.locator("article textarea, article [contenteditable]")).toHaveCount(0);

  await page.getByRole("button", { name: "Markdown view" }).click();
  await expect(page.locator(".prose-draft h1")).toBeVisible();
  await expect(page.locator(".prose-draft script")).toHaveCount(0);
  await axe(page);
});

/** A change made outside the UI (editor or CLI). Re-serialising whitespace keeps the draft
 * valid, but changes the bytes the engine bound into the approval. */
function touchStoryboardOutsideUi() {
  appendFileSync(join(process.env.E2E_TMP!, "projects", "hcm-demo", "storyboard.draft.json"), "\n");
}

test("G1: validate and approve; a later change makes it stale; a changed draft is not approved blindly", async ({
  page,
}) => {
  await page.goto("/projects/hcm-demo/draft");
  const panel = page.getByRole("region", { name: "Editorial approval (G1)" });
  await expect(panel.getByText("G1 not approved")).toBeVisible();
  await expect(page.getByText("Passing checks is not approval")).toBeVisible();

  const approve = panel.getByRole("button", { name: "Approve Editorial Draft (G1)" });
  await approve.click();
  const reviewer = panel.getByLabel(/Reviewer name/);
  await expect(reviewer).toBeFocused();
  await expect(reviewer).toHaveAttribute("aria-invalid", "true");
  await reviewer.fill("Nguyễn Văn A");
  await panel.getByLabel(/Comment/).fill("Chấp nhận bản nháp");
  await approve.click();

  const dialog = page.getByRole("dialog", { name: "Approve this editorial draft (G1)?" });
  await expect(dialog).toContainText("does not verify historical claims, rights or release readiness");
  await expect(dialog).toContainText("will be recorded with the approval");
  await axe(page);
  await dialog.getByRole("button", { name: "Approve draft" }).click();

  await expect(panel.getByText(/Approved by Nguyễn Văn A/)).toBeVisible();
  await expect(panel.getByText("Comment: Chấp nhận bản nháp")).toBeVisible();
  await expect(approve).toHaveCount(0);
  // The state comes from the engine, so it survives a reload.
  await page.reload();
  await expect(panel.getByText("G1 approved")).toBeVisible();
  await page.goto("/projects/hcm-demo");
  await expect(page.getByRole("heading", { name: "Review the draft" })).toHaveCount(0);

  // A reviewed file changes outside the UI: the engine reports the approval as out of date.
  touchStoryboardOutsideUi();
  await page.goto("/projects/hcm-demo/draft");
  await expect(panel.getByText("G1 approval out of date")).toBeVisible();
  await expect(panel.getByText("G1 approved")).toHaveCount(0);
  await expect(panel.getByText(/Previously approved by Nguyễn Văn A/)).toBeVisible();
  await expect(panel).toContainText("storyboard.draft.json changed after it was approved");
  await axe(page);

  // It changes again after this page validated it: approval is refused, not applied blindly.
  touchStoryboardOutsideUi();
  await expect(panel.getByLabel(/Reviewer name/)).toHaveValue("Nguyễn Văn A"); // remembered
  await approve.click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve draft" }).click();
  const alert = panel.getByRole("alert");
  await expect(alert).toContainText("The draft changed after you last validated it");
  await expect(panel.getByText("G1 approval out of date")).toBeVisible();
  await alert.getByRole("button", { name: /Load the latest draft/ }).click();
  await expect(approve).toBeEnabled();
  await approve.click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve draft" }).click();
  await expect(panel.getByText("G1 approved")).toBeVisible();
});

test("unknown project and missing draft states", async ({ page }) => {
  await page.goto("/projects/does-not-exist");
  await expect(page.getByText("Project not found")).toBeVisible();
  await page.goto("/projects/new");
  await page.getByLabel(/Documentary topic/).fill("An empty project for states");
  await page.getByLabel(/Project slug/).fill("empty-one");
  await page.getByRole("button", { name: "Create Project" }).click();
  await page.waitForURL(/empty-one$/);
  await page.goto("/projects/empty-one/draft");
  await expect(page.getByText("No draft yet")).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to Project" }).first()).toBeVisible();
});

test("cancel a running job: confirmation, then outcome confirmed by the backend", async ({ page }) => {
  test.skip(ENGINE !== "fake", "needs the fake engine's slow mode (real fixture drafts finish in ~0.2 s)");
  await page.goto("/projects/new");
  await page.getByLabel(/Documentary topic/).fill("Slow job for cancel test [slow]");
  await page.getByLabel(/Project slug/).fill("slow-cancel");
  await page.getByRole("button", { name: "Create Project" }).click();
  await page.waitForURL(/slow-cancel$/);
  await page.getByLabel(/Offline fixture/).check();
  await page.locator("#generate-draft").getByRole("button", { name: /Generate Draft/ }).click();
  const log = page.getByRole("log");
  await expect(log).toContainText("working", { timeout: 15_000 });
  await expect(page.getByText("Job status: Running").first()).toBeAttached();

  const cancel = page.getByRole("button", { name: "Cancel job" });
  await cancel.click();
  const dialog = page.getByRole("dialog", { name: "Stop this draft generation?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep running" }).click();
  await expect(dialog).toBeHidden();
  await expect(cancel).toBeFocused(); // focus restored to the opener

  await cancel.click();
  await page.getByRole("dialog").getByRole("button", { name: "Stop generation" }).click();
  await expect(page.getByText("Job status: Cancelled").first()).toBeAttached({ timeout: 20_000 });
  await expect(log).toContainText("cancelled (exit 130)");
  await expect(page.getByRole("button", { name: /Cancel job|Cancelling/ })).toHaveCount(0);
  // Refresh: the outcome comes from the backend, not browser state.
  await page.reload();
  await expect(page.getByText("Job status: Cancelled").first()).toBeAttached();
});

for (const [name, width, height] of [
  ["desktop", 1440, 900],
  ["tablet", 768, 1024],
  ["mobile", 375, 812],
] as const) {
  test(`responsive layout at ${name} (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    for (const path of ["/", "/projects/new", "/projects/hcm-demo", "/projects/hcm-demo/draft"]) {
      await page.goto(path);
      await expect(page.locator("h1").first()).toBeVisible();
      await page.waitForLoadState("networkidle");
      await noHorizontalOverflow(page);
    }
    if (width < 1024) {
      await page.getByRole("button", { name: "Open navigation" }).click();
      await expect(page.getByRole("dialog").getByRole("link", { name: "Projects" })).toBeVisible();
      await page.keyboard.press("Escape");
    }
  });
}

test("200% zoom and reduced motion keep core flows usable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  // 200% zoom of a 1280px window is equivalent to a 640px CSS viewport.
  await page.setViewportSize({ width: 640, height: 450 });
  for (const path of ["/", "/projects/new", "/projects/hcm-demo", "/projects/hcm-demo/draft"]) {
    await page.goto(path);
    await expect(page.locator("h1").first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    await noHorizontalOverflow(page);
  }
  const duration = await page.evaluate(() => {
    const el = document.querySelector(".animate-spin, [class*='animate']");
    return el ? getComputedStyle(el).animationDuration : "0s";
  });
  expect(["0s", "1e-05s", "0.00001s"]).toContain(duration);
});
