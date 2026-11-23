import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";
import { DOMParser, parseHTML } from "linkedom";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-external-io-"));
  tempDirs.push(tempDir);
  const outfile = path.join(tempDir, `${path.basename(relativePath, ".ts")}.mjs`);

  await build({
    entryPoints: [path.join(rootDir, relativePath)],
    bundle: true,
    format: "esm",
    platform: "node",
    alias: {
      obsidian: path.join(rootDir, "scripts", "test-stubs", "obsidian.ts")
    },
    outfile,
    logLevel: "silent"
  });

  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

async function assertProviderErrorBodyIsNotLogged(providerModule) {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const logged = [];
  let responseBodyRead = false;

  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => {
      responseBodyRead = true;
      return "PRIVATE_NOTE_SENTINEL";
    }
  });
  console.error = (...args) => {
    logged.push(args);
  };

  try {
    const provider = new providerModule.SiliconFlowProvider();
    await assert.rejects(
      async () => {
        for await (const _event of provider.streamReply({
          modelProviderId: "siliconflow",
          baseUrl: "https://example.invalid/v1",
          apiKey: "secret",
          model: "test-model",
          messages: [{ role: "user", text: "private request" }]
        })) {
          // No stream events are expected for an HTTP failure.
        }
      },
      /模型服务请求失败（401）/
    );
    assert.equal(responseBodyRead, false, "Provider failures must not consume an arbitrary response body for logging.");
    assert.doesNotMatch(
      JSON.stringify(logged),
      /PRIVATE_NOTE_SENTINEL/,
      "Provider logs must not contain arbitrary upstream response bodies."
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
}

async function assertWebpageRequestBoundaries(webpageModule) {
  const timeoutService = new webpageModule.WebpageContextService({
    request: async () => new Promise(() => undefined),
    requestTimeoutMs: 5
  });
  await assert.rejects(
    timeoutService.buildWebpageAttachment("https://example.com/timeout"),
    /网页请求超时/
  );

  const oversizedService = new webpageModule.WebpageContextService({
    request: async () => ({ text: "x".repeat(1_000_001) })
  });
  await assert.rejects(
    oversizedService.buildWebpageAttachment("https://example.com/oversized"),
    /网页响应过大/
  );
}

async function assertWebpageContentAndCacheBoundaries(webpageModule) {
  const longBody = [
    "<html><head><title>Long page</title></head><body><article>",
    `<p>${"A".repeat(18_000)}</p>`,
    `<p>${"B".repeat(18_000)}</p>`,
    "</article></body></html>"
  ].join("");
  const service = new webpageModule.WebpageContextService({
    request: async () => ({ text: longBody })
  });

  const attachment = await service.buildWebpageAttachment("https://example.com/long");
  assert.equal(attachment.truncated, true, "Long extracted webpage content should report truncation.");
  assert.match(attachment.content, /网页正文过长，已截断/);
  assert.ok(attachment.content.length < 30_000, "A single webpage attachment should stay within its content budget.");

  for (let index = 0; index < 25; index += 1) {
    await service.buildWebpageAttachment(`https://example.com/cache/${index}`);
  }
  assert.ok(
    service.attachmentCache.size <= 24,
    "The webpage attachment cache should evict old unique URLs."
  );
}

async function main() {
  const originalWindow = globalThis.window;
  const originalDOMParser = globalThis.DOMParser;
  const originalDocument = globalThis.document;
  const originalHTMLElement = globalThis.HTMLElement;
  const { window: domWindow } = parseHTML("<html></html>");
  globalThis.DOMParser = DOMParser;
  globalThis.document = domWindow.document;
  globalThis.HTMLElement = domWindow.HTMLElement;
  globalThis.window = globalThis;

  try {
    const providerModule = await loadBundledModule("src/provider/siliconflow-provider.ts");
    const webpageModule = await loadBundledModule("src/context/webpage-context.ts");
    await assertProviderErrorBodyIsNotLogged(providerModule);
    await assertWebpageRequestBoundaries(webpageModule);
    await assertWebpageContentAndCacheBoundaries(webpageModule);
    console.log("external I/O boundaries logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    globalThis.window = originalWindow;
    globalThis.DOMParser = originalDOMParser;
    globalThis.document = originalDocument;
    globalThis.HTMLElement = originalHTMLElement;
  }
}

await main();
