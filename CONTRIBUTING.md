# 参与 Sidet 开发

Sidet 采用 MIT 许可证，源码公开在 [GitHub 仓库](https://github.com/jiaoyingxing/sidet)。

## 环境

- Node.js 20 或更新版本
- npm

## 本地检查

```bash
npm ci
npm run typecheck
npm run lint
npm run test:logic
npm run build
```

`npm run build` 只生成仓根 `main.js`，不会写入任何 Obsidian 库；`main.js` 是构建产物，不要提交。

## 提交边界

- 源码、测试和构建链的改动放在 `src/`、`scripts/` 与根配置中。
- 不提交 `main.js`、`node_modules/`、`.obsidian/` 或本地临时产物。
- 公开仓是源码仓的单向投影；维护者会用投影脚本同步，贡献者不需要手工复制文件。
- 行为改动请附带能覆盖该行为的逻辑测试；移动输入、键盘和主页几何属于用户真机验收过的稳定合同，改动前先说明复现证据。
