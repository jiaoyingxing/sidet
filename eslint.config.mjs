import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

// 官方商店自动扫描同款规则集（eslint-plugin-obsidianmd recommended，含类型敏感规则）。
// 本地 0 error 是商店扫描 findings 的最强先行证据；发布前必须 `npm run lint`（warning 逐条裁决）。
export default defineConfig([
  {
    ignores: [
      "main.js",
      "dist/**",
      "build/**",
      "scripts/**",
      "esbuild.config.mjs",
      "node_modules/**",
      // .temp 是本轮诊断 / 一次性导出的本地临时区（不进 Git、不是构筑物），
      // 里面的 .ts 快照不应参与商店扫描同款规则。
      ".temp/**",
      // .zcode 是编码会话工作流的机器产物（不进 Git、不是构筑物），
      // 其草稿 / 运行日志不在 tsconfig 内，不应参与扫描。
      ".zcode/**",
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs"],
        },
      },
    },
  },
]);
