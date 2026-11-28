import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 弹窗结构契约（静态扫描，2026-11-27 按 Resojot modal-contract-smoke 的思路移植）。
 *
 * 只钉「写法回流」这种机械可判的规则；视觉与真机行为仍靠人工验收。
 */
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(rootDir, "src");
const stylePath = path.join(rootDir, "styles.css");
const shellPath = path.join(srcDir, "shared", "modal", "sidet-modal-shell.ts");

function walk(dir) {
  const result = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      result.push(...walk(full));
    } else if (full.endsWith(".ts")) {
      result.push(full);
    }
  }
  return result;
}

const relative = (file) => path.relative(rootDir, file).replace(/\\/g, "/");
const read = (file) => readFileSync(file, "utf8");
/** 结构检查只看代码，不看注释里提到的类名。 */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");

/** 取出每个 `class X extends Modal { ... }` 的类体，避免把同文件的设置页写法算进来。 */
function extractModalClassBodies(text) {
  const bodies = [];
  for (const match of text.matchAll(/class\s+\w+\s+extends\s+Modal\b/g)) {
    const start = text.indexOf("{", match.index);
    if (start < 0) {
      continue;
    }
    let depth = 0;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          bodies.push(text.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return bodies;
}

function main() {
  const sourceFiles = walk(srcDir);
  const contents = new Map(
    sourceFiles.map((file) => [file, stripComments(read(file))])
  );

  // 1. 底栏容器只允许由共享件创建，禁止各弹窗手写 .modal-button-container。
  for (const [file, text] of contents) {
    if (file === shellPath) {
      continue;
    }
    assert.equal(
      text.includes("modal-button-container"),
      false,
      `${relative(file)} 不得手写 .modal-button-container，改用 createSidetModalFooter`
    );
  }

  // 2. 禁止再拿 Setting 行当底栏壳（历史上用 infoEl.remove() 隐藏行名）。
  for (const [file, text] of contents) {
    assert.equal(
      text.includes("infoEl.remove()"),
      false,
      `${relative(file)} 出现 Setting 行当底栏的旧写法`
    );
  }

  // 3. 弹窗内不再使用 SettingGroup（宿主 1.13+ 会铺一层底块）。
  for (const [file, text] of contents) {
    for (const body of extractModalClassBodies(text)) {
      assert.equal(
        body.includes("new SettingGroup"),
        false,
        `${relative(file)} 在弹窗内使用了 SettingGroup`
      );
    }
  }

  // 4. 标题归宿主：Modal 类体不得自绘 h2，必须设 titleEl 或交给共享外壳。
  for (const [file, text] of contents) {
    for (const body of extractModalClassBodies(text)) {
      assert.equal(
        body.includes('createEl("h2"'),
        false,
        `${relative(file)} 在弹窗内容区自绘 h2 标题，改用 titleEl.setText`
      );
      assert.ok(
        body.includes("titleEl.setText") || body.includes("createSidetModalShell"),
        `${relative(file)} 的弹窗没有设置宿主标题`
      );
    }
  }

  // 5. 只碰 modalEl / contentEl；composer 的 overlay 类有独立移动端合同。
  const containerClassExceptions = new Set(["src/workspace/composer-modal.ts"]);
  for (const [file, text] of contents) {
    if (containerClassExceptions.has(relative(file))) {
      continue;
    }
    for (const body of extractModalClassBodies(text)) {
      assert.equal(
        body.includes("this.containerEl.addClass"),
        false,
        `${relative(file)} 给 modal 遮罩层加了类；宿主只允许改 modalEl / contentEl`
      );
    }
  }

  // 6. 有按钮的普通弹窗必须走共享底栏；composer 是编辑器特例。
  const footerExceptions = new Set(["src/workspace/composer-modal.ts"]);
  for (const [file, text] of contents) {
    if (!/extends\s+Modal\b/.test(text)) {
      continue;
    }
    const name = relative(file);
    if (footerExceptions.has(name)) {
      continue;
    }
    const hasButtons = text.includes('createEl("button"') || text.includes("addButton(");
    if (!hasButtons) {
      continue;
    }
    assert.ok(
      text.includes("createSidetModalFooter"),
      `${name} 有按钮但未使用 createSidetModalFooter`
    );
  }

  // 7. 共享件与样式合同存在。
  const css = read(stylePath);
  assert.match(css, /\.sidet-modal-footer\s*\{[^}]*margin-top:\s*16px/, "缺少共享底栏顶距");
  assert.match(css, /\.sidet-modal-error\.is-visible/, "缺少弹框级错误显隐");
  assert.match(css, /\.sidet-field-error\.is-visible/, "缺少字段级错误显隐");
  assert.match(css, /\.sidet-keyboard-inset\s*\{[^}]*position:\s*relative/, "缺少键盘避让锚容器");
  assert.match(
    css,
    /\.sidet-keyboard-inset::after\s*\{[^}]*height:\s*var\(--sidet-keyboard-inset/,
    "缺少键盘避让 ::after 锚"
  );
  assert.match(
    css,
    /\.sidet-model-config-modal-section--form\s*\{[^}]*padding:\s*3px/,
    "长表单滚动区缺少 3px 焦点环内衬"
  );
  assert.match(
    css,
    /\.modal\.sidet-archived-conversations-modal[\s\S]*?width:\s*min\(720px,\s*calc\(100vw - 24px\)\)/,
    "缺少宽版弹窗宽度档"
  );

  // 8. 弹窗根选择器只允许两档宽度：宿主默认（不写）与宽版档（720）。
  //    composer 是编辑器特例；-input / -body 等内部元素不算根选择器。
  const wideTier = new Set([
    "sidet-archived-conversations-modal",
    "sidet-agent-preview-modal",
    "sidet-webpage-preview-modal"
  ]);
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of css.matchAll(rulePattern)) {
    const selectorText = match[1].trim();
    const body = match[2];
    const setsWidth = /(^|;)\s*width\s*:/.test(body);
    if (!setsWidth) {
      continue;
    }
    for (const part of selectorText.split(",")) {
      const classMatch = /\.(sidet-[a-z0-9-]+-modal)(?![\w-])/.exec(part);
      if (!classMatch) {
        continue;
      }
      const className = classMatch[1];
      if (className === "sidet-composer-modal") {
        continue;
      }
      const allowed = wideTier.has(className) && part.includes(".modal.");
      assert.ok(
        allowed,
        `弹窗 ${className} 写了自定义宽度；常规档请交还宿主，宽版档用 .modal 前缀的 720 规则`
      );
    }
  }

  // 9. 手机弹窗「点空白收键盘」必须先判边界：弹窗本体挂了 tabindex="-1"，
  //    先判交互元素会把空白点击当成点在可交互元素上，blur 永远不执行。
  const keyboardDismissPath = path.join(srcDir, "shared", "modal", "mobile-modal-keyboard.ts");
  const keyboardDismissText = contents.get(keyboardDismissPath) ?? "";
  const boundaryIndex = keyboardDismissText.indexOf("element === boundary");
  const interactiveIndex = keyboardDismissText.indexOf("isInteractiveElement(element)");
  assert.ok(
    boundaryIndex >= 0 && interactiveIndex >= 0 && boundaryIndex < interactiveIndex,
    "mobile-modal-keyboard 必须先判 boundary 再判交互元素"
  );

  console.log("modal contract logic: ok");
}

main();
