/**
 * 工作区服务：项目 / 材质 / 纹理 / 预设 / 快照的本地文件读写。
 *
 * 安全红线（安全要求见需求书第 4 节）：
 *   **所有路径操作都被限制在工作区根目录内。**
 *   任何越界的相对路径（`../../`、绝对路径、盘符跳转）都会被拒绝，
 *   不是「尽量过滤」，而是解析后做前缀校验，不通过就抛。
 *
 * 目录布局（docs/接口契约.md 第 3 节）：
 *   <workspace>/
 *     projects/<project>/project.json
 *     projects/<project>/materials/<material>/material.json | graph.json | shader.frag | textures/
 *     library/nodes | snippets | presets | comfy-workflows
 *     cache/compiled | previews
 *
 * @module dsh-shader-workbench/host/workspace
 */

import { mkdir, readFile, writeFile, readdir, stat, copyFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { GRAPH_FILE, MATERIAL_FILE, TEXTURE_DIR, normalizeManifest, normalizeTextureRef } from '../shared/manifest.js';
import { normalizeAsset } from '../shared/asset-types.js';
import { importAsset } from './asset-loader.js';
import { makeGraph, normalizeGraph } from '../shared/graph.js';

/** 允许导入的纹理扩展名。 */
export const TEXTURE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.dds', '.ktx', '.ktx2', '.hdr'];

/** 目录名。 */
export const DIRS = {
  projects: 'projects',
  materials: 'materials',
  textures: TEXTURE_DIR,
  library: 'library',
  presets: 'presets',
  snippets: 'snippets',
  nodes: 'nodes',
  groups: 'groups',
  workflows: 'comfy-workflows',
  cache: 'cache',
  compiled: 'compiled',
  previews: 'previews',
  snapshots: '.snapshots',
};

/**
 * 名称合法性：不允许路径分隔符、上级跳转、Windows 保留名、控制字符。
 * 这一层是白名单校验，和后面的路径前缀校验互为双保险。
 */
const UNSAFE_NAME = /[\\/:*?"<>|\u0000-\u001f]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * 校验一个用作目录名的字符串。
 * @param {string} name
 * @param {string} what 出错信息里的名词
 * @returns {string} 规范化后的名字
 */
/**
 * 校验一个**相对路径**（项目名可以用 `/` 分层：`傅里叶/series`）。
 *
 * 每一段都必须过 `assertSafeName`，所以 `..`、绝对路径、盘符、
 * 非法字符统统进不来；深度也封顶，免得有人拿它当任意目录树使。
 *
 * @param {unknown} value
 * @param {string} [what]
 * @param {number} [maxDepth]
 * @returns {string} 归一化后的相对路径（用 `/` 分隔）
 */
export function assertSafeRelPath(value, what = '名称', maxDepth = 4) {
  const text = String(value ?? '').trim().replaceAll('\\', '/');
  if (text === '') throw new Error(`${what}不能为空`);
  const parts = text.split('/').filter((seg) => seg !== '');
  if (parts.length === 0) throw new Error(`${what}不能为空`);
  if (parts.length > maxDepth) throw new Error(`${what}最多 ${maxDepth} 层：${text}`);
  return parts.map((seg) => assertSafeName(seg, what)).join('/');
}
export function assertSafeName(name, what = '名称') {
  const value = String(name ?? '').trim();
  if (value === '') throw new Error(`${what}不能为空`);
  if (value === '.' || value === '..') throw new Error(`${what}不能是 ${value}`);
  if (UNSAFE_NAME.test(value)) throw new Error(`${what}含有非法字符：${value}`);
  if (WINDOWS_RESERVED.test(value)) throw new Error(`${what}是系统保留名：${value}`);
  if (value.length > 96) throw new Error(`${what}太长（上限 96 字符）`);
  return value;
}

/**
 * 工作区。一个实例对应一个根目录。
 */
export class Workspace {
  /**
   * @param {string} root 工作区根目录（绝对路径或可解析路径）
   * @param {object} [opts]
   * @param {boolean} [opts.readOnly] 只读模式（演练/巡检用）
   */
  constructor(root, opts = {}) {
    if (!root) throw new Error('工作区需要根目录');
    this.root = resolve(root);
    this.readOnly = opts.readOnly === true;
    /** 每个材质上次打开时的图，进程内缓存，减少磁盘抖动 */
    this.graphCache = new Map();
  }

  // ─────────────────────── 路径安全 ───────────────────────

  /**
   * 把一串相对片段拼成工作区内的绝对路径，并做越界校验。
   *
   * 这是**唯一**允许生成写路径的入口；其它方法都必须经过它。
   * @param {...string} segments
   * @returns {string}
   */
  path(...segments) {
    for (const seg of segments) {
      if (typeof seg !== 'string' || seg === '') throw new Error('路径片段不能为空');
      if (isAbsolute(seg)) throw new Error(`不允许绝对路径：${seg}`);
    }
    const full = resolve(this.root, ...segments);
    if (!this.contains(full)) {
      throw new Error(`路径越出工作区：${full}`);
    }
    return full;
  }

  /**
   * 判断一个绝对路径是否在工作区内。
   * @param {string} full
   * @returns {boolean}
   */
  contains(full) {
    if (full === this.root) return true;
    return full.startsWith(this.root + sep);
  }

  /**
   * 把工作区内的绝对路径转回相对路径（POSIX 风格，给前端用）。
   * @param {string} full
   * @returns {string}
   */
  rel(full) {
    return relative(this.root, full).replaceAll('\\', '/');
  }

  /**
   * 确保目录存在。
   * @param {...string} segments
   * @returns {Promise<string>}
   */
  async ensureDir(...segments) {
    const full = this.path(...segments);
    await mkdir(full, { recursive: true });
    return full;
  }

  /** 初始化工作区的全部子目录。 */
  async init() {
    const dirs = [
      [DIRS.projects],
      [DIRS.library],
      [DIRS.library, DIRS.nodes],
      [DIRS.library, DIRS.snippets],
      [DIRS.library, DIRS.presets],
      [DIRS.library, DIRS.groups],
      [DIRS.library, DIRS.workflows],
      [DIRS.cache],
      [DIRS.cache, DIRS.compiled],
      [DIRS.cache, DIRS.previews],
    ];
    for (const d of dirs) await this.ensureDir(...d);
    return this.root;
  }

  /**
   * 写文件（只读模式下拒绝）。
   * @param {string} full 绝对路径（必须来自 this.path）
   * @param {string|Uint8Array} content
   */
  async write(full, content) {
    this.assertWritable();
    if (!this.contains(full)) throw new Error(`写路径越出工作区：${full}`);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
    return full;
  }

  /** 只读模式守卫。 */
  assertWritable() {
    if (this.readOnly) throw new Error('工作区处于只读模式，拒绝写入');
  }

  /**
   * 读 JSON，文件不存在返回 null。
   * @param {string} full
   * @returns {Promise<any|null>}
   */
  async readJson(full) {
    if (!this.contains(full)) throw new Error(`读路径越出工作区：${full}`);
    try {
      return JSON.parse(await readFile(full, 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      if (error instanceof SyntaxError) {
        const bad = new Error(`JSON 解析失败：${this.rel(full)}（${error.message}）`);
        bad.code = 'EJSON';
        throw bad;
      }
      throw error;
    }
  }

  // ─────────────────────── 项目 ───────────────────────

  /**
   * 列出所有项目。
   * @returns {Promise<object[]>}
   */
  async listProjects() {
    const dir = this.path(DIRS.projects);
    if (!existsSync(dir)) return [];
    const projects = [];

    /**
     * 递归扫：子目录里**有 project.json 的算项目**，没有的当分组继续往下走。
     * 项目名就是相对 `projects/` 的路径（`傅里叶/series`），面板按 `/` 分层渲染 ——
     * 不用另立一套"文件夹"接口，目录本身是事实来源。
     */
    const walk = async (base, prefix, depth) => {
      if (depth > 4) return;
      let entries = [];
      try {
        entries = await readdir(base, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const meta = await this.readJson(join(base, entry.name, 'project.json'));
        if (meta === null) {
          await walk(join(base, entry.name), rel, depth + 1);
          continue;
        }
        projects.push({
          name: rel,
          title: typeof meta?.title === 'string' ? meta.title : rel,
          description: typeof meta?.description === 'string' ? meta.description : '',
          createdAt: typeof meta?.createdAt === 'string' ? meta.createdAt : undefined,
          updatedAt: typeof meta?.updatedAt === 'string' ? meta.updatedAt : undefined,
          materialCount: Array.isArray(meta?.materials) ? meta.materials.length : undefined,
        });
      }
    };

    await walk(dir, '', 0);
    projects.sort((a, b) => a.name.localeCompare(b.name));
    return projects;
  }

  /**
   * 建项目。已存在则直接返回（幂等）。
   * @param {object} input
   * @returns {Promise<object>}
   */
  async createProject(input = {}) {
    const name = assertSafeRelPath(input.name, '项目名');
    const dir = await this.ensureDir(DIRS.projects, name);
    const metaPath = join(dir, 'project.json');
    const existing = await this.readJson(metaPath);
    const now = new Date().toISOString();
    const meta = {
      name,
      title: typeof input.title === 'string' && input.title !== '' ? input.title : name,
      description: typeof input.description === 'string' ? input.description : '',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      materials: Array.isArray(existing?.materials) ? existing.materials : [],
    };
    await this.write(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    await this.ensureDir(DIRS.projects, name, DIRS.materials);
    return meta;
  }

  /**
   * 取出项目元数据。
   * @param {string} project
   * @returns {Promise<object>}
   */
  async readProject(project) {
    const name = assertSafeRelPath(project, '项目名');
    const meta = await this.readJson(this.path(DIRS.projects, name, 'project.json'));
    if (!meta) throw new Error(`项目不存在：${name}`);
    return { ...meta, name };
  }

  /** 项目目录绝对路径。 */
  projectDir(project) {
    return this.path(DIRS.projects, assertSafeRelPath(project, '项目名'));
  }

  /**
   * 把材质名登记进项目元数据。
   * @param {string} project
   * @param {string} material
   */
  async registerMaterial(project, material) {
    const name = assertSafeRelPath(project, '项目名');
    const metaPath = this.path(DIRS.projects, name, 'project.json');
    const meta = (await this.readJson(metaPath)) ?? {
      name,
      title: name,
      materials: [],
      createdAt: new Date().toISOString(),
    };
    const list = new Set(Array.isArray(meta.materials) ? meta.materials : []);
    list.add(assertSafeName(material, '材质名'));
    meta.materials = [...list].sort();
    meta.updatedAt = new Date().toISOString();
    await this.write(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    return meta;
  }

  // ─────────────────────── 材质 ───────────────────────

  /**
   * 材质目录绝对路径。
   * @param {string} project
   * @param {string} material
   * @returns {string}
   */
  materialDir(project, material) {
    return this.path(
      DIRS.projects,
      assertSafeRelPath(project, '项目名'),
      DIRS.materials,
      assertSafeName(material, '材质名'),
    );
  }

  /**
   * 列出项目下所有材质。
   * @param {string} project
   * @returns {Promise<object[]>}
   */
  async listMaterials(project) {
    const dir = this.path(DIRS.projects, assertSafeRelPath(project, '项目名'), DIRS.materials);
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    const out = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifest = await this.readJson(join(dir, entry.name, MATERIAL_FILE));
      out.push({
        name: entry.name,
        title: manifest?.name ?? entry.name,
        tags: Array.isArray(manifest?.tags) ? manifest.tags : [],
        resourceCount: Array.isArray(manifest?.resources) ? manifest.resources.length : 0,
        updatedAt: typeof manifest?.updatedAt === 'string' ? manifest.updatedAt : undefined,
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /**
   * 材质目录里某个文件的绝对路径（做名字校验）。
   * @param {string} project
   * @param {string} material
   * @param {string} fileName
   * @returns {string}
   */
  materialFile(project, material, fileName) {
    if (typeof fileName !== 'string' || fileName === '') throw new Error('文件名不能为空');
    if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
      throw new Error(`文件名不含路径分隔符：${fileName}`);
    }
    return this.path(
      DIRS.projects,
      assertSafeRelPath(project, '项目名'),
      DIRS.materials,
      assertSafeName(material, '材质名'),
      fileName,
    );
  }

  /**
   * 列材质目录里的纹理文件。
   * @param {string} dir
   * @returns {Promise<object[]>}
   */
  async listTextureFiles(dir) {
    const texDir = join(dir, TEXTURE_DIR);
    if (!existsSync(texDir)) return [];
    const entries = await readdir(texDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) => ({ file: e.name, path: `${TEXTURE_DIR}/${e.name}`, ext: extname(e.name).toLowerCase() }));
  }

  /**
   * 新建材质：落一份空图 + 空清单。
   *
   * 名字接受 `name` 或 `material` 两种写法：工具层用 `material`（跟别的 action 一致），
   * 面板和内部调用用 `name`。这里做兼容，省得两边对不上就报「材质名不能为空」。
   *
   * @param {object} input { project, name | material, title }
   * @returns {Promise<object>}
   */
  async createMaterial(input = {}) {
    const project = assertSafeRelPath(input.project, '项目名');
    const name = assertSafeName(input.name ?? input.material, '材质名');
    await this.createProject({ name: project });
    const dir = await this.ensureDir(DIRS.projects, project, DIRS.materials, name);
    await this.ensureDir(DIRS.projects, project, DIRS.materials, name, TEXTURE_DIR);

    const manifestPath = join(dir, MATERIAL_FILE);
    const existing = await this.readJson(manifestPath);
    if (!existing) {
      const graph = makeGraph({ name, passes: [{ name: 'image', graph: [] }] });
      await this.write(join(dir, GRAPH_FILE), `${JSON.stringify(graph, null, 2)}\n`);
      const manifest = normalizeManifest({
        name: typeof input.title === 'string' && input.title !== '' ? input.title : name,
        graphPath: GRAPH_FILE,
        shaderFiles: { frag: `${name}.frag` },
        updatedAt: new Date().toISOString(),
      });
      await this.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    await this.registerMaterial(project, name);
    return this.readMaterial(project, name);
  }

  /**
   * 读材质：清单 + 图 + 纹理列表。
   * @param {string} project
   * @param {string} material
   * @returns {Promise<object>}
   */
  async readMaterial(project, material) {
    const p = assertSafeRelPath(project, '项目名');
    const m = assertSafeName(material, '材质名');
    const dir = this.materialDir(p, m);
    if (!existsSync(dir)) throw new Error(`材质不存在：${p}/${m}`);
    const manifestRaw = await this.readJson(join(dir, MATERIAL_FILE));
    const manifest = normalizeManifest(manifestRaw ?? { name: m });
    manifest.name = manifest.name === 'untitled' ? m : manifest.name;

    const graphRaw = await this.readJson(join(dir, manifest.graphPath || GRAPH_FILE));
    const graph = normalizeGraph(
      graphRaw ?? makeGraph({ name: m, passes: [{ name: 'image', graph: [] }] }),
    );
    this.graphCache.set(`${p}/${m}`, graph);

    let shader = '';
    const fragPath = join(dir, manifest.shaderFiles.frag);
    if (existsSync(fragPath)) shader = await readFile(fragPath, 'utf8');

    return {
      project: p,
      name: m,
      dir: this.rel(dir),
      manifest,
      graph,
      shader,
      textures: await this.listTextureFiles(dir),
      warnings: graph.warnings ?? [],
    };
  }

  /**
   * 保存图（可同时更新清单字段）。
   * @param {object} input { project, material, graph, manifest }
   * @returns {Promise<object>}
   */
  async saveMaterial(input = {}) {
    const p = assertSafeRelPath(input.project, '项目名');
    const m = assertSafeName(input.material, '材质名');
    const dir = this.materialDir(p, m);
    if (!existsSync(dir)) throw new Error(`材质不存在：${p}/${m}`);

    let graphWritten = false;
    if (input.graph) {
      const graph = normalizeGraph(input.graph);
      delete graph.warnings;
      await this.write(join(dir, GRAPH_FILE), `${JSON.stringify(graph, null, 2)}\n`);
      this.graphCache.set(`${p}/${m}`, graph);
      graphWritten = true;
    }

    const manifestPath = join(dir, MATERIAL_FILE);
    const current = normalizeManifest((await this.readJson(manifestPath)) ?? { name: m });
    const next = normalizeManifest({ ...current, ...(input.manifest ?? {}), updatedAt: new Date().toISOString() });
    await this.write(manifestPath, `${JSON.stringify(next, null, 2)}\n`);

    return { ok: true, project: p, material: m, graphWritten, manifest: next };
  }

  /**
   * 把材质当前的图与清单复制到 .snapshots/ 下。
   * 只增不删——这也是「永不删文件」红线在插件内部的一致性做法。
   * @param {object} input { project, material, label }
   * @returns {Promise<object>}
   */
  async snapshot(input = {}) {
    const p = assertSafeRelPath(input.project, '项目名');
    const m = assertSafeName(input.material, '材质名');
    const dir = this.materialDir(p, m);
    if (!existsSync(dir)) throw new Error(`材质不存在：${p}/${m}`);
    const label = input.label === undefined ? '' : String(input.label).replace(/[^A-Za-z0-9_-]/g, '');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const id = label ? `${stamp}_${label}` : stamp;
    const target = await this.ensureDir(DIRS.projects, p, DIRS.materials, m, DIRS.snapshots, id);

    for (const file of [GRAPH_FILE, MATERIAL_FILE]) {
      const src = join(dir, file);
      if (existsSync(src)) await copyFile(src, join(target, file));
    }
    return { ok: true, id, dir: this.rel(target) };
  }

  /**
   * 列快照。
   * @param {object} input { project, material }
   * @returns {Promise<object[]>}
   */
  async listSnapshots(input = {}) {
    const dir = this.materialDir(input.project, input.material);
    const snapRoot = join(dir, DIRS.snapshots);
    if (!existsSync(snapRoot)) return [];
    const entries = await readdir(snapRoot, { withFileTypes: true });
    const out = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const info = await stat(join(snapRoot, entry.name));
      out.push({ id: entry.name, dir: `${this.rel(snapRoot)}/${entry.name}`, createdAt: info.mtime.toISOString() });
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out;
  }

  /**
   * 回滚到某个快照。回滚前先给当前状态打一份 `before-rollback` 快照——
   * 这样「回滚」本身也是可回滚的。
   * @param {object} input { project, material, snapshotId }
   * @returns {Promise<object>}
   */
  async restoreSnapshot(input = {}) {
    const p = assertSafeRelPath(input.project, '项目名');
    const m = assertSafeName(input.material, '材质名');
    const id = assertSafeName(input.snapshotId, '快照 id');
    const dir = this.materialDir(p, m);
    const snapDir = this.path(DIRS.projects, p, DIRS.materials, m, DIRS.snapshots, id);
    if (!existsSync(snapDir)) throw new Error(`快照不存在：${id}`);

    await this.snapshot({ project: p, material: m, label: 'before-rollback' });
    for (const file of [GRAPH_FILE, MATERIAL_FILE]) {
      const src = join(snapDir, file);
      if (existsSync(src)) await copyFile(src, join(dir, file));
    }
    return this.readMaterial(p, m);
  }

  /**
   * 删材质：**不是真删**，移到 `.trash/` 下。
   * 这是手册第 5 节「永远不删除文件，只移动」在插件里的落实。
   * @param {object} input { project, material }
   * @returns {Promise<object>}
   */
  async archiveMaterial(input = {}) {
    const p = assertSafeRelPath(input.project, '项目名');
    const m = assertSafeName(input.material, '材质名');
    const dir = this.materialDir(p, m);
    if (!existsSync(dir)) throw new Error(`材质不存在：${p}/${m}`);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const trash = await this.ensureDir(DIRS.projects, p, '.trash');
    const target = join(trash, `${m}.${stamp}`);
    await rename(dir, target);

    // 从项目登记里摘掉
    const metaPath = this.path(DIRS.projects, p, 'project.json');
    const meta = await this.readJson(metaPath);
    if (meta) {
      meta.materials = (Array.isArray(meta.materials) ? meta.materials : []).filter((x) => x !== m);
      meta.updatedAt = new Date().toISOString();
      await this.write(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    }
    return { ok: true, movedTo: this.rel(target) };
  }

  // ─────────────────────── 纹理 ───────────────────────

  /**
   * 把一个外部文件复制进材质的 textures/ 并登记槽位。
   *
   * 注意：`sourcePath` 是**工作区之外**的路径（用户从磁盘上选的图），
   * 所以这里只读它、绝不在它上面写；目标路径仍走 this.path() 校验。
   *
   * @param {object} input { project, material, sourcePath, slot, label }
   * @returns {Promise<object>}
   */
  async importTexture(input = {}) {
    const p = assertSafeRelPath(input.project, '项目名');
    const m = assertSafeName(input.material, '材质名');
    const slot = String(input.slot ?? 'iChannel0');
    if (!/^iChannel[0-3]$/.test(slot)) throw new Error(`非法通道槽位：${slot}`);

    // 统一走资源注册表：文件落 `textures/`、引用进 `manifest.resources[]`。
    // 旧实现写 `manifest.textures`，而那个字段已被 normalizeManifest 移除 ——
    // 归一化后的对象上没有 `textures`，`manifest.textures.filter` 必崩。
    const { asset, filePath, manifest } = await importAsset(this, {
      project: p,
      material: m,
      type: 'texture',
      sourcePath: input.sourcePath,
      slot,
      label: typeof input.label === 'string' ? input.label : undefined,
      meta: {
        source: input.source === 'comfyui' ? 'comfyui' : 'local',
        importedAt: new Date().toISOString(),
      },
    });

    return { ok: true, ref: asset, filePath, manifest };
  }

  /**
   * 解绑一个通道槽位。**不删文件**，只从清单里摘掉。
   * @param {object} input { project, material, slot }
   * @returns {Promise<object>}
   */
  async unbindTexture(input = {}) {
    const p = assertSafeRelPath(input.project, '项目名');
    const m = assertSafeName(input.material, '材质名');
    const slot = String(input.slot ?? '');
    if (!/^iChannel[0-3]$/.test(slot)) throw new Error(`非法通道槽位：${slot}`);
    const dir = this.materialDir(p, m);
    const manifestPath = join(dir, MATERIAL_FILE);
    const manifest = normalizeManifest((await this.readJson(manifestPath)) ?? { name: m });
    const resources = manifest.resources ?? [];
    const next = resources.filter((r) => !(r.type === 'texture' && r.slot === slot));
    manifest.resources = next;
    manifest.updatedAt = new Date().toISOString();
    await this.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { ok: true, removed: resources.length - next.length, manifest };
  }

  /**
   * 解析纹理引用的绝对路径（给 webServer 送文件用）。
   * @param {string} project
   * @param {string} material
   * @param {string} relPath 形如 textures/foo.png
   * @returns {string}
   */
  textureAbsolutePath(project, material, relPath) {
    const rel = String(relPath ?? '').replaceAll('\\', '/');
    if (rel === '' || rel.includes('..') || isAbsolute(rel)) throw new Error(`非法纹理路径：${relPath}`);
    return this.path(DIRS.projects, project, DIRS.materials, material, rel);
  }



   // ─────────────────────── 音频 ───────────────────────

  /** 支持的音频扩展名。 */
  static AUDIO_EXTENSIONS = /\.(mp3|flac|wav|ogg|m4a|aac|opus)$/i;

  /**
   * 找材质里绑定的音频文件。
   *
   * 返回的是**相对材质目录的路径**（比如 `world.execute(me).flac`），
   * 面板 / asset-binder 拿到之后拼 `/plugins/<id>/asset?id=<资源id>` 给 `<audio>` 用。
   * 音频文件几十兆，**不能走 JSON body**，必须流式。
   *
   * 优先级：`resources[]` 里登记的 audio 资源 → 扫材质根目录兜底。
   *
   * @param {string} project
   * @param {string} material
   * @returns {Promise<{ audio: string|null }>}
   */
  async readAudio(project, material) {
    const p = assertSafeRelPath(project, '项目名');
    const m = assertSafeName(material, '材质名');
    const dir = this.materialDir(p, m);
    if (!existsSync(dir)) throw new Error(`材质不存在：${p}/${m}`);

    const manifest = normalizeManifest((await this.readJson(join(dir, MATERIAL_FILE))) ?? { name: m });
    const registered = (manifest.resources ?? []).find(
      (r) => r.type === 'audio' && existsSync(join(dir, r.path)),
    );
    if (registered) return { audio: registered.path };

    const fileName = await this._discoverFile(dir, {
      preferred: [/^(audio|music|song)\.(mp3|flac|wav|ogg|m4a|aac|opus)$/i],
      accepted: Workspace.AUDIO_EXTENSIONS,
    });
    return { audio: fileName ?? null };
  }

  /**
   * 解析音频文件的绝对路径（给 webServer 送字节流用）。
   * @param {string} project
   * @param {string} material
   * @param {string} relPath
   * @returns {string}
   */
  audioAbsolutePath(project, material, relPath) {
    const rel = String(relPath ?? '').replaceAll('\\', '/');
    if (rel === '' || rel.includes('..') || isAbsolute(rel)) throw new Error(`非法音频路径：${relPath}`);
    if (!Workspace.AUDIO_EXTENSIONS.test(rel)) throw new Error(`不是音频文件：${relPath}`);
    return this.path(DIRS.projects, project, DIRS.materials, material, rel);
  }

  async importAudio(input = {}) {
    const p = assertSafeRelPath(input.project, '项目名');
    const m = assertSafeName(input.material, '材质名');

    // 统一走资源注册表：文件落材质根目录、引用进 `manifest.resources[]`。
    // 旧实现写顶层 `manifest.audio`，还用了没 import 的 `statSync` —— 必崩。
    const { asset, manifest } = await importAsset(this, {
      project: p,
      material: m,
      type: 'audio',
      sourcePath: input.sourcePath,
      slot: input.slot,
      label: typeof input.label === 'string' ? input.label : undefined,
    });

    return { ok: true, audio: asset.path, asset, manifest };
  }

  async clearAudio(input = {}) {
    const p = assertSafeRelPath(input.project, '项目名');
    const m = assertSafeName(input.material, '材质名');
    const manifestPath = join(this.materialDir(p, m), MATERIAL_FILE);
    const manifest = normalizeManifest((await this.readJson(manifestPath)) ?? { name: m });
    const resources = manifest.resources ?? [];
    const removed = resources.filter((r) => r.type === 'audio');
    manifest.resources = resources.filter((r) => r.type !== 'audio');
    manifest.updatedAt = new Date().toISOString();
    await this.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { ok: true, cleared: removed[0]?.path ?? null, manifest };
  }


 // ─────────────────────── 歌词 ───────────────────────

  /**
   * 把一段歌词正文写进材质目录，并登记到清单里。
   *
   * 用固定文件名 `lyric.lrc`，所以重复导入就是替换，不会越攒越多。
   * 遵循「永不删文件」的约定：清空引用走 `clearLyric()`，不在这里动文件。
   *
   * @param {object} input { project, material, content }
   * @returns {Promise<object>}
   */
  async importLyric(input = {}) {
    const p = assertSafeRelPath(input.project, '项目名');
    const m = assertSafeName(input.material, '材质名');
    const dir = this.materialDir(p, m);
    if (!existsSync(dir)) throw new Error(`材质不存在：${p}/${m}`);

    const content = typeof input.content === 'string' ? input.content : '';
    if (content.trim() === '') throw new Error('歌词内容是空的');

    const fileName = 'lyric.lrc';
    await this.write(join(dir, fileName), content);

    // 登记进 resources[]（歌词是单例：同类型只留一份）。
    // 旧实现写顶层 `manifest.lyric`，那个字段已被 normalizeManifest 移除。
    const manifestPath = join(dir, MATERIAL_FILE);
    const manifest = normalizeManifest((await this.readJson(manifestPath)) ?? { name: m });
    const kept = (manifest.resources ?? []).filter((r) => r.type !== 'lyric');
    const asset = normalizeAsset({
      type: 'lyric',
      path: fileName,
      label: typeof input.label === 'string' ? input.label : undefined,
    });
    manifest.resources = asset ? [...kept, asset] : kept;
    manifest.updatedAt = new Date().toISOString();
    await this.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    return { ok: true, lyric: fileName, asset, bytes: content.length, manifest };
  }

/**
   * 读材质里绑定的歌词。
   *
   * **不用先登记**——文件即事实来源：
   *   1. manifest 里显式指定了 `lyric` 就用它（用于同名文件有多个时指定）
   *   2. 否则扫材质目录，找 `lyric.lrc` / `lyric.txt`
   *   3. 再找不到就取目录里唯一的 `.lrc` / `.txt`
   *
   * 找不到就返回 `{ lyric: null }`，不抛错——"这个材质没配歌词"是正常状态。
   *
   * @param {string} project
   * @param {string} material
   * @returns {Promise<{ lyric: string|null, content: string|null }>}
   */
  async readLyric(project, material) {
    const p = assertSafeRelPath(project, '项目名');
    const m = assertSafeName(material, '材质名');
    const dir = this.materialDir(p, m);
    if (!existsSync(dir)) throw new Error(`材质不存在：${p}/${m}`);

    const manifest = normalizeManifest((await this.readJson(join(dir, MATERIAL_FILE))) ?? { name: m });
    // 1) 清单里登记的 lyric 资源（resources[] 是权威）
    const registered = (manifest.resources ?? []).find(
      (r) => r.type === 'lyric' && existsSync(join(dir, r.path)),
    );
    // 2) 兜底：文件即事实来源，扫材质根目录
    const fileName = registered?.path ?? (await this._discoverFile(dir, {
      preferred: [/^lyric\.(lrc|txt)$/i],
      accepted: /\.(lrc|txt)$/i,
    }));

    if (!fileName) return { lyric: null, content: null };
    const full = join(dir, fileName);
    if (!existsSync(full)) return { lyric: null, content: null };
    return { lyric: fileName, content: await readFile(full, 'utf8') };
  }

  /**
   * 在目录里找一个符合规则的文件。
   *
   * 规则：
   *   - 优先匹配 `preferred` 里的固定名（`lyric.lrc` 比 `随便啥.lrc` 优先）
   *   - 没匹配上就取 `accepted` 里的全部候选
   *   - 候选唯一 → 用它；多个 → 按文件名排序取第一个
   *     （目录里堆了多个歌词文件本身就是少见情况，取第一个足够，
   *      真要指定就用 manifest 的 `lyric` 字段）
   *
   * @param {string} dir
   * @param {object} rules
   * @param {RegExp[]} rules.preferred
   * @param {RegExp} rules.accepted
   * @returns {Promise<string|null>}
   */
  async _discoverFile(dir, { preferred = [], accepted }) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    for (const re of preferred) {
      const hit = files.find((n) => re.test(n));
      if (hit) return hit;
    }
    const candidates = files.filter((n) => accepted.test(n)).sort();
    return candidates[0] ?? null;
  }
  /**
   * 解绑歌词：只从清单里摘掉引用，**不删文件**。
   * 用户后悔了还能在磁盘上把 lyric.lrc 找回来。
   *
   * @param {object} input { project, material }
   * @returns {Promise<object>}
   */
  async clearLyric(input = {}) {
    const p = assertSafeRelPath(input.project, '项目名');
    const m = assertSafeName(input.material, '材质名');
    const manifestPath = join(this.materialDir(p, m), MATERIAL_FILE);
    const manifest = normalizeManifest((await this.readJson(manifestPath)) ?? { name: m });
    const resources = manifest.resources ?? [];
    const removed = resources.filter((r) => r.type === 'lyric');
    manifest.resources = resources.filter((r) => r.type !== 'lyric');
    manifest.updatedAt = new Date().toISOString();
    await this.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { ok: true, cleared: removed[0]?.path ?? null, manifest };
  }
  // ─────────────────────── 预设 / 库 ───────────────────────

  /**
   * 列预设。
   * @returns {Promise<object[]>}
   */
  async listPresets() {
    const dir = this.path(DIRS.library, DIRS.presets);
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    const out = [];
    for (const entry of entries) {
      if (!entry.isFile() || extname(entry.name) !== '.json') continue;
      const data = await this.readJson(join(dir, entry.name));
      out.push({ id: basename(entry.name, '.json'), name: data?.name ?? basename(entry.name, '.json'), data });
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  /**
   * 存预设。
   * @param {object} input { id, name, data }
   * @returns {Promise<object>}
   */
  async savePreset(input = {}) {
    const id = assertSafeName(input.id ?? input.name, '预设名');
    const data = { name: input.name ?? id, data: input.data ?? {}, savedAt: new Date().toISOString() };
    await this.write(this.path(DIRS.library, DIRS.presets, `${id}.json`), `${JSON.stringify(data, null, 2)}\n`);
    return { ok: true, id, ...data };
  }

  /**
   * 读一个预设。
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async readPreset(id) {
    return this.readJson(this.path(DIRS.library, DIRS.presets, `${assertSafeName(id, '预设名')}.json`));
  }

  /**
   * 列组模板。
   *
   * 组（Group）本身是**内联**在节点里的，这里存的是"模板"：从库里拖一个组出来，
   * 它的子图会被拷进新节点的 params.graph。所以改模板不会影响已有实例。
   * @returns {Promise<object[]>}
   */
  async listGroups() {
    const dir = this.path(DIRS.library, DIRS.groups);
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    const out = [];
    for (const entry of entries) {
      if (!entry.isFile() || extname(entry.name) !== '.json') continue;
      const data = await this.readJson(join(dir, entry.name));
      out.push({
        id: basename(entry.name, '.json'),
        name: data?.name ?? basename(entry.name, '.json'),
        inputs: Array.isArray(data?.graph?.inputs) ? data.graph.inputs.length : 0,
        outputs: Array.isArray(data?.graph?.outputs) ? data.graph.outputs.length : 0,
        graph: data?.graph ?? null,
      });
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  /**
   * 存一个组模板。
   * @param {object} input { id, name, graph, doc }
   * @returns {Promise<object>}
   */
  async saveGroup(input = {}) {
    const id = assertSafeName(input.id ?? input.name, '组名');
    const graph = input.graph ?? null;
    if (graph === null || typeof graph !== 'object' || !Array.isArray(graph.nodes)) {
      throw new Error('组的 graph 必须是一个带 nodes 数组的对象');
    }
    const data = {
      name: input.name ?? id,
      doc: input.doc ?? '',
      graph,
      savedAt: new Date().toISOString(),
    };
    await this.write(this.path(DIRS.library, DIRS.groups, `${id}.json`), `${JSON.stringify(data, null, 2)}\n`);
    return { ok: true, id, ...data };
  }

  /**
   * 把编译产物写进 cache/compiled。
   * @param {string} key
   * @param {string} code
   * @returns {Promise<string>}
   */
  async writeCompiled(key, code) {
    const name = `${assertSafeName(key, '缓存名')}.frag`;
    return this.write(this.path(DIRS.cache, DIRS.compiled, name), code);
  }

  /**
   * 写一个用户节点定义到 `library/nodes/<type>.json`。
   *
   * 用户节点是**工作区级**的（所有项目共享），所以不进材质目录 ——
   * 从 Shadertoy 导入的代码就是靠这一步变成可用的节点类型。
   *
   * @param {string} type 节点类型名
   * @param {object} definition 节点定义（JSON 形状，字段与内置节点一一对应）
   * @returns {Promise<string>} 写出的完整路径
   */
  async writeUserNode(type, definition) {
    const name = assertSafeName(type, '节点名');
    return this.write(
      this.path(DIRS.library, DIRS.nodes, `${name}.json`),
      `${JSON.stringify(definition, null, 2)}\n`,
    );
  }

  /**
   * 递归列出材质目录下的全部文件（给「导出 ZIP」用）。
   *
   * @param {string} project
   * @param {string} material
   * @returns {Promise<Array<{rel:string, full:string}>>} `rel` 相对材质目录、用 `/` 分隔
   */
  async listMaterialFiles(project, material) {
    const root = this.materialDir(project, material);
    const out = [];
    const walk = async (dir, prefix) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // 目录不存在就当空
      }
      for (const entry of entries) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full, rel);
        else if (entry.isFile()) out.push({ rel, full });
      }
    };
    await walk(root, '');
    // 固定顺序，让同样的材质产出逐字节相同的 zip（测试可以直接比字节）
    out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    return out;
  }

  /**
   * 工作区概览，给 UI 首屏用。
   * @returns {Promise<object>}
   */
  async overview() {
    const projects = await this.listProjects();
    let materialCount = 0;
    for (const project of projects) {
      materialCount += (await this.listMaterials(project.name)).length;
    }
    return {
      root: this.root,
      readOnly: this.readOnly,
      projects,
      materialCount,
      library: {
        presets: (await this.listPresets()).length,
      },
    };
  }
}
