# dsh-shader-workbench

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![tests](https://img.shields.io/badge/tests-98%20passing-brightgreen.svg)](#测试)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#体积)

**仓库**：<https://github.com/Moolight/dsh-shader-workbench> ·
**问题反馈**：<https://github.com/Moolight/dsh-shader-workbench/issues>

DSH Shader 工作台：**节点式搭建 GLSL → Shadertoy 兼容实时预览 → 热重载 → 本地材质资源管理**。

装在 DSH 里就是一个侧栏入口 + 一整块工作台面板，同时给 agent 开放 9 个工具，
让它能直接建项目、搭节点图、编译、导出、打快照。

- 版本：0.1.0
- 覆盖范围：M0–M3（脚手架 / 渲染闭环 / 节点编辑器 / 资源管理）
- 依赖：**零第三方运行时依赖**。没有构建链，全是手写 ESM JavaScript。
- 测试：**104 个用例**（98 过 / 1 个沙箱下跑不了的无头浏览器用例 / 5 跳过），
  含真机 WebGL2 编译校验、**GPU 像素回读**、**真鼠标拖拽交互**、面板端到端冒烟、
  1080p 性能度量、示例性能护栏
- 许可：[MIT](LICENSE)

---

## 装上

```bash
# 在 profile 目录里加一行 file: 依赖
cd ~/.dsh/profiles/desktop
# package.json 的 dependencies 里加：
#   "dsh-shader-workbench": "file:D:/Projects/DSHP/dsh-shader-workbench"
# dsh.profile.bundles 里也加一项 "dsh-shader-workbench"
node <pnpm.cjs 路径> install
```

然后**重启 DSH**。侧栏会出现「Shader 工作台」。

### 存储位置

**面板资源树最上面那一行就是**：显示当前存哪，旁边有「更改 / 复制路径 / 重置」。
改完立刻生效，落在 `<DSH_HOME>/shader-workbench.json`。

优先级（高到低）：

1. profile 配置里的 `workspaceRoot`
2. 环境变量 `DSH_SHADER_WORKBENCH_ROOT`
3. **面板里选的那个**（`<DSH_HOME>/shader-workbench.json`）
4. 会话工作目录下的 `shader-workbench/`（工具）/ 最近一次工具用过的根（面板）

被第 1、2 条压过时，那一行会挂一个「来自插件配置 / 来自环境变量」的徽标 ——
否则你会以为"在面板里改了却没生效"。

> 第 3 条是**面板和 agent 共用**的一层。没有它的时候两边会算出不同的根：
> agent 把材质写进 A，你在面板里看到的是 B（空的），资源树永远空，
> 存图/快照/导出这些按钮点了也"没反应"。2026-10-10 报的就是这个。
>
> 路径必须是**绝对路径**；留空串 = 清掉手动设置、回到自动推断。

### 自带示例

插件包里带着 7 个现成样例（`examples/`），面板资源树里点 **载入示例** 就能拷进当前工作区：

| 示例 | 是什么 |
|---|---|
| `demo` | **IFS 隧道（Phantom Star）**：原版照搬，99 步累积是一个**重复组**，逐像素一致 |
| `fourier-series` | **方波 = 正弦叠加**：每个奇次谐波一个节点，链式累加；想加项就再加一个节点 |
| `fourier-spectrum` | **频谱**：每根柱一个节点，柱高 = 各次谐波幅度（`1/n` 衰减） |
| `fourier-epicycles` | **DFT 逆变换**：每个旋转向量一个节点；轨迹靠 BufferA 反馈攒出来 |
| `gaussian-blur` | **9 抽样高斯模糊**：双 Pass，半径可拖 |
| `depth-of-field` | **景深**：深度写进 alpha，模糊半径按弥散圆算，焦点可拖 |
| `bezier` | **三次贝塞尔**：24 段采样是一个**重复组**（`loopIndex` 给段号），四个控制点可拖 |

**七个示例一个新节点都没加**，全部用现有组件搭：前四个把循环**展开成普通节点**
铺在画布上，后三个用 `group` 元节点把几十个节点包成一颗（组可以右键「拆开组」还原，
不是黑盒）。详见 [`examples/README.md`](examples/README.md)。

工作区空着时，空状态里也有一个「载入示例」入口；同名已存在会先问一句要不要覆盖。

示例是**随插件分发**的，所以换机器、重装 profile、或者把存储位置改到别处，它们都还在 ——
不像运行期工作区那样说没就没。细节见 [`examples/README.md`](examples/README.md)。

---

## 加节点不用重启

**先说清楚以前为什么会必须重启。** `shared/nodes.js` 里那三个导出
（`NODE_LIBRARY` / `NODE_BY_TYPE` / `NODE_CATEGORIES`）以前是 `Object.freeze`
的模块级常量，只在**首次 import 那一刻**算一次：

| | 怎么拿到节点库 | 改了之后 |
|---|---|---|
| 面板 | 浏览器经 `/module/…` **从磁盘现拉** | 刷新页面就生效 |
| 宿主 | `host/index.js` 静态 import，进了 ESM 缓存 | 进程活着就永远是旧的 → **只能重启** |

所以那三个导出改成了**同一批对象、原地重建**（引用不变、内容更新），
所有持有者自动跟着变。在此之上有两条路：

### 一、用户节点：丢一个 JSON 就多一个节点

写在 `<工作区>/library/nodes/*.json`（工作区里已经放了一个能用的例子
`library/nodes/wave-line.json`）：

```json
{
  "type": "waveLine",
  "title": "波形线",
  "category": "自定义",
  "inputs":  [{ "id": "uv", "type": "vec2", "def": 0 }],
  "outputs": [{ "id": "out", "type": "vec4" }],
  "params":  { "thickness": { "type": "float", "value": 0.02, "min": 0.002, "max": 0.2, "label": "线宽" } },
  "glslPrelude": "vec4 st_waveLine(vec2 uv, float w) { … }",
  "code": "st_waveLine($in.uv, $p.thickness)"
}
```

宿主每次用到工作区时按「文件名 + mtime + size」的签名比对，变了就重读；
面板点节点库右上角的 **↻** 同步（重开面板也会同步）。**全程不重启。**
用户节点在库里带「用户」标记，和内置节点区分开。写错了不会静默：
坏文件的文件名 + 原因会进诊断日志，好文件照常加载。

### 二、组（Group）元节点：搭好一张子图，打包成节点

画布上框选若干节点 → 右键 → **打成 Group**：它们变成一个 `group` 节点，
内部连线留在子图里，**跨边界的连线自动变成组的输入/输出端口**，
所以打完组图的语义完全不变。右键「拆开组」可以还原。

组是元节点：子图**内联**在组节点的 `params.graph` 里（不是引用外部文件），
所以材质自包含，宿主和浏览器两侧的生成器各自递归展开就行。

**这才是给工作台加能力的正路：搭图 + 打包，不碰插件源码，也就不涉及重启。**

### 三、真的改了内置节点源码

节点库右上角 **↻** 会同时带查询串重新 import 插件的 `shared/nodelib.js`
（Node 的 ESM 缓存按完整 URL 算，拿到的是新副本），再原地重建注册表 ——
**连改内置节点也不用重启进程**。也可以直接调接口：

```bash
curl -X POST http://127.0.0.1:19387/plugins/dsh-shader-workbench/api \
  -H 'content-type: application/json' -d '{"action":"nodelib.reload","builtin":true}'
```

---

## 界面

```
┌──────────────────────────────────────────────────────────────────┐
│ Shader 工作台   demo/plasma  [存图][快照][导出 GLSL][插入示例]      │
├──────────┬────────────────────────────────────┬──────────────────┤
│ 资源树    │  Pass 标签: image BufferA +Buffer   │  诊断日志         │
│  ├ 项目   │ ┌──────────────┬─────────────────┐ │                  │
│  │ ├ 材质 │ │ 节点库（搜索）│   节点画布       │ │  生成的 GLSL      │
│  └ 快照   │ │  输入/数学/… │  拖拽 / 连线     │ │                  │
├──────────┤ │              │                 │ │                  │
│ 参数面板  │ └──────────────┴─────────────────┘ │                  │
│  uniform │  预览：全屏 Shader ⇄ 材质网格       │                  │
│  节点参数 │  [暂停][截图] 速度 ──●── 质量 1×    │                  │
└──────────┴────────────────────────────────────┴──────────────────┘
```

### 节点画布操作

| 操作 | 快捷键 |
|---|---|
| 加节点 | 从左侧节点库点一下，或直接拖进画布 |
| 连线 | 从输出端口拖到输入端口 |
| 拆线 | 从输入端口往外拖 |
| 移动 | 拖节点体 |
| 多选 | Shift/Ctrl + 点，或空白处框选 |
| 平移 | 中键拖，或空格 + 左键拖 |
| 缩放 | 滚轮（以光标为锚点） |
| 适应视图 | 双击空白，或顶栏按钮 |
| 复制 | Ctrl+D |
| 删除 | Delete |
| 全选 | Ctrl+A |
| 右键菜单 | 节点上出「复制/断开/删除」，空白处出「插入示例/视图/清空 Pass」 |
| 重复接同一输入端口 | 后接的替换先接的（一个输入端口只保留一条来线） |

连线的颜色代表数据类型：灰=float、绿=vec2、黄=vec3、粉=vec4。
**任意两种类型都能连**：生成器会自动补转换（广播 / 补位 / 截断）。
有损转换（比如 vec4 → vec2 丢分量）会在状态栏提示，但不阻止。只有成环会被拒绝。

---

## 节点库（55 个，只放通用件）

| 分类 | 节点 |
|---|---|
| 输入 | uv、aspect、time、resolution、mouse、mouseUV、const、uniform |
| 数学 | add、sub、mul、div、pow、sqrt、abs、floor、fract、mod、clamp、saturate、smoothstep、stepNode、mixNode、oneMinus、minNode、maxNode |
| 向量 | vec2Node、vec3Node、vec4Node、split、dot、normalize、length、distance、rotate、scaleP |
| 颜色 | rgb、mixColor、palette、hsv、gamma、luminance |
| 程序化 | noise、fbm、hash、circle、gradient |
| 纹理 | texture（iChannel0-3）、bufferSample（BufferA-D） |
| 自定义 | custom（直接写 GLSL 表达式） |
| 分组 | group（元节点，**带「重复次数」= 循环**）、groupInput、groupOutput、loopIndex |
| 输出 | output |

> **循环用「重复次数」，别把重复写成复制。** 组的 `repeat > 1` 就是循环：
> 循环体只写一遍，外面套 `for`；跨迭代传递的量用 `params.graph.carries` 指定，
> 循环体里放一个 `loopIndex` 节点就能拿到当前轮次。
>
> 这条是踩出来的：IFS 隧道的 99 步一度展开成 99 份复制 —— 801 个节点、
> **676 KB 着色器**、2 MB 图、codegen 352 ms，面板一打开就卡；贝塞尔的 24 段复制
> 也要 51 KB 着色器。改成重复组之后是 10 个节点 / 9 KB / 34 KB 图，**输出逐像素一致**。
> 测试里有护栏（`examples.test.js`：节点数 / 图大小 / 着色器大小都封顶）。
>
> **列表也支持多级**：节点分类写 `"例程/傅里叶"`，面板上就是可折叠的两级；
> 项目名可以带斜杠（`傅里叶/series`），磁盘上就是多层目录，资源树按 `/` 分层渲染。

> **效果专用节点不在这里，也不在任何地方。** `ifsTunnel`（IFS 隧道）、
> `fourierSeries`（傅里叶级数）、`epicycles`（DFT 本轮）先后做过内置节点和
> 示例自带的用户节点，**两次都是黑盒**：循环藏在 `glslPrelude` 里，
> 画布上展不开、参数改不了。
>
> 现在它们被**展开成普通节点铺在图上**：每个谐波一个 `custom` 节点、
> 每个旋转向量一个节点、每次 IFS 折叠一个节点。代价是 `terms` 滑块没了 ——
> 项数变成图上节点的个数，想加就复制一个节点。这就是"可编辑"的样子，
> 详见 [`examples/README.md`](examples/README.md)。
>
> `glslPrelude` 这条机制本身还在（用户节点靠它，写法见
> [`docs/架构说明.md` 7.1](docs/架构说明.md)），但它是**最后手段**：
> 能展开成节点的就别藏进 prelude。

`float` 与 `vecN` 之间、以及不同维度的 `vecN` 之间都可以直连，
生成器自动补转换：

| 方向 | 生成的代码 |
|---|---|
| float → vecN | `vecN(x)` 广播 |
| vecN → vecM（M>N） | `vec4(x.x, x.y, 0.0, 1.0)` 补位 |
| vecM → vecN（N<M） | `vec2(x.x, x.y)` 截断 |
| vecN → float | `(x).x` 取第一分量 |

**第 4 位（alpha）补 1.0，不是 0.0。** 这条踩过坑：补 0 会让画面全透明，
而且编译器不报错。

---

## 给 agent 的 9 个工具

| 工具 | 作用 |
|---|---|
| `shader_node_library` | 拿完整节点手册（写图之前先看这个） |
| `shader_workspace` | 工作区概览 |
| `shader_project` | 项目 list / create / read |
| `shader_material` | 材质 list / create / read / save / archive |
| `shader_graph_build` | 用「节点别名 + `别名.端口`」建图并落盘 |
| `shader_compile` | 只做代码生成，不开工作台也能验证 |
| `shader_export` | 写 shader.frag + bundle.json |
| `shader_snapshot` | 快照 create / list / restore |
| `shader_texture_import` | 把磁盘上的图拷进材质并绑通道 |

`shader_graph_build` 的写法（最省事的一种）：

```json
{
  "project": "demo",
  "material": "plasma",
  "nodes": [
    { "id": "uv0", "type": "uv", "x": 0, "y": 0 },
    { "id": "t0", "type": "time", "x": 0, "y": 160 },
    { "id": "pal", "type": "palette", "x": 220, "y": 80 },
    { "id": "out0", "type": "output", "x": 460, "y": 80 }
  ],
  "edges": [
    { "from": "uv0.out", "to": "pal.t" },
    { "from": "t0.out", "to": "pal.t" },
    { "from": "pal.out", "to": "out0.color" }
  ]
}
```

---

## 工作区结构

```
shader-workbench/
├── projects/<项目>/materials/<材质>/
│   ├── graph.json          节点图
│   ├── material.json       材质清单
│   ├── <材质>.frag         导出的 GLSL
│   ├── textures/           纹理
│   └── .snapshots/         版本快照
├── library/{nodes,snippets,presets,comfy-workflows}/
└── cache/{compiled,previews}/
```

**归档材质是移动到 `.trash/`，不是删除。**
**回滚快照前会自动再打一份 `before-rollback` 快照**，所以回滚本身也可回滚。

---

## 安全

- 所有路径操作限制在工作区内，解析后做前缀校验（不是过滤特殊字符）。
- 目录名走白名单：拒绝路径分隔符、`..`、Windows 保留名、控制字符。
- HTTP API 同源校验，请求体上限 256 KiB。
- 面板自己不碰磁盘，全部走 Host。
- `readOnly: true` 时所有写操作被拒。

---

## 排查：插件好像没加载？

DSH 只在插件加载失败时把原因写进**自己的 stderr**（桌面壳里没人看得见，也不落盘），
所以「插件为什么没生效」本来是个查不动的问题。本插件自己留了一份启动记录：

```
~/.dsh/shader-workbench-boot.log
```

每行一个 JSON。正常加载长这样（三行）：

```json
{"phase":"module-loaded","node":"v24.x","electron":"44.0.0"}
{"phase":"apply-start","hasTools":true,"hasWebServer":true,"hasEffect":true}
{"phase":"apply-ok","registered":["shader_node_library", "...共 9 个"],"failed":[],"route":"ok"}
```

对着表看：

| 日志里有 | 说明 |
|---|---|
| 什么都没有 | 模块压根没被 import —— 问题在 profile 的 `dsh.profile.bundles`，或包没装好 |
| `config-schema-invalid` | `Config` 不是 Standard Schema。改回去就完事，别犹豫 |
| `module-loaded` 但没有 `apply-start` | 两种成因，**第 ① 种是本项目最贵的坑，见下面两条**：① 模块有 `default` 导出，宿主只拿到裸 `apply`，`inject` / `Config` / `name` 全丢；② `Config` 不是 Standard Schema |
| `apply-start` 但没有 `apply-ok` | `apply()` 抛了；紧接着会有一行 `apply-error` 带上 message 与 stack |
| 有 `tool-register-failed` | 某个工具的 schema 被 DSH 拒了，那行写清了是哪个工具、什么原因 |
| `route:"failed: ..."` | 工具能用，但 HTTP 路由没挂上（面板会连不上 Host） |
| `route:"ok"`，但 `/plugins/dsh-shader-workbench/...` 全是 404 | **注册的前缀带了尾斜杠**，见下面第三条。boot log 一切正常，浏览器只报 `Failed to fetch dynamically imported module` |

> ### ⚠️ 三条必须记住的契约（都是「静默失效」，都不报错）
>
> **① 不要写 `export default`。** `@deepseek-ai/cordis-plugin-include` 装载一个包时是
> `data = module.default || module`（`lib/index.js:157`）。只要模块有 default 导出，
> 宿主拿到的就是那个裸函数，`inject` / `Config` / `name` 一个都读不到：
> fiber 不等服务就激活，`apply()` 里第一句 `ctx.tools` 立刻抛
> `Error: cannot get property "tools" without inject`。
> **对照物：同 profile 里能正常工作的 `dsh-image-gen` 就没有 default 导出。**
> 现在 `plugin-load.test.js` 里有一份逐字复刻的 `plugin.default || plugin` 断言守着。
>
> **② `Config` 必须是 Standard Schema**（`Config['~standard'].validate`），不能是裸
> JSON Schema。Cordis 激活 fiber 时无条件调它（`resolveConfig`），裸对象抛
> `TypeError: Cannot read properties of undefined (reading 'validate')`。
> 注意：只有修好 ①、宿主真的读到 `Config` 之后，这条才会咬人 —— **两个都得修**。
>
> ①② 的症状一模一样：**`module-loaded` 有了、`apply()` 不跑、侧栏什么都不出现、
> DSH 一声不吭**（错误只写进宿主自己的 stderr，桌面壳里没人看得见也不落盘，
> 可选插件连 crash 日志都不写）。当时 70 个用例全绿也没拦住 ——
> 因为测试用假 context 直接调 `apply()`，把宿主解析插件这一步整个绕过去了。
>
> **③ 注册给 webServer 的前缀不能带尾斜杠。** 宿主的前缀匹配是
> `pathname !== prefix && !pathname.startsWith(prefix + '/')` —— **它自己会补 `/`**。
> 注册成 `/plugins/x/` 之后它去比 `/plugins/x//`，永远为假：`register()` 不抛错、
> boot log 写 `route:"ok"`，但整条前缀一个请求都进不来，面板只报
> `Failed to fetch dynamically imported module`。
> 所以 `host/routes.js` 里有两个常量：处理器内部切路径用的 `API_PREFIX`（带斜杠）
> 和注册用的 `ROUTE_PREFIX`（不带），**别合并**。
> 现在 `http.test.js` 的测试服务器照抄了宿主那段匹配逻辑（以前是无条件进 handler，
> 所以 14 个用例全绿也照样漏）。
>
> 前两条由 `plugin-load.test.js` 逐字复刻宿主的装载语句 + `resolveConfig` + `apply`
> 调用序列守着；第三条由 `plugin-load.test.js` 的前缀匹配用例与 `http.test.js` 的
> 真 HTTP 服务守着。

两条独立自检（都不用看日志）：

```bash
# 路由在不在：404 = 没加载；200 = 加载成功
curl http://127.0.0.1:19387/plugins/dsh-shader-workbench/ping

# 包能不能从 profile 解析
cd ~/.dsh/profiles/desktop && node -e "import('dsh-shader-workbench').then(m=>console.log(m.name, m.inject))"
```

日志路径可用环境变量 `DSH_SHADER_WORKBENCH_BOOTLOG` 覆盖
（测试用它避免污染用户目录）。

> 注册是**逐个 try/catch** 的：一个工具的 schema 不合规不会让另外八个也上不去。
> 路由注册也单独兜住 —— 路由失败时工具照常可用。

---

## 开发

```bash
node --test "tests/*.test.js"     # 主入口（Node 原生测试运行器）
node scripts/run-tests.mjs        # 沙箱兜底：同进程顺序 import，不派生子进程
node tests/codegen.test.js        # 单个文件也能直接跑
```

> 两种 runner 都留着：`node --test` 会为每个测试文件派生子进程，
> 在受限文件沙箱下这个 spawn 会被拒（EPERM），兜底 runner 改成同进程顺序 import。
> 对应 `pnpm test` 与 `pnpm test:sandbox`。

| 测试文件 | 用例 | 验什么 |
|---|---|---|
| `codegen.test.js` | 21 | 生成器正确性、类型转换、**连接规则与生成器一致性**、错误码 |
| `workspace.test.js` | 10 | 路径安全、项目/材质/快照/纹理全流程 |
| `http.test.js` | 14 | action 分发、错误码、同源、纹理字节、模块送发 |
| `plugin-load.test.js` | 10 | 假 Cordis context 下 `apply()` 的注册形状 + 工具真执行 |
| `module-graph.test.js` | 6 | 面板模块可解析 + 导出契约 + `__ModuleLoader__` 载荷 |
| `glsl-compile.test.js` | 4 | 真 WebGL2 编译 50 个节点的 GLSL |
| `panel-smoke.test.js` | 2 | **真浏览器**：面板整块挂起来、打开材质、编译、渲染 |
| `render-gpu.test.js` | 1 | **真浏览器 + 读像素**：iChannel0-3 / 多 Pass 反馈 / iMouse |
| `editor-interaction.test.js` | 1 | **真浏览器 + 真鼠标**：拖节点、连端口、重复连接替换 |
| `perf-1080p.test.js` | 1 | **真浏览器**：1080p 帧率、GPU 单帧耗时、隐藏时空转 |

共用夹具在 `tests/helpers/browser.mjs`。

最有价值的四个测试：

1. **真机 GLSL 编译**（`glsl-compile`）——抓到过 6 个只有编译器才能发现的 bug
   （缺 `#version`、uniform 带初始化器、重载返回类型不一致、常量类型不符、表达式不递归展开……）。
2. **GPU 像素回读**（`render-gpu`）——编译通过 ≠ 画得对。
   读回像素验证纹理真的绑上了、兜底路径走了、Buffer 反馈拿的是上一帧、
   iMouse 位置与公式精确吻合。
3. **真鼠标拖拽**（`editor-interaction`）——抓到过一个**致命 bug**：
   `_onPointerUp` 先把 `this.drag` 清空、`_canDrop()` 又去读它，
   结果**手动连线从来没成功过**（编译过、单测过、模板看不出来）。
4. **1080p 性能**（`perf-1080p`）——用 `EXT_disjoint_timer_query_webgl2` 拿
   **GPU 侧真实耗时**，而不是量 CPU 的 draw 调用（后者只有 0.03ms，说明不了问题）。

后三个在受限沙箱下会**自动跳过**而不是假失败。

### 实测性能（无头 Edge + SwiftShader 软件渲染，1920×1080）

| 场景 | rAF 帧率 | CPU `render()` p95 | GPU 单帧 p95 |
|---|---|---|---|
| 简单图（uv→渐变→调色板） | 139.7 FPS | 0.10 ms | **0.07 ms** |
| 重负载（fbm 4 层 + BufferA 多 Pass） | 143.9 FPS | 0.10 ms | **0.86 ms** |

60 FPS 的预算是 16.7 ms/帧，即软件渲染下也有约 20 倍余量。真机有独显只会更快。
页面隐藏时 1 秒内渲染次数 = **0**。

详细文档见 [`docs/接口契约.md`](docs/接口契约.md) 与 [`docs/架构说明.md`](docs/架构说明.md)。

---

## 体积

| 部分 | 源码 | gzip |
|---|---|---|
| 核心 runtime（`client/runtime/` + `shared/`） | 94.8 KB | **32.0 KB** |
| 编辑器（`client/panel/`，按需加载） | 122.7 KB | — |
| Host 侧 | 65.5 KB | — |

第三方运行时依赖：**0**。

---

## 本版没做的

| 需求 | 状态 |
|---|---|
| FR-01 分组 / 注释 / 撤销重做 | 未做（增删连线复制删除、真鼠标拖拽都已验证） |
| FR-05 ComfyUI 集成（M4） | 未实现，接口已预留 |
| FR-06 HLSL / MSL / SPIR-V 跨编译（M5） | 未实现，只导出 GLSL + JSON |
| FR-10 Shadertoy 代码导入 / ZIP 导出 | 未做（材质文件导入已有） |
| 材质导出的 DDS 直读 | 只按普通图片绑槽位，不做 mipmap/ASTC 转码 |

## 许可

MIT
