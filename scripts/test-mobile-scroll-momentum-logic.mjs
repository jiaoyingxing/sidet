import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-mobile-scroll-momentum-"));

async function loadModule() {
  const outfile = path.join(tempDir, "mobile-scroll-momentum.mjs");
  await build({
    entryPoints: [path.join(rootDir, "src", "workspace", "chat-view-mobile-scroll-momentum.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent"
  });
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

function installEnvironment() {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const frameQueue = [];

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      requestAnimationFrame(callback) {
        frameQueue.push(callback);
        return frameQueue.length;
      }
    }
  });

  return {
    runNextFrame() {
      const callback = frameQueue.shift();
      callback?.();
    },
    pendingFrames: () => frameQueue.length,
    restore() {
      if (originalWindow) {
        Object.defineProperty(globalThis, "window", originalWindow);
      } else {
        delete globalThis.window;
      }
    }
  };
}

function createScrollHost(classes = []) {
  const classNames = new Set(classes);
  return {
    classList: {
      contains(name) {
        return classNames.has(name);
      },
      add(name) {
        classNames.add(name);
      },
      remove(name) {
        classNames.delete(name);
      }
    },
    hasClass: (name) => classNames.has(name),
    scrollHeight: 800
  };
}

async function main() {
  const module = await loadModule();
  const haltClass = module.MOBILE_SCROLL_MOMENTUM_HALT_CLASS;
  assert.equal(typeof haltClass, "string");
  assert.ok(haltClass.length > 0, "the halt class name must be exported for CSS and tests");

  const environment = installEnvironment();
  try {
    let layoutReads = 0;
    const scrollHost = createScrollHost();
    Object.defineProperty(scrollHost, "scrollHeight", {
      get() {
        layoutReads += 1;
        return 800;
      }
    });
    let jumpCalls = 0;
    let haltedDuringJump = null;

    module.haltMobileScrollMomentum(scrollHost, () => {
      jumpCalls += 1;
      haltedDuringJump = scrollHost.hasClass(haltClass);
    });

    assert.equal(
      scrollHost.hasClass(haltClass),
      true,
      "the halt class must be applied before the jump is scheduled"
    );
    assert.equal(layoutReads, 1, "the halt must force one synchronous layout read");
    assert.equal(jumpCalls, 0, "the jump must wait for the halted frame to paint");

    environment.runNextFrame();
    assert.equal(
      scrollHost.hasClass(haltClass),
      true,
      "the scroll host must stay non-scrollable through the first painted frame"
    );
    assert.equal(jumpCalls, 0, "the jump must not run inside the halted frame");

    environment.runNextFrame();
    assert.equal(
      scrollHost.hasClass(haltClass),
      false,
      "the halt class must be removed before the jump runs"
    );
    assert.equal(
      haltedDuringJump,
      false,
      "the jump target must be measured against the restored scroll layout"
    );
    assert.equal(jumpCalls, 1);
    assert.equal(environment.pendingFrames(), 0);

    const preHaltedHost = createScrollHost([haltClass]);
    module.haltMobileScrollMomentum(preHaltedHost, () => {});
    environment.runNextFrame();
    environment.runNextFrame();
    assert.equal(
      preHaltedHost.hasClass(haltClass),
      true,
      "a pre-existing halt state must not be cleared by this jump"
    );

    const throwingHost = createScrollHost();
    module.haltMobileScrollMomentum(throwingHost, () => {
      throw new Error("jump failed");
    });
    environment.runNextFrame();
    assert.throws(
      () => {
        environment.runNextFrame();
      },
      /jump failed/
    );
    assert.equal(
      throwingHost.hasClass(haltClass),
      false,
      "a failed jump must still restore the scroll host"
    );
  } finally {
    environment.restore();
  }

  const chatViewSource = readFileSync(
    path.join(rootDir, "src", "workspace", "chat-view.ts"),
    "utf8"
  );
  assert.match(
    chatViewSource,
    /this\.scrollBottomButtonEl\.addEventListener\("click",[\s\S]{0,160}this\.jumpToConversationBottom\(\)/,
    "the scroll-bottom button must go through the momentum-aware jump entry"
  );
  const jumpMethod =
    chatViewSource.match(/private jumpToConversationBottom\(\): void \{[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.match(
    jumpMethod,
    /if \(!this\.isPhoneLayout\(\) \|\| !this\.isMobileRuntime\(\)\)/,
    "desktop and non-phone layouts must keep the plain scroll path"
  );
  assert.match(
    jumpMethod,
    /haltMobileScrollMomentum\(this\.getScrollHost\(\),[\s\S]{0,120}this\.scrollMessagesToBottom\(\{ keepPinned: true \}\)/,
    "phone layouts must halt momentum before jumping to the bottom"
  );

  const css = readFileSync(path.join(rootDir, "styles.css"), "utf8");
  assert.match(
    css,
    /\.sidet-chat-view\.is-phone-layout\.is-mobile-runtime\.is-mobile-scroll-momentum-halted\s*\{[^}]*overflow-y:\s*hidden/,
    "the halt class must switch the mobile scroll host to a non-scrollable state"
  );

  console.log("mobile scroll momentum logic test passed");
}

try {
  await main();
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
