import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config";
import { systemdUnit } from "../src/service";

function fakeConfig(): AppConfig {
  return {
    version: 3,
    releaseVersion: "test",
    mode: "browser-only",
    subagentProtocol: "compatibility-v1",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256000,
    appName: "Codex Native2",
    browserHost: "managed-chrome",
    chromeExecutablePath: "/usr/bin/google-chrome",
    storageStatePath: "/tmp/storage-state.json",
    brokerSocketPath: "",
    controlToken: "token",
    runtimeCommand: ["/usr/bin/bun", "/opt/app/cli.js"],
    headed: false,
    solAvailable: false,
    proAvailable: false,
    autoApproveToolCalls: false,
    experimentalBiggerContext: false,
    acknowledgedUnofficialAt: new Date().toISOString(),
  } as unknown as AppConfig;
}

describe("systemdUnit", () => {
  test("renders headless user unit with durable runtime", () => {
    const unit = systemdUnit(fakeConfig());
    expect(unit).toContain("ExecStart=/usr/bin/bun /opt/app/cli.js serve");
    expect(unit).toContain("CODEX_CHATGPT_WEB_HEADLESS=1");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
  });

  test("quotes runtime args containing spaces", () => {
    const config = fakeConfig();
    config.runtimeCommand = ["/opt/my tools/bun", "/opt/app/cli.js"];
    const unit = systemdUnit(config);
    expect(unit).toContain('ExecStart="/opt/my tools/bun" /opt/app/cli.js serve');
  });
});
