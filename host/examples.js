/**
 * 插件自带的示例。
 *
 * 为什么示例要放插件里，而不是只躺在运行期工作区：工作区是**用户数据**，
 * 换台机器、重装 profile、或者把存储位置改到别处，示例就没了。
 * 样例属于**交付物**，所以放在插件包里（`examples/<名字>/`），
 * 面板上一个「载入示例」按钮就能把它写进当前工作区。
 *
 * 目录形状与工作区里的 `projects/<项目>/` 完全一致，
 * 所以"载入"就是把整棵目录拷过去 —— 不经过 createProject/saveMaterial 重塑，
 * 免得把示例里精心调过的 manifest 字段、预览图弄丢。
 *
 * @module dsh-shader-workbench/host/examples
 */

import { cp, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 示例根目录（插件包内）。 */
export function examplesRoot() {
  return resolve(fileURLToPath(new URL('../examples', import.meta.url)));
}

/**
 * 校验示例名字，顺便挡住路径穿越。
 * @param {unknown} name
 * @returns {string}
 */
function safeExampleName(name) {
  const text = String(name ?? '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new Error(`示例名字只允许字母数字下划线连字符，收到：${JSON.stringify(String(name ?? ''))}`);
  }
  return text;
}

/**
 * 列出自带示例。
 * @returns {Promise<Array<{name:string,title:string,description:string,materials:string[]}>>}
 */
export async function listExamples() {
  const root = examplesRoot();
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    let project = {};
    try {
      project = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'));
    } catch {
      // 没有 project.json 也照样列出来：示例只要能被拷走就行
    }
    let materials = [];
    try {
      const files = await readdir(join(dir, 'materials'), { withFileTypes: true });
      materials = files.filter((f) => f.isDirectory()).map((f) => f.name);
    } catch {
      materials = [];
    }
    out.push({
      name: entry.name,
      title: typeof project.title === 'string' && project.title ? project.title : entry.name,
      description: typeof project.description === 'string' ? project.description : '',
      materials,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 列出示例自带的库文件（用户节点 / 组 / 预设）。
 *
 * 为什么示例要带库文件：效果专用节点（比如 `ifsTunnel`、`epicycles`）不该塞进
 * 内置节点库 —— 那是插件源码，用不上的人也得背着它。改成随示例走的**用户节点**，
 * 载入示例时装进 `<工作区>/library/`，不碰源码、不重启。
 *
 * @param {string} name 示例名
 * @returns {Promise<{nodes:string[], groups:string[]}>}
 */
export async function listExampleLibrary(name) {
  const safe = safeExampleName(name);
  const dir = join(examplesRoot(), safe, 'library');
  const out = { nodes: [], groups: [] };
  if (!existsSync(dir)) return out;
  for (const [key, sub] of [['nodes', 'nodes'], ['groups', 'groups']]) {
    try {
      const files = await readdir(join(dir, sub), { withFileTypes: true });
      out[key] = files.filter((f) => f.isFile() && f.name.endsWith('.json')).map((f) => f.name);
    } catch {
      out[key] = [];
    }
  }
  return out;
}

/**
 * 读**所有**示例自带的用户节点原始 JSON，按 type 去重。
 *
 * 去重是必要的而不是偷懒：同一个节点（比如 `fourierSeries`）会被两个示例各带一份 ——
 * 那样每个示例才自包含。装进工作区时按 `<type>.json` 落文件，本来就是同一份。
 *
 * @returns {Promise<{entries: Array<{name:string, json:object}>, errors: Array<{source:string, message:string}>}>}
 */
export async function exampleNodeEntries() {
  const seen = new Map();
  const errors = [];
  for (const example of await listExamples()) {
    const lib = await listExampleLibrary(example.name);
    for (const file of lib.nodes) {
      const full = join(examplesRoot(), example.name, 'library', 'nodes', file);
      let json;
      try {
        json = JSON.parse(await readFile(full, 'utf8'));
      } catch (error) {
        errors.push({
          source: `${example.name}/${file}`,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (seen.has(json.type)) continue;
      seen.set(json.type, { name: `${example.name}/${file}`, json });
    }
  }
  return { entries: [...seen.values()], errors };
}

/**
 * 把示例自带的库文件并进工作区的 `library/`。
 *
 * 按 `<类型名>.json` 落文件，所以两个示例带同一个节点（比如 fourierSeries）
 * 只会落一份，不会互相覆盖出岔子。
 *
 * @param {{root:string}} workspace
 * @param {string} name 示例名
 * @returns {Promise<{installed:string[]}>}
 */
export async function installExampleLibrary(workspace, name) {
  const safe = safeExampleName(name);
  const source = join(examplesRoot(), safe, 'library');
  const installed = [];
  if (!existsSync(source)) return { installed };
  for (const sub of ['nodes', 'groups', 'presets']) {
    const from = join(source, sub);
    if (!existsSync(from)) continue;
    const to = resolve(workspace.root, 'library', sub);
    await mkdir(to, { recursive: true });
    const files = await readdir(from, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      await cp(join(from, file.name), join(to, file.name), { force: true });
      installed.push(`library/${sub}/${file.name}`);
    }
  }
  return { installed };
}

/**
 * 把一个自带示例拷进当前工作区。
 *
 * @param {{root:string}} workspace
 * @param {string} name 示例名（`examples/` 下的目录名）
 * @param {object} [opts]
 * @param {boolean} [opts.overwrite] 已存在时是否覆盖
 * @returns {Promise<{name:string, project:string, dir:string, materials:string[], library:string[], overwritten:boolean}>}
 */
export async function loadExample(workspace, name, { overwrite = false } = {}) {
  const safe = safeExampleName(name);
  const source = join(examplesRoot(), safe);
  if (!existsSync(source) || !(await stat(source)).isDirectory()) {
    const available = (await listExamples()).map((e) => e.name);
    throw new Error(`没有这个示例：${safe}（现有：${available.join(', ') || '无'}）`);
  }

  // 目标必须落在 <工作区>/projects/ 里面
  const projectsDir = resolve(workspace.root, 'projects');
  const target = resolve(projectsDir, safe);
  if (target !== projectsDir && !target.startsWith(projectsDir + sep)) {
    throw new Error(`拒绝写到工作区外面：${target}`);
  }

  const exists = existsSync(target);
  if (exists && !overwrite) {
    const error = new Error(`${safe} 已经存在了。要覆盖就带 overwrite: true`);
    error.code = 'example-exists';
    error.status = 409;
    throw error;
  }

  // 先装库文件再拷项目：示例里的图引用了这些用户节点，
  // 装完才编译得过（顺序反了的话中间会有一瞬间是坏图）
  const { installed } = await installExampleLibrary(workspace, safe);
  await cp(source, target, { recursive: true, force: true });

  const materials = [];
  try {
    const files = await readdir(join(target, 'materials'), { withFileTypes: true });
    for (const file of files) if (file.isDirectory()) materials.push(file.name);
  } catch {
    // 没有 materials/ 就算了，不因为列不出来而把载入判成失败
  }

  return {
    name: safe,
    project: safe,
    dir: target,
    materials,
    library: installed,
    overwritten: exists,
  };
}
