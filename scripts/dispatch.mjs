#!/usr/bin/env node
// 调度脚本入口：真正的调度脚本在 agent-board，本文件不含调度逻辑。
// 做两件事：1) 告诉真脚本「这次给本仓库干活」（设 DISPATCH_REPO）；2) 加载真脚本。
// 命令行参数原样透传（真脚本自己读 process.argv）。
// 想换真脚本的位置：设环境变量 DISPATCH_SCRIPT。说明文档：../agent-board/docs/dispatch.md

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 本仓库根目录 = 本文件所在目录的上一级
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 默认找同级目录里的 agent-board（如 C:/workspace/agent-board）
const REAL = process.env.DISPATCH_SCRIPT || path.resolve(REPO, '..', 'agent-board', 'scripts', 'dispatch.mjs');

if (!fs.existsSync(REAL)) {
  console.error(`找不到调度脚本：${REAL}`);
  process.exit(1);
}

process.env.DISPATCH_REPO = REPO;
await import(pathToFileURL(path.resolve(REAL)).href);
