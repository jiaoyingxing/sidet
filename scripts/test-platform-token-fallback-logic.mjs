import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(path.join(rootDir, "styles.css"), "utf8");
const mainSource = readFileSync(path.join(rootDir, "src", "main.ts"), "utf8");

function extractFallbackBlock(source) {
  const marker = "@supports not (background: color-mix(in oklch, red 50%, transparent))";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, "the legacy WebView color-mix fallback block must stay in styles.css");
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  assert.fail("the legacy WebView fallback block must close");
}

const fallback = extractFallbackBlock(css);

assert.match(
  fallback,
  /body\.is-mobile\.theme-light\s*\{[^}]*--interactive-normal:\s*var\(--background-modifier-hover\)/s,
  "the engine-capability fallback must stay on body.is-mobile light: any mobile WebView without color-mix(in oklch) needs it"
);
assert.match(
  fallback,
  /body\.is-mobile\.theme-dark\s*\{[^}]*--interactive-normal:\s*var\(--background-modifier-hover\)/s,
  "the engine-capability fallback must stay on body.is-mobile dark"
);
assert.match(
  fallback,
  /body\.is-mobile button\.mod-destructive:not\(\.mod-cta\)\s*\{/,
  "the destructive fallback is engine-wide and must not be reduced to one platform"
);
assert.doesNotMatch(
  fallback,
  /body\.(?:sidet-android|sidet-ios)(?:\.theme-(?:light|dark))?\s*\{/,
  "the @supports fallback must not be scoped by platform: a platform without color-mix still needs the engine fallback"
);

for (const [platform, className] of [
  ["Android", "sidet-android"],
  ["iOS", "sidet-ios"]
]) {
  assert.match(
    css,
    new RegExp(
      `body\\.${className}:not\\(\\.theme-dark\\) \\.sidet-chat-view\\s*\\{\\s*--interactive-normal:\\s*var\\(--background-modifier-hover\\);`
    ),
    `${platform} light must restore --interactive-normal from the host modal token inside the chat view`
  );
  assert.match(
    mainSource,
    new RegExp(`const ${className.toUpperCase().replace(/-/g, "_")}_CLASS = "${className}";`),
    `main.ts must own the ${platform} platform class name`
  );
  assert.match(
    mainSource,
    new RegExp(
      `if \\(Platform\\.is${platform === "iOS" ? "IosApp" : "AndroidApp"} && typeof document !== "undefined"\\) \\{\\s*document\\.body\\.classList\\.add\\(${className.toUpperCase().replace(/-/g, "_")}_CLASS\\);`
    ),
    `main.ts must attach the ${platform} platform class only through its Platform flag`
  );
  assert.match(
    mainSource,
    new RegExp(`document\\.body\\.classList\\.remove\\(${className.toUpperCase().replace(/-/g, "_")}_CLASS\\);`),
    `main.ts must remove the ${platform} platform class on unload`
  );
}

assert.doesNotMatch(
  css,
  /body\.(?:sidet-android|sidet-ios)[^{}]*,\s*body\.(?:sidet-android|sidet-ios)/,
  "the Android and iOS token rules must stay separate: old Android WebView (Chromium < 88) drops any rule merged with :is()"
);

console.log("platform token rules ok");
