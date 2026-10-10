/**
 * 把主 README 拆成「精简主页 + 若干子文档」。
 *
 * 为什么写脚本而不是手改：原文有 500 多行、几十处代码块和表格，
 * 手抄一遍必然出错。这里按标题**机械切片**，原文一个字都不动，
 * 只做两件事：① 把章节搬到 `docs/` 下；② 重写主页和英文版。
 *
 * 相对链接要跟着搬：`examples/README.md` → `../examples/README.md`，
 * `docs/架构说明.md` → `架构说明.md`（同目录）。
 *
 * 跑法：node scripts/split-readme.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'D:/Projects/DSHP/dsh-shader-workbench';
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const lines = readme.split('\n');

/** 找到某个标题的行号（返回第一个匹配）。 */
const at = (re) => {
  const i = lines.findIndex((l) => re.test(l));
  if (i < 0) throw new Error(`找不到标题：${re}`);
  return i;
};

// 章节边界（按文件里的出现顺序）
const H = {
  install: at(/^## 装上$/),
  examples: at(/^### 自带示例$/),
  extend: at(/^## 加节点不用重启$/),
  ui: at(/^## 界面$/),
  canvas: at(/^### 节点画布操作$/),
  nodes: at(/^## 节点库/),
  tools: at(/^## 给 agent 的 9 个工具$/),
  workspace: at(/^## 工作区结构$/),
  security: at(/^## 安全$/),
  trouble: at(/^## 排查/),
  dev: at(/^## 开发$/),
  perf: at(/^### 实测性能/),
  size: at(/^## 体积$/),
  todo: at(/^## 本版没做的$/),
  license: at(/^## 许可$/),
};
const slice = (a, b) => lines.slice(a, b).join('\n').trimEnd();

/** 搬运时修相对链接（子文档在 docs/ 里，深度变了）。 */
const fixLinks = (text) =>
  text
    .replaceAll('](examples/', '](../examples/')
    .replaceAll('](docs/', '](')
    .replaceAll('](scripts/', '](../scripts/')
    .replaceAll('](README.md)', '](../README.md)')
    .replaceAll('](LICENSE)', '](../LICENSE)');

const doc = (title, intro, bodies) =>
  `${bodies.map(fixLinks).join('\n\n---\n\n')}\n`;

// ── 子文档 ───────────────────────────────────────────────
const docs = {
  '安装与配置.md': doc(
    '安装与配置',
    '',
    [
      `# 安装与配置\n\n${slice(H.install, H.examples)}`,
      slice(H.security, H.trouble),
      slice(H.trouble, H.dev),
    ],
  ),
  '使用手册.md': doc(
    '使用手册',
    '',
    [
      `# 使用手册\n\n${slice(H.ui, H.nodes)}`,
      slice(H.nodes, H.tools),
      slice(H.tools, H.workspace),
      slice(H.workspace, H.security),
    ],
  ),
  '扩展指南.md': doc('扩展指南', '', [`# 扩展指南\n\n${slice(H.extend, H.ui)}`]),
  '开发与验证.md': doc(
    '开发与验证',
    '',
    [`# 开发与验证\n\n${slice(H.dev, H.size)}`, slice(H.size, H.todo), slice(H.todo, H.license)],
  ),
};

for (const [name, text] of Object.entries(docs)) {
  writeFileSync(join(ROOT, 'docs', name), text, 'utf8');
  console.log(`docs/${name.padEnd(16)} ${text.split('\n').length} 行`);
}

// ── 主页（中文）─────────────────────────────────────────
const REPO = 'https://github.com/Moolight/dsh-shader-workbench';

/** 预览图（主页只留 4 张，其余在 examples/README.md）。 */
const preview = (file, cap) =>
  `<td align="center"><img src="${file}" width="330"><br><sub>${cap}</sub></td>`;

const HOME = `# dsh-shader-workbench

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![tests](https://img.shields.io/badge/tests-98%20passing-brightgreen.svg)](docs/开发与验证.md)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](docs/开发与验证.md)

**简体中文** · [English](README.en.md)

**DSH Shader 工作台**：节点式搭 GLSL → Shadertoy 兼容实时预览 → 热重载 → 本地材质资源管理。
装在 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 里是一个侧栏入口 + 一整块工作台面板，
同时给 agent 开放 9 个工具，让它能直接建项目、搭节点图、编译、导出、打快照。

- **零第三方运行时依赖**：没有构建链，全是手写 ESM JavaScript，装上去就是一个目录。
- **节点图 = 程序**：内置节点库只放 **55 个通用件**；效果专用逻辑一律拆成图上能展开编辑的普通节点，不做黑盒。
- **重复是语言结构**：组的「重复次数」> 1 就是循环，循环体只写一遍（IFS 隧道 99 步、贝塞尔 24 段都靠它，图和着色器小两个数量级）。
- **可扩展、免重启**：用户节点丢个 JSON 进 \`<工作区>/library/nodes/\` 就能加；节点分类和项目名都支持多级。
- **面板和 agent 共用一套工具与工作区**：存储位置能在面板里改，两边看到的永远是同一份数据。
- **104 个用例**：含真机 WebGL2 编译校验、GPU 像素回读、真鼠标拖拽交互、1080p 性能度量。

## 装上

\`\`\`bash
cd ~/.dsh/profiles/desktop
# package.json：dependencies 加 "dsh-shader-workbench": "file:<本仓库路径>"
#               dsh.profile.bundles 加 "dsh-shader-workbench"
node <pnpm.cjs 路径> install
\`\`\`

然后重启 DSH，侧栏会出现「Shader 工作台」。存储位置、配置项、加载排查见
[安装与配置](docs/安装与配置.md)。

## 七个自带示例

面板资源树里点 **载入示例** 即可。**一个新节点都没加**，全部用现有组件搭出来。

<table>
<tr>
${preview('examples/demo/materials/phantom-star/preview.png', '<b>IFS 隧道</b>（Phantom Star 移植）<br>99 步累积 = 一个重复组，和原版逐像素一致')}
${preview('examples/fourier-epicycles/materials/epicycles/preview.png', '<b>DFT 本轮画心形</b><br>每个旋转向量一个节点，轨迹靠 BufferA 反馈')}
</tr>
<tr>
${preview('examples/gaussian-blur/materials/blur/preview.png', '<b>9 抽样高斯模糊</b><br>双 Pass，半径可拖')}
${preview('examples/bezier/materials/curve/preview.png', '<b>三次贝塞尔</b><br>24 段采样是一个重复组，四个控制点可拖')}
</tr>
</table>

另外三个（傅里叶级数 / 谐波频谱 / 景深）和每个示例的做法见 [示例说明](examples/README.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [安装与配置](docs/安装与配置.md) | 装上、存储位置与优先级、安全边界、加载排查 |
| [使用手册](docs/使用手册.md) | 界面、画布操作与快捷键、节点库 55 个节点、9 个工具、工作区结构 |
| [扩展指南](docs/扩展指南.md) | 加节点的三条路：用户节点 / 组与重复组 / 内置节点 |
| [开发与验证](docs/开发与验证.md) | 开发命令、真机验证与实测性能、体积、本版没做的 |
| [接口契约](docs/接口契约.md) | HTTP 动作、节点定义与代码生成契约（**改代码前先看这份**） |
| [架构说明](docs/架构说明.md) | 分层、数据流、关键设计取舍与踩过的坑 |
| [验收报告](docs/验收报告.md) | 各里程碑的真机验收记录 |
| [示例说明](examples/README.md) | 7 个示例分别演示了什么、怎么搭的 |

> 详细文档目前以中文为主；英文的 issue / PR 一样欢迎。

## 仓库

- 仓库：<${REPO}>
- 问题反馈：<${REPO}/issues>
- 许可：[MIT](LICENSE)

---

名字里的 "workbench" 是字面意思：它是个工作台，不是渲染引擎 ——
引擎只有 WebGL2，剩下的是「让你能一边连节点一边看画面」的那些东西。
`;

writeFileSync(join(ROOT, 'README.md'), HOME, 'utf8');
console.log(`README.md           ${HOME.split('\n').length} 行（原 ${lines.length} 行）`);
