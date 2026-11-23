import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

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

async function settled(dialog: Locator) {
  // Scan a dialog only after its open animation, not a half-faded frame.
  await expect(dialog).toBeVisible();
  await dialog.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((x) => x.finished)));
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

async function openTab(page: Page, name: "Outline" | "Script" | "Validation") {
  await page.getByRole("tab", { name: new RegExp(`^${name}`) }).click();
}

test("draft workspace renders Vietnamese in the editor, full script and Markdown views", async ({ page }) => {
  await page.goto("/projects/hcm-demo");
  await page.getByRole("link", { name: "Edit Draft" }).first().click();
  await page.waitForURL(/\/draft$/);
  await expect(page.getByText("Editable", { exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Projects");
  await expect(page.getByRole("navigation", { name: "Outline sections" })).toBeVisible();
  await expect(page.getByLabel(/^Title/)).toHaveAttribute("lang", "vi");
  await axe(page);

  await openTab(page, "Script");
  await expect(page.getByLabel(/^Narration/)).toHaveAttribute("lang", "vi");
  await page.getByRole("button", { name: "Full script" }).click();
  const script = page.getByRole("article");
  await expect(script).toHaveAttribute("lang", "vi");
  await expect(script.getByRole("heading", { level: 3 }).first()).toContainText(/Câu hỏi đặt ra/);

  await openTab(page, "Validation");
  await expect(page.getByRole("heading", { name: "Validation (draft-check)" })).toBeVisible();
  await expect(page.getByText(/G1 approval, as reported by the engine:/)).toContainText("Not approved");

  await openTab(page, "Script");
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
  await openTab(page, "Validation");
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
  await openTab(page, "Validation");
  await expect(panel.getByText("G1 approved")).toBeVisible();
  await page.goto("/projects/hcm-demo");
  await expect(page.getByRole("heading", { name: "Review the draft" })).toHaveCount(0);

  // A reviewed file changes outside the UI: the engine reports the approval as out of date.
  touchStoryboardOutsideUi();
  await page.goto("/projects/hcm-demo/draft");
  await openTab(page, "Validation");
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

test("edit outline and Vietnamese script, validate, approve; a later edit makes it stale; a conflicting save is refused", async ({
  page,
}) => {
  await page.goto("/projects/hcm-demo/draft");
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled();

  // Outline: title and the key points of the second section.
  const title = page.getByLabel(/^Title/);
  await title.fill("Hồ Chí Minh: hành trình (bản biên tập)");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  const outlineNav = page.getByRole("navigation", { name: "Outline sections" });
  await outlineNav.getByRole("button").nth(2).click();
  await page.getByLabel(/^Key points/).fill("Điểm thứ nhất\nĐiểm thứ hai");
  await expect(outlineNav.getByText("Edited")).toHaveCount(2);

  // Script: Vietnamese narration of the second section.
  await openTab(page, "Script");
  const scriptNav = page.getByRole("navigation", { name: "Script sections" });
  await scriptNav.getByRole("button").nth(1).click();
  const narration = "Năm 1911, người thanh niên Nguyễn Tất Thành rời bến Nhà Rồng.\n\nÔng đi qua nhiều nước.";
  await page.getByLabel(/^Narration/).fill(narration);

  // Approval is not offered while edits are unsaved.
  await openTab(page, "Validation");
  const panel = page.getByRole("region", { name: "Editorial approval (G1)" });
  // (The draft is still approved from the previous test, so the panel says the approval
  // covers the saved draft only; the approve button is never enabled while edits are unsaved.)
  await expect(panel).toContainText("You have unsaved edits");
  await expect(panel.getByRole("button", { name: "Approve Editorial Draft (G1)", disabled: false })).toHaveCount(0);
  await axe(page);

  await save.click();
  await expect(page.getByText(/Saved by the engine/)).toBeVisible();
  await expect(page.getByText("Unsaved changes")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Validation (draft-check)" })).toBeVisible();
  await expect(panel.getByText("G1 approval out of date")).toBeVisible(); // edited after the earlier approval

  // The saved text is the engine's: it survives a reload and shows in the generated views.
  await page.reload();
  await expect(page.getByLabel(/^Title/)).toHaveValue("Hồ Chí Minh: hành trình (bản biên tập)");
  await openTab(page, "Script");
  await page.getByRole("button", { name: "Full script" }).click();
  await expect(page.getByRole("article")).toContainText("người thanh niên Nguyễn Tất Thành rời bến Nhà Rồng");

  // Approve the edited version.
  await openTab(page, "Validation");
  await panel.getByLabel(/Reviewer name/).fill("Trần Thị B");
  await panel.getByRole("button", { name: "Approve Editorial Draft (G1)" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve draft" }).click();
  await expect(panel.getByText("G1 approved")).toBeVisible();

  // A later edit makes the approval out of date.
  await openTab(page, "Outline");
  await page.getByLabel(/^Central question/).fill("Ông là người yêu nước hay người cộng sản?");
  await save.click();
  await expect(page.getByText(/Saved by the engine/)).toBeVisible();
  await openTab(page, "Validation");
  await expect(panel.getByText("G1 approval out of date")).toBeVisible();
  await expect(panel.getByText("G1 approved")).toHaveCount(0);

  // A change made outside the UI while editing: the save is refused, nothing is overwritten.
  await openTab(page, "Outline");
  await page.getByLabel(/^Title/).fill("Tiêu đề xung đột");
  touchStoryboardOutsideUi();
  await save.click();
  const dialog = page.getByRole("dialog", { name: "The draft changed since you loaded it" });
  await expect(dialog.getByLabel("Your unsaved edits")).toHaveValue(/Tiêu đề xung đột/);
  await settled(dialog); // not a half-faded frame (a flaky contrast result in CI)
  await axe(page);
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.getByLabel(/^Title/)).toHaveValue("Tiêu đề xung đột");
  await save.click();
  await page.getByRole("dialog").getByRole("button", { name: /Reload latest/ }).click();
  await expect(page.getByLabel(/^Title/)).toHaveValue("Hồ Chí Minh: hành trình (bản biên tập)");
  await expect(page.getByText("Unsaved changes")).toHaveCount(0);
});

test("browser Back and Forward with unsaved edits: the edits are kept for the tab and restored", async ({ page }) => {
  await page.goto("/projects/hcm-demo");
  await page.getByRole("link", { name: "Edit Draft" }).first().click();
  const title = page.getByLabel(/^Title/);
  await expect(title).toBeEditable();
  const saved = await title.inputValue();
  await title.fill("Tiêu đề chưa lưu");
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  // Back (history navigation: no beforeunload, no link click) and Forward again.
  await page.goBack();
  await expect(page).toHaveURL(/\/projects\/hcm-demo$/);
  await page.goForward();
  await expect(page.getByLabel(/^Title/)).toHaveValue("Tiêu đề chưa lưu");
  await expect(page.getByText("Your unsaved edits were restored.")).toBeVisible();
  await expect(page.getByText("Unsaved changes")).toBeVisible();

  // Back, then open the draft again from the workspace: still there.
  await page.goBack();
  await page.getByRole("link", { name: "Edit Draft" }).first().click();
  await expect(page.getByLabel(/^Title/)).toHaveValue("Tiêu đề chưa lưu");
  await axe(page);

  // Nothing reached the engine: discarding returns to the saved draft, which a reload confirms.
  await page.getByRole("button", { name: "Discard" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Discard edits" }).click();
  await expect(page.getByLabel(/^Title/)).toHaveValue(saved);
  await page.reload();
  await expect(page.getByLabel(/^Title/)).toHaveValue(saved);
  await expect(page.getByText("Your unsaved edits were restored.")).toHaveCount(0);
});

test("browser storage refusing the backup: a visible warning, a copy option, and Back still keeps the edits", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    };
  });
  await page.goto("/projects/hcm-demo");
  await page.getByRole("link", { name: "Edit Draft" }).first().click();
  const title = page.getByLabel(/^Title/);
  await expect(title).toBeEditable();
  const saved = await title.inputValue();
  await title.fill("Không lưu được bản sao");
  const warning = page.getByRole("alert").filter({ hasText: "not keeping a backup of your unsaved edits" });
  await expect(warning).toBeVisible();
  await expect(warning.getByRole("button", { name: "Copy my edits" })).toBeVisible();
  await axe(page);

  await page.goBack();
  await expect(page).toHaveURL(/\/projects\/hcm-demo$/);
  await page.goForward();
  await expect(page.getByLabel(/^Title/)).toHaveValue("Không lưu được bản sao");
  await expect(warning).toBeVisible();

  await page.getByRole("button", { name: "Discard" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Discard edits" }).click();
  await expect(page.getByLabel(/^Title/)).toHaveValue(saved);
  await expect(warning).toHaveCount(0);
});

test("research: prepare claims, a confirmed search, a queued and a fetched URL, the snapshot reader", async ({
  page,
}) => {
  // Research needs a current G1: the editing tests left it out of date, so approve again.
  await page.goto("/projects/hcm-demo/draft");
  await openTab(page, "Validation");
  const panel = page.getByRole("region", { name: "Editorial approval (G1)" });
  const approve = panel.getByRole("button", { name: "Approve Editorial Draft (G1)" });
  if (await approve.count()) {
    await panel.getByLabel(/Reviewer name/).fill("Trần Thị B");
    await approve.click();
    await page.getByRole("dialog").getByRole("button", { name: "Approve draft" }).click();
    await expect(panel.getByText("G1 approved")).toBeVisible();
  }

  await page.goto("/projects/hcm-demo");
  await page.getByRole("link", { name: "Research" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Research" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Research" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByRole("button", { name: "Prepare claims" }).click();
  const claims = page.getByRole("tabpanel");
  await expect(claims.getByText(/tool suggestion \(not a verdict\)/).first()).toBeVisible({ timeout: 30_000 });
  await axe(page);

  // A search: nothing starts before the engine's preview and an explicit confirmation.
  await page.getByRole("tab", { name: "Sources" }).click();
  await page.getByRole("button", { name: /Search test sources/ }).click();
  const search = page.getByRole("dialog", { name: "Search for sources" });
  await expect(search.getByRole("button", { name: /Start search/ })).toBeDisabled();
  await search.getByRole("button", { name: /Check what would be contacted/ }).click();
  await expect(search.getByRole("list", { name: "Hosts that may be contacted" })).toContainText("fixture.invalid");
  await settled(search);
  await axe(page);
  await search.getByRole("checkbox", { name: /I confirm that these hosts/ }).check();
  await search.getByRole("button", { name: /Start search/ }).click();
  await expect(page.getByText(/Source collection finished|Succeeded/).first()).toBeVisible({ timeout: 30_000 });

  // A queued URL contacts nothing; a fetched one is confined to its host.
  await page.getByRole("button", { name: /Add URL/ }).click();
  let add = page.getByRole("dialog", { name: "Add a URL" });
  await add.getByLabel(/Page address/).fill("https://vi.wikipedia.org/wiki/Ba_Đình");
  await add.getByRole("button", { name: "Queue URL" }).click();
  await expect(page.getByText("https://vi.wikipedia.org/wiki/Ba_Đình")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /Add URL/ }).click();
  add = page.getByRole("dialog", { name: "Add a URL" });
  await add.getByLabel(/Page address/).fill("https://archive.fixture.invalid/tuyen-ngon-1945");
  await add.getByRole("radio", { name: /Fetch it now/ }).check();
  await expect(add.getByRole("button", { name: "Fetch page" })).toBeDisabled();
  await add.getByRole("checkbox", { name: /archive\.fixture\.invalid may be contacted/ }).check();
  await add.getByRole("button", { name: "Fetch page" }).click();
  const read = page.getByRole("button", { name: /^Read / }).first();
  await expect(read).toBeVisible({ timeout: 30_000 });
  await read.click();
  const text = page.getByLabel("Snapshot text");
  await expect(text).toContainText("1945");
  await expect(page.getByRole("dialog")).toContainText("Test data: can never support real research");
  await settled(page.getByRole("dialog"));
  await axe(page);
  await page.keyboard.press("Escape");

  await page.getByRole("tab", { name: "Validation" }).click();
  await expect(page.getByRole("heading", { name: "Validation (research-check)" })).toBeVisible();
});

test("research review: import a document, link evidence, decide, outdated and confirmed again, completeness, fixture text", async ({ page }) => {
  const doc =
    "Ngày 2 tháng 9 năm 1945, tại Quảng trường Ba Đình ở Hà Nội, Chủ tịch Hồ Chí Minh đọc bản Tuyên ngôn Độc lập, khai sinh nước Việt Nam Dân chủ Cộng hòa.";
  await page.goto("/projects/hcm-demo/research");
  await page.getByRole("tab", { name: "Sources" }).click();
  await page.getByRole("button", { name: /Import document/ }).click();
  const imp = page.getByRole("dialog", { name: "Import a document" });
  await imp.getByLabel(/^Title/).fill("Tuyên ngôn Độc lập (trích)");
  await imp.getByLabel(/^Language/).fill("vi");
  await imp.getByLabel(/^Citation/).fill("Hồ Chí Minh, Toàn tập, tập 4, NXB Chính trị quốc gia, 2011, tr. 1");
  await imp.getByLabel(/^Imported by/).fill("Trần Thị B");
  await imp.getByLabel(/^Text/).fill(doc);
  await settled(imp);
  await axe(page);
  await imp.getByRole("button", { name: /^Import document/ }).click();
  await expect(imp).toBeHidden();

  // Link a passage from the reader, after the dry run located it.
  await page.getByRole("button", { name: /Read Tuyên ngôn Độc lập \(trích\)/ }).click();
  const reader = page.getByRole("dialog", { name: "Tuyên ngôn Độc lập (trích)" });
  await expect(reader).toContainText("Imported document — not retrieved by the engine");
  await reader.getByRole("button", { name: /Link a passage to a claim/ }).click();
  const link = page.getByRole("dialog", { name: "Link to claim" });
  const claimSelect = link.getByLabel(/^Claim/);
  const claimId = await claimSelect.locator("option").nth(1).getAttribute("value");
  await claimSelect.selectOption(claimId!);
  await link.getByLabel(/Passage/).fill("Quảng trường Ba Đình");
  await link.getByLabel(/^Role/).selectOption("supports");
  await link.getByLabel(/Explanation/).fill("Văn bản nêu địa điểm của sự kiện.");
  await link.getByRole("button", { name: /Find the passage/ }).click();
  await expect(link).toContainText("found once");
  await settled(link);
  await axe(page);
  await link.getByRole("button", { name: /Link evidence/ }).click();
  await expect(link).toBeHidden();
  await page.keyboard.press("Escape");

  // A decision: no status is preselected.
  await page.getByRole("tab", { name: "Claims" }).click();
  const card = page.locator(`#claim-${claimId}`);
  await card.getByRole("button", { name: /Review this claim/ }).click();
  await expect(card.getByRole("region", { name: "Supports evidence" })).toContainText("Imported document — not retrieved by the engine");
  const decision = card.getByRole("region", { name: `Decision for ${claimId}` });
  await decision.getByRole("button", { name: /Record a decision/ }).click();
  await expect(decision.getByRole("radio", { checked: true })).toHaveCount(0);
  await decision.getByRole("radio", { name: /^Insufficient/ }).check();
  await decision.getByLabel(/^Reviewer/).fill("Trần Thị B");
  await decision.getByLabel(/^Rationale/).fill("Chỉ có một nguồn được nhập, chưa đủ để xác minh câu này.");
  await settled(decision); // the save button's enabling transition
  await axe(page);
  await decision.getByRole("button", { name: "Save decision" }).click();
  // Wait for the engine to record it: the form closes and the claim shows the decision.
  await expect(decision.getByRole("button", { name: "Save decision" })).toBeHidden({ timeout: 30_000 });
  await expect(decision.getByText("Rationale:")).toBeVisible();

  // Changing the claim makes the decision outdated; Confirm again records it anew.
  await card.getByRole("button", { name: "Edit claim" }).click();
  await card.getByRole("checkbox", { name: "Named subject" }).check();
  await card.getByRole("button", { name: "Save claim" }).click();
  await expect(card.getByRole("button", { name: "Save claim" })).toBeHidden({ timeout: 30_000 });
  await expect(card.getByText("Needs a new decision").first()).toBeVisible();
  await decision.getByRole("button", { name: /Confirm again/ }).click();
  await expect(decision.getByRole("radio", { name: /^Insufficient/ })).toBeChecked();
  await decision.getByRole("button", { name: "Save decision" }).click();
  await expect(decision.getByRole("button", { name: "Save decision" })).toBeHidden({ timeout: 30_000 });
  await expect(card.getByText("Needs a new decision")).toHaveCount(0);
  await decision.getByText("Decision history").click();
  await expect(decision.getByText(/#\d+ Replaced/).first()).toBeVisible();

  // Completeness.
  await page.getByRole("tab", { name: /^Validation/ }).click();
  const comp = page.getByRole("region", { name: "Completeness" });
  await comp.getByRole("button", { name: /Attest completeness/ }).click();
  await comp.getByLabel(/^Reviewer/).fill("Trần Thị B");
  await comp.getByLabel(/^Statement/).fill("Mọi câu có nội dung sự kiện đều đã có claim tương ứng.");
  await comp.getByRole("button", { name: "Attest" }).click();
  await expect(comp).toContainText("Attested by Trần Thị B", { timeout: 30_000 });
  await settled(comp);
  const toasts = page.getByRole("region", { name: /Notifications/ });
  await toasts.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((x) => x.finished)));
  await axe(page);

  // The draft page lists the narration that is still fixture text.
  await page.goto("/projects/hcm-demo/draft");
  await openTab(page, "Validation");
  const fixture = page.getByRole("region", { name: "Fixture text" });
  await expect(fixture).toContainText("fixture_narration");
  await expect(fixture.getByText("Fixture text").first()).toBeVisible();
  await axe(page);
});

// The G2 journey shared with the backend's real-engine test: human-written narration whose
// every claim is supported by a public-domain document (backend/tests/fixtures/research).
const RESEARCH_FIXTURES = join(__dirname, "../../backend/tests/fixtures/research");
type Journey = {
  project: { slug: string; idea: string; language: string; duration_seconds: number };
  narration: Record<string, string>;
  reviewer: string;
  approver: string;
  attestation: string;
  documents: Record<"vi" | "en", Record<string, string>>;
  evidence: { claim_prefix: string; quote: string; explanation: string }[];
  quotation: Record<string, string> & { claim_prefixes: string[] };
  rationale: string;
  completeness: string;
};
const G2: Journey = JSON.parse(readFileSync(join(RESEARCH_FIXTURES, "g2-journey.json"), "utf-8"));

/** The API as the page calls it (same origin, CSRF token), for preparing state quickly. */
async function backend(page: Page) {
  await page.goto("/");
  const token = (await (await page.request.get("/api/v1/session")).json()).csrf_token as string;
  const origin = new URL(page.url()).origin;
  const call = async (method: "GET" | "POST", path: string, data?: unknown) => {
    const r = await page.request.fetch(`/api/v1${path}`, {
      method,
      data,
      headers: method === "POST" ? { "X-CSRF-Token": token, Origin: origin } : {},
    });
    expect(r.ok(), `${method} ${path}: ${await r.text()}`).toBe(true);
    return r.json();
  };
  const job = async (path: string, data: unknown) => {
    const { job_id } = await call("POST", path, data);
    await expect.poll(async () => (await call("GET", `/jobs/${job_id}`)).status, { timeout: 90_000 }).toBe("succeeded");
  };
  return { get: (path: string) => call("GET", path), post: (path: string, data: unknown) => call("POST", path, data), job };
}

test("G2: validate, approve the validated revision, apply, approve G1 again, export", async ({ page }) => {
  test.setTimeout(240_000);
  const api = await backend(page);
  const p = `/projects/${G2.project.slug}`;
  const rev = async () => (await api.get(`${p}/research`)).revision as string;
  const g1 = async () => {
    const { review_token } = await api.get(`${p}/draft`);
    await api.post(`${p}/draft/approve`, { reviewer: G2.approver, confirm: true, review_token });
  };

  // Prepared through the API (the UI-B journeys cover these screens): a rewritten, attested
  // narration, G1, the claim inventory, both documents, evidence, decisions, completeness.
  await api.post("/projects", G2.project);
  await api.job(`${p}/draft-jobs`, { provider: "fixture" });
  const editable = await api.get(`${p}/draft/editable`);
  await api.post(`${p}/draft/edit`, {
    expected_revision: editable.editing.revision,
    script: { sections: Object.entries(G2.narration).map(([outline_section_id, narration]) => ({ outline_section_id, narration })) },
  });
  const nar = await api.get(`${p}/draft/narration`);
  await api.post(`${p}/draft/narration/attest`, {
    expected_revision: nar.revision,
    reviewer: G2.reviewer,
    statement: G2.attestation,
    segment_ids: nar.lineage.segments.map((x: { segment_id: string }) => x.segment_id),
  });
  await g1();
  await api.job(`${p}/research/plan`, { expected_revision: await rev() });
  const snap: Record<string, string> = {};
  for (const [k, d] of Object.entries(G2.documents)) {
    const meta = Object.fromEntries(Object.entries(d).filter(([f]) => f !== "file" && f !== "primary_statement"));
    const text = readFileSync(join(RESEARCH_FIXTURES, d.file), "utf-8");
    const out = await api.post(`${p}/research/documents`, { expected_revision: await rev(), imported_by: G2.reviewer, text, ...meta });
    snap[k] = out.result.snapshot_id;
  }
  const claims: { id: string; assertion: string }[] = (await api.get(`${p}/research`)).report.claims;
  const ids = (prefix: string) => claims.filter((c) => c.assertion.startsWith(prefix)).map((c) => c.id);
  const q = G2.quotation;
  const ops: Record<string, unknown>[] = G2.evidence.flatMap((e) =>
    ids(e.claim_prefix).map((claim_id) => ({
      op: "evidence.add", claim_id, snapshot_id: snap.vi, quote: e.quote, role: "supports", explanation: e.explanation, source_type: "primary",
    })),
  );
  for (const claim_id of q.claim_prefixes.flatMap(ids)) {
    ops.push(
      { op: "evidence.add", claim_id, snapshot_id: snap.en, quote: q.original, role: "supports", source_type: "primary", explanation: q.original_explanation },
      {
        op: "evidence.add", claim_id, snapshot_id: snap.vi, quote: q.translated, role: "supports", source_type: "primary", is_translation: true,
        original_language: "en", explanation: q.translated_explanation,
        translation_of: { snapshot_id: snap.en, quote: q.original_quote, language: "en", speaker: q.speaker, equivalence_note: q.equivalence_note },
      },
    );
  }
  for (const [k, d] of Object.entries(G2.documents)) {
    ops.push({ op: "documents.attest_primary", snapshot_id: snap[k], reviewer: G2.reviewer, statement: d.primary_statement });
  }
  await api.post(`${p}/research/edit`, { expected_revision: await rev(), operations: ops });
  await api.post(`${p}/research/edit`, {
    expected_revision: await rev(),
    operations: [
      ...claims.map((c) => ({ op: "reviews.set", claim_id: c.id, status: "verified", reviewer: G2.reviewer, rationale: G2.rationale })),
      { op: "completeness.set", reviewer: G2.reviewer, statement: G2.completeness },
    ],
  });

  // In the browser: validate, then approve exactly what was validated.
  await page.goto(`${p}/research`);
  await page.getByRole("tab", { name: /^Validation/ }).click();
  const g2 = page.getByRole("region", { name: /Research approval \(G2\)/ });
  await expect(g2).toContainText("G2 not approved");
  const approve = g2.getByRole("button", { name: /Approve research \(G2\)/ });
  await expect(approve).toBeDisabled();
  await g2.getByRole("button", { name: "Validate research" }).click();
  await expect(g2).toContainText("the engine reports the research is approvable", { timeout: 30_000 });
  await axe(page);
  await approve.click();
  const dialog = page.getByRole("dialog", { name: "Approve the research (G2)?" });
  await expect(dialog).toContainText("not permission to publish");
  await dialog.getByLabel(/^Reviewer/).fill(G2.approver);
  await dialog.getByLabel(/I reviewed every claim/).check();
  await settled(dialog);
  await axe(page);
  await dialog.getByRole("button", { name: "Approve research" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(g2).toContainText("Claim IDs not applied yet");
  await expect(g2).toContainText("Approved, claim IDs not applied yet");

  // Apply warns about G1 first, then leads to the G1 re-approval.
  await g2.getByRole("button", { name: /Apply claim IDs to scenes/ }).click();
  const applyDialog = page.getByRole("dialog", { name: "Apply claim IDs to the scenes?" });
  await expect(applyDialog).toContainText("(G1) then goes out of date");
  await settled(applyDialog);
  await axe(page);
  await applyDialog.getByRole("button", { name: "Apply claim IDs" }).click();
  await expect(applyDialog).toBeHidden({ timeout: 30_000 });
  await expect(g2).toContainText("Out of date after apply: approve the draft again");
  await g2.getByRole("link", { name: "Approve the draft again" }).click();
  await openTab(page, "Validation");
  const g1Panel = page.getByRole("region", { name: "Editorial approval (G1)" });
  await g1Panel.getByLabel(/Reviewer name/).fill(G2.approver);
  await g1Panel.getByRole("button", { name: "Approve Editorial Draft (G1)" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve draft" }).click();
  await expect(g1Panel.getByText("G1 approved")).toBeVisible({ timeout: 30_000 });

  // Export after apply: the engine's written files, as relative paths.
  await page.goto(`${p}/research`);
  await page.getByRole("tab", { name: /^Validation/ }).click();
  await expect(g2.getByText("G1 is out of date after apply")).toHaveCount(0);
  await g2.getByRole("button", { name: "Export research records" }).click();
  await expect(g2.getByText("output/sources.md")).toBeVisible({ timeout: 30_000 });
  const toasts = page.getByRole("region", { name: /Notifications/ });
  await toasts.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((x) => x.finished)));
  await axe(page);
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
