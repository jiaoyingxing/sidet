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
