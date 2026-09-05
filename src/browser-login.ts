import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium } from "patchright";
import { installTurnstileAutoSolver } from "patchright-difz";
import type { BrowserContextOptions, Page } from "patchright-core";
import { runCommand } from "./process";
import type { AppConfig } from "./config";
import { atomicWriteFile } from "./config";
import {
  assertAuthenticatedChatGptPage,
  assertTemporaryChatPage,
  CHATGPT_TEMPORARY_CHAT_URL,
  detectChatGptAccountCapabilities,
} from "./chatgpt-session";
import type { ChatGptWebAccountCapabilities } from "./chatgpt-web-models";

export interface BrowserLoginResult {
  storageStatePath: string;
  accountSurfaceUrl: string;
  solAvailable: boolean;
  proAvailable: boolean;
}

interface LoginVerificationMarker {
  version: 1;
  authenticated: true;
  verifiedAt: string;
  solAvailable?: boolean;
  proAvailable?: boolean;
}

export function loginVerificationMarkerPath(storageStatePath: string): string {
  return `${storageStatePath}.verified.json`;
}

function writeVerificationMarker(
  storageStatePath: string,
  capabilities: ChatGptWebAccountCapabilities,
): void {
  const marker: LoginVerificationMarker = {
    version: 1,
    authenticated: true,
    verifiedAt: new Date().toISOString(),
    ...capabilities,
  };
  atomicWriteFile(loginVerificationMarkerPath(storageStatePath), `${JSON.stringify(marker)}\n`);
}

async function inspectStoredState(
  config: AppConfig,
  storageState: NonNullable<BrowserContextOptions["storageState"]>,
  headless = false,
): Promise<ChatGptWebAccountCapabilities & { url: string }> {
  const verifierBrowser = await chromium.launch({
    executablePath: config.chromeExecutablePath,
    headless,
    ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const verifierContext = await verifierBrowser.newContext({ storageState });
    try {
      const verifierPage = await verifierContext.newPage();
      await verifierPage.goto(CHATGPT_TEMPORARY_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await verifierPage.getByRole("textbox", { name: "Chat with ChatGPT" }).waitFor({ state: "visible", timeout: 60_000 });
      await assertAuthenticatedChatGptPage(verifierPage);
      await assertTemporaryChatPage(verifierPage);
      return { ...await detectChatGptAccountCapabilities(verifierPage), url: verifierPage.url() };
    } finally {
      await verifierContext.close();
    }
  } finally {
    await verifierBrowser.close();
  }
}

export async function inspectBrowserLoginCapabilities(config: AppConfig): Promise<ChatGptWebAccountCapabilities> {
  if (!browserLoginStateExists(config)) throw new Error("ChatGPT login state is missing or unverified");
  const inspected = await inspectStoredState(config, config.storageStatePath);
  writeVerificationMarker(config.storageStatePath, inspected);
  return { solAvailable: inspected.solAvailable, proAvailable: inspected.proAvailable };
}

export function storedBrowserLoginCapabilities(
  config: AppConfig,
): Partial<ChatGptWebAccountCapabilities> {
  if (!browserLoginStateExists(config)) return {};
  try {
    const marker = JSON.parse(readFileSync(loginVerificationMarkerPath(config.storageStatePath), "utf8")) as Partial<LoginVerificationMarker>;
    return {
      ...(typeof marker.solAvailable === "boolean" ? { solAvailable: marker.solAvailable } : {}),
      ...(typeof marker.proAvailable === "boolean" ? { proAvailable: marker.proAvailable } : {}),
    };
  } catch {
    return {};
  }
}

export function parseProxyUrl(raw: string): { server: string; username?: string; password?: string } {
  const url = new URL(raw);
  const server = `${url.protocol.replace(":", "")}://${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
  return {
    server,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}

export type LoginHeadlessMode = "auto" | "force" | "off";

export interface LoginToChatGptOptions {
  timeoutMs?: number;
  loginHeadless?: LoginHeadlessMode;
  storageStateFile?: string;
  email?: string;
  password?: string;
  mfaCodePrompt?: () => Promise<string>;
  sessionCookie?: string;
  proxy?: { server: string; username?: string; password?: string };
}

const AUTH_LOGIN_URL = "https://auth.openai.com/log-in";

async function attemptCredentialLogin(
  config: AppConfig,
  profileDir: string,
  email: string,
  password: string,
  headless: boolean,
  timeoutMs: number,
  mfaCodePrompt?: () => Promise<string>,
  proxy?: { server: string; username?: string; password?: string },
): Promise<BrowserLoginResult> {
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: config.chromeExecutablePath,
    headless,
    ignoreDefaultArgs: CHROME_IGNORE_DEFAULT_ARGS,
    args: CHROME_LAUNCH_ARGS,
    ...(proxy ? { proxy } : {}),
  });
  const uninstallTurnstileSolver = installTurnstileAutoSolver(context);
  let page: Page | undefined;
  try {
    page = context.pages()[0] ?? await context.newPage();
    // Session probe: valid stored session lands straight on composer — no auth needed.
    try {
      await page.goto(CHATGPT_TEMPORARY_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await composerLocator(page).waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
      if (await composerLocator(page).isVisible().catch(() => false)) {
        return await finalizeLogin(config, context, page, headless);
      }
    } catch (probeError) {
      if (!/ERR_ABORTED/.test(String(probeError))) console.error(`[login] session probe failed, continuing to auth form: ${String(probeError).slice(0, 120)}`);
    }
    try {
      await page.goto(AUTH_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    } catch (gotoError) {
      // Logged-in profile redirects mid-goto (ERR_ABORTED) straight to chatgpt.com — expected.
      if (!/ERR_ABORTED/.test(String(gotoError))) throw gotoError;
    }
    // Turnstile interstitial: click the widget container so managed/checkbox mode resolves.
    const alreadyOnChatgpt = /chatgpt\.com/.test(page.url());
    if (!alreadyOnChatgpt) for (let turnstileAttempt = 0; turnstileAttempt < 8; turnstileAttempt += 1) {
      const emailReady = await page.locator('input[name="email"], input#email-input, input[type="email"]').first()
        .isVisible({ timeout: 5_000 }).catch(() => false);
      if (emailReady) break;
      const widget = page.locator('[class*="cf-turnstile"], [data-sitekey], iframe[title*="Cloudflare" i]').first();
      if (await widget.isVisible().catch(() => false)) {
        await widget.click({ timeout: 5_000 }).catch(() => {});
      }
      await page.waitForTimeout(5_000);
    }
    const emailInput = page.locator('input[name="email"], input#email-input, input[type="email"]').first();
    const emailFormVisible = await emailInput.isVisible().catch(() => false);
    if (emailFormVisible) {
    await emailInput.waitFor({ state: "visible", timeout: 60_000 });
    await emailInput.fill(email);
    await page.getByRole("button", { name: /continue/i }).first().click();
    const passwordInput = page.locator('input[type="password"]').first();
    await passwordInput.waitFor({ state: "visible", timeout: 30_000 });
    await passwordInput.fill(password);
    await page.getByRole("button", { name: /continue|log in/i }).first().click();
    // ChatGPT may require an e-mail OTP after the password. Surface an interactive
    // prompt (CLI) so the flow stays terminal-driven; skip when no prompt is wired.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const otpInput = page.locator('input[autocomplete="one-time-code"], input[inputmode="numeric"][name*="code" i], input[aria-label*="code" i]').first();
      const otpVisible = await otpInput.isVisible().catch(() => false);
      if (!otpVisible || !mfaCodePrompt) break;
      const code = (await mfaCodePrompt()).trim();
      if (!code) throw new Error("ChatGPT requested an e-mail verification code but no code was provided");
      await otpInput.fill(code);
      const continueButton = page.getByRole("button", { name: /continue|verify/i }).first();
      if (await continueButton.isVisible().catch(() => false)) await continueButton.click();
      await page.waitForTimeout(1_500);
    }
    if (emailFormVisible) {
      await page.waitForURL(/chatgpt\.com/, { timeout: 120_000 });
    }
    await page.goto(CHATGPT_TEMPORARY_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
    const composer = composerLocator(page);
    try {
      await composer.waitFor({ state: "visible", timeout: timeoutMs });
    } catch {
      const diag = JSON.stringify({
        u: page.url().slice(0, 140),
        t: (await page.title().catch(() => "?")).slice(0, 60),
      }).replace(/"/g, "'");
      if (await headlessLoginBlocked(page)) {
        const d = await page.evaluate(() => ({
          u: location.href.slice(0, 140),
          t: document.title.slice(0, 80),
          cf: document.querySelectorAll("iframe[src*='challenges.cloudflare.com']").length,
          n: document.body.innerText.length,
        })).catch(() => "diagfail");
        throw new Error(`CREDENTIAL_LOGIN_BLOCKED: ${JSON.stringify(d)}`);
      }
      throw new Error(`Credential login composer fail | ${diag}`);
    }
    }
    return await finalizeLogin(config, context, page, headless);
  } catch (error) {
    if (page && headless && await headlessLoginBlocked(page).catch(() => false)) {
      const d = await page.evaluate(() => ({
        u: location.href.slice(0, 140),
        t: document.title.slice(0, 80),
        cf: document.querySelectorAll("iframe[src*='challenges.cloudflare.com']").length,
        n: document.body.innerText.length,
      })).catch(() => "diagfail");
      throw new Error(`CREDENTIAL_LOGIN_BLOCKED: ${JSON.stringify(d)}`);
    }
    throw error;
  } finally {
    uninstallTurnstileSolver?.();
    await context.close();
  }
}

const CHROME_LAUNCH_ARGS = ["--no-first-run", "--no-default-browser-check"];
const CHROME_IGNORE_DEFAULT_ARGS = ["--password-store=basic", "--use-mock-keychain"];

function composerLocator(page: Page) {
  return page.getByRole("textbox", { name: "Chat with ChatGPT" }).or(
    page.locator('[data-testid="prompt-textarea"], [contenteditable="true"][data-lexical-editor="true"]'),
  ).first();
}

async function headlessLoginBlocked(page: Page): Promise<boolean> {
  // Only an interactive Turnstile widget counts; chatgpt.com always ships the
  // challenge-platform script tag, so text matching false-positives.
  const turnstile = page.locator('iframe[title*="Cloudflare" i], iframe[src*="challenges.cloudflare.com"]').first();
  return await turnstile.isVisible().catch(() => false);
}

async function withEphemeralXvfb<T>(fn: (display: string) => Promise<T>): Promise<T> {
  const probe = runCommand("which", ["Xvfb"]);
  if (probe.status !== 0) {
    throw new Error(
      "Headless ChatGPT login was blocked and Xvfb is not installed. "
      + "Install xvfb, import a storage state via --storage-state-file, or log in on a machine with a display.",
    );
  }
  const { readdirSync } = await import("node:fs");
  const existing = new Set(readdirSync("/tmp/.X11-unix").map(name => name.replace(/^X/, "")));
  let display: string | undefined;
  for (let candidate = 99; candidate < 200; candidate += 1) {
    if (!existing.has(String(candidate))) { display = `:${candidate}`; break; }
  }
  if (!display) throw new Error("No free display number found for ephemeral Xvfb");
  const xvfb = spawn("Xvfb", [display, "-screen", "0", "1280x800x24", "-nolisten", "tcp"], { stdio: "ignore" });
  await new Promise(resolveWait => setTimeout(resolveWait, 800));
  if (xvfb.exitCode !== null && xvfb.exitCode !== 0) throw new Error(`Xvfb exited with status ${xvfb.exitCode}`);
  try {
    return await fn(display);
  } finally {
    xvfb.kill("SIGTERM");
    setTimeout(() => xvfb.kill("SIGKILL"), 2_000).unref?.();
  }
}

async function finalizeLogin(
  config: AppConfig,
  context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  page: Page,
  headless: boolean,
): Promise<BrowserLoginResult> {
  await assertAuthenticatedChatGptPage(page);
  await assertTemporaryChatPage(page);
  const state = await context.storageState();
  const inspected = await inspectStoredState(config, state, headless);
  atomicWriteFile(config.storageStatePath, `${JSON.stringify(state)}\n`);
  writeVerificationMarker(config.storageStatePath, inspected);
  return {
    storageStatePath: config.storageStatePath,
    accountSurfaceUrl: page.url(),
    solAvailable: inspected.solAvailable,
    proAvailable: inspected.proAvailable,
  };
}

export function parseSessionCookieInput(raw: string): NonNullable<BrowserContextOptions["storageState"]> {
  const input = raw.trim();
  if (input.startsWith("{")) {
    const state = JSON.parse(input) as { cookies?: unknown };
    if (!Array.isArray(state.cookies) || state.cookies.length === 0) {
      throw new Error("Storage state JSON must contain a non-empty cookies array");
    }
    return state as NonNullable<BrowserContextOptions["storageState"]>;
  }
  const now = Math.floor(Date.now() / 1000);
  const pairs = input.includes("=")
    ? input.split(";").map(pair => pair.trim()).filter(Boolean).map(pair => {
        const eq = pair.indexOf("=");
        return { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
      })
    : [{ name: "__Secure-next-auth.session-token", value: input }];
  if (pairs.some(pair => !pair.name || !pair.value)) {
    throw new Error("Could not parse cookie input; paste name=value pairs or a storageState JSON");
  }
  return {
    cookies: pairs.map(pair => ({
      name: pair.name,
      value: pair.value,
      domain: ".chatgpt.com",
      path: "/",
      secure: true,
      httpOnly: pair.name.includes("session-token"),
      sameSite: "Lax",
      expires: now + 60 * 60 * 24 * 30,
    })),
    origins: [],
  };
}

async function importSessionCookieInput(
  config: AppConfig,
  raw: string,
): Promise<BrowserLoginResult> {
  const state = parseSessionCookieInput(raw);
  const inspected = await inspectStoredState(config, state, true);
  atomicWriteFile(config.storageStatePath, `${JSON.stringify(state)}\n`);
  writeVerificationMarker(config.storageStatePath, inspected);
  return {
    storageStatePath: config.storageStatePath,
    accountSurfaceUrl: inspected.url,
    solAvailable: inspected.solAvailable,
    proAvailable: inspected.proAvailable,
  };
}

async function importStorageStateFile(
  config: AppConfig,
  storageStateFile: string,
): Promise<BrowserLoginResult> {
  if (!existsSync(storageStateFile)) throw new Error(`Storage state file not found: ${storageStateFile}`);
  let state: unknown;
  try {
    state = JSON.parse(readFileSync(storageStateFile, "utf8"));
  } catch {
    throw new Error(`Storage state file is not valid JSON: ${storageStateFile}`);
  }
  if (typeof state !== "object" || state === null || !Array.isArray((state as { cookies?: unknown }).cookies)) {
    throw new Error("Storage state file must be a Playwright storageState object with a cookies array");
  }
  const inspected = await inspectStoredState(config, state as NonNullable<BrowserContextOptions["storageState"]>, true);
  atomicWriteFile(config.storageStatePath, `${JSON.stringify(state)}\n`);
  writeVerificationMarker(config.storageStatePath, inspected);
  return {
    storageStatePath: config.storageStatePath,
    accountSurfaceUrl: inspected.url,
    solAvailable: inspected.solAvailable,
    proAvailable: inspected.proAvailable,
  };
}

async function attemptPersistentLogin(
  config: AppConfig,
  profileDir: string,
  headless: boolean,
  timeoutMs: number,
  proxy?: { server: string; username?: string; password?: string },
): Promise<BrowserLoginResult> {
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: config.chromeExecutablePath,
    headless,
    ignoreDefaultArgs: CHROME_IGNORE_DEFAULT_ARGS,
    args: CHROME_LAUNCH_ARGS,
  });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(CHATGPT_TEMPORARY_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    try {
      await composerLocator(page).waitFor({ state: "visible", timeout: timeoutMs });
    } catch {
      if (headless && await headlessLoginBlocked(page)) {
        throw new Error("HEADLESS_BLOCKED: ChatGPT served a bot challenge to the headless browser");
      }
      throw new Error("The authenticated ChatGPT page did not produce a visible composer");
    }
    return await finalizeLogin(config, context, page, headless);
  } finally {
    await context.close();
  }
}

async function headedChromeLoginWindow(config: AppConfig, profileDir: string, display?: string): Promise<void> {
  process.stdout.write(
    "A normal Chrome window is open. Sign in to ChatGPT, confirm that the composer is visible, then quit this dedicated Chrome instance completely.\n",
  );
  const loginBrowser = spawn(config.chromeExecutablePath, [
    `--user-data-dir=${profileDir}`,
    "--new-window",
    "--disable-background-mode",
    ...CHROME_LAUNCH_ARGS,
    CHATGPT_TEMPORARY_CHAT_URL,
  ], { env: display ? { ...process.env, DISPLAY: display } : process.env, stdio: "ignore" });
  const loginExit = await new Promise<number>((resolveExit, rejectExit) => {
    loginBrowser.once("error", rejectExit);
    loginBrowser.once("exit", (code, signal) => {
      if (signal) rejectExit(new Error(`Normal Chrome login window exited from signal ${signal}`));
      else resolveExit(code ?? 1);
    });
  });
  if (loginExit !== 0) throw new Error(`Normal Chrome login window exited with status ${loginExit}`);
}

export async function loginToChatGpt(
  config: AppConfig,
  options: LoginToChatGptOptions = {},
): Promise<BrowserLoginResult> {
  if (!existsSync(config.chromeExecutablePath)) {
    throw new Error(`Google Chrome was not found at ${config.chromeExecutablePath}. Pass --chrome with its executable path.`);
  }
  if (options.sessionCookie) return importSessionCookieInput(config, options.sessionCookie);
  if (options.storageStateFile) return importStorageStateFile(config, options.storageStateFile);
  const profileDir = join(dirname(config.storageStatePath), "login-profile");
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const timeoutMs = options.timeoutMs ?? 60_000;
  const mode: LoginHeadlessMode = options.loginHeadless ?? "auto";
  const credentialLogin = options.email !== undefined || options.password !== undefined;
  if (credentialLogin) {
    if (options.email === undefined || options.password === undefined || !options.email || !options.password) {
      throw new Error("Credential login requires both --email and a password (--password-file or CODEX_CHATGPT_WEB_PASSWORD)");
    }
    const tryCreds = (headless: boolean) => attemptCredentialLogin(config, profileDir, options.email!, options.password!, headless, timeoutMs, options.mfaCodePrompt, options.proxy);
    try {
      return await tryCreds(true);
    } catch (error) {
      const blocked = error instanceof Error && error.message.startsWith("CREDENTIAL_LOGIN_BLOCKED");
      if (!blocked || options.loginHeadless === "force") throw error;
      process.stdout.write("Headless credential login hit a bot challenge; retrying under ephemeral Xvfb.\n");
      return await withEphemeralXvfb(() => tryCreds(false));
    }
  }
  try {
    if (mode !== "off") {
      try {
        return await attemptPersistentLogin(config, profileDir, true, Math.min(timeoutMs, 45_000));
      } catch (error) {
        const blocked = error instanceof Error && error.message.startsWith("HEADLESS_BLOCKED");
        if (mode === "force" || !blocked) throw error;
        process.stdout.write("Headless login was blocked by a bot challenge; retrying under ephemeral Xvfb.\n");
      }
      return await withEphemeralXvfb(async display => {
        await headedChromeLoginWindow(config, profileDir, display);
        return attemptPersistentLogin(config, profileDir, false, timeoutMs);
      });
    }
    await headedChromeLoginWindow(config, profileDir);
    return await attemptPersistentLogin(config, profileDir, false, timeoutMs);
  } finally {
    if (browserLoginStateExists(config)) rmSync(profileDir, { recursive: true, force: true });
  }
}

export function browserLoginStateExists(config: AppConfig): boolean {
  if (!existsSync(config.storageStatePath)) return false;
  const markerPath = loginVerificationMarkerPath(config.storageStatePath);
  if (!existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<LoginVerificationMarker>;
    return marker.version === 1 && marker.authenticated === true && typeof marker.verifiedAt === "string";
  } catch {
    return false;
  }
}

export async function checkBrowserEngine(config: AppConfig): Promise<void> {
  if (!existsSync(config.chromeExecutablePath)) throw new Error(`Google Chrome was not found at ${config.chromeExecutablePath}`);
  const browser = await chromium.launch({
    executablePath: config.chromeExecutablePath,
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    if (await page.evaluate(() => document.readyState) !== "complete") throw new Error("Browser page did not reach complete state");
  } finally {
    await browser.close();
  }
}
