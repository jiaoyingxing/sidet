import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-mobile-input-probe-"));

async function loadProbeModule() {
  const outfile = path.join(tempDir, "mobile-input-probe.mjs");
  await build({
    entryPoints: [path.join(rootDir, "src", "workspace", "chat-view-mobile-input-probe.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent"
  });
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

function installWindowStub() {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {}
  });
  return () => {
    if (original) {
      Object.defineProperty(globalThis, "window", original);
      return;
    }
    delete globalThis.window;
  };
}

async function main() {
  const restoreWindow = installWindowStub();
  try {
    const probe = await loadProbeModule();
    assert.equal(typeof probe.serializeMobileInputProbe, "function");

    probe.recordMobileInputProbeEvent("pre-reset", { keyboardHeight: 374 }, 900);
    const beforeSession = JSON.parse(
      probe.serializeMobileInputProbe({ final: null, scrollTrace: [] })
    );
    assert.equal(
      beforeSession.eventCount,
      0,
      "keyboard events outside a probe session must not be cached"
    );

    probe.resetMobileInputProbe(1000);
    probe.recordMobileInputProbeEvent("keyboardWillShow", { keyboardHeight: 374 }, 1087);
    for (let index = 0; index < 190; index += 1) {
      probe.recordMobileInputProbeSample("sample", { index }, 1000 + index * 10);
    }
    for (let index = 0; index < 60; index += 1) {
      probe.recordMobileInputProbeEvent("event", { index }, 1000 + index * 5);
    }

    const report = JSON.parse(
      probe.serializeMobileInputProbe({
        final: { ok: true },
        scrollTrace: [{ event: "trace" }]
      })
    );

    assert.equal(report.build, probe.MOBILE_INPUT_PROBE_BUILD);
    assert.equal(report.startedAt, 1000);
    assert.equal(report.sampleCount, 180, "the probe must cap retained samples");
    assert.equal(report.samples.length, 180);
    assert.equal(report.samples[0].index, 10, "the oldest samples are dropped first");
    assert.equal(report.samples[179].index, 189);
    assert.equal(report.samples[0].label, "sample");
    assert.equal(report.eventCount, 48, "the probe must cap retained keyboard events");
    assert.equal(report.events.length, 48);
    assert.equal(report.events[0].index, 12, "the oldest events are dropped first");
    assert.equal(report.events[47].index, 59);
    assert.equal(report.events[0].event, "event");
    assert.equal(report.events[0].t, 60);
    assert.deepEqual(report.final, { ok: true });
    assert.deepEqual(report.scrollTrace, [{ event: "trace" }]);

    // 未启用探针时不得缓存键盘事件。
    probe.resetMobileInputProbe(2000);
    probe.recordMobileInputProbeEvent("unused");
    const emptyReport = JSON.parse(
      probe.serializeMobileInputProbe({ final: null, scrollTrace: [] })
    );
    assert.equal(emptyReport.eventCount, 1, "reset must clear prior events");

    console.log("mobile input probe logic test passed");
  } finally {
    restoreWindow();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
