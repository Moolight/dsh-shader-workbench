/**
 * 本地资源浏览器：项目 / 材质 / 纹理 / 快照。
 *
 * 所有文件操作都通过 Host 的 HTTP API（`/plugins/dsh-shader-workbench/api`）走，
 * 面板自己**不碰磁盘**。这是需求书第 2 节「所有文件操作走 Host 服务」的落实。
 *
 * @module dsh-shader-workbench/client/panel/resources
 */

import { badge, button, divider, empty, h, menuItem, popup, section, timeAgo } from './dom.js';
import { GRAPH_FILE, MATERIAL_FILE } from '../../shared/manifest.js';

/**
 * 资源浏览器。
 */
export class ResourceBrowser {
  /**
   * @param {object} opts
   * @param {(action: string, args?: object) => Promise<any>} opts.call Host API 调用
   * @param {object} opts.handlers 各个动作的回调
   *   - `onOpen(project, material)`：打开材质
   *   - `onSaved()`：外部需要刷新时
   *   - `onImportTexture(project, material, file, slot)`：导入纹理
   * @param {() => object} [opts.getCurrent] 取当前打开的 { project, material }
   */
  constructor(opts) {
    this.call = opts.call;
    this.handlers = opts.handlers ?? {};
    this.getCurrent = opts.getCurrent ?? (() => ({}));
    this.overview = null;
    this.expanded = new Set();
    /** 多级分组的展开状态（项目名带 / 时按斜杠分组） */
    this.expandedFolders = new Set();
    this.materials = new Map();
    this.root = h('div.swb-res');
    this.status = h('div.swb-res__status');
    this.body = h('div.swb-res__body');
    this.root.append(this.body, this.status);
    this.reload();
  }

  /** 拉一次工作区概览。 */
  async reload() {
    try {
      this.overview = await this.call('workspace.overview');
      // 顺带把「存储位置」那一层读回来：它是用户能在面板里改的唯一一处设置
      try {
        this.settings = await this.call('settings.read');
      } catch (error) {
        this.settings = { error: messageOf(error) };
      }
      this.materials.clear();
      // 注意：material.list 的返回是 { materials: [...] }，不是裸数组
      for (const project of this.overview.projects ?? []) {
        const result = await this.call('material.list', { project: project.name });
        this.materials.set(project.name, Array.isArray(result?.materials) ? result.materials : []);
      }
      // 有材质的项目默认展开：新用户第一次打开就能看见材质，不用先点一下
      const projects = this.overview.projects ?? [];
      if (this.expanded.size === 0 && projects.length > 0) {
        for (const project of projects) {
          if ((this.materials.get(project.name) ?? []).length > 0) this.expanded.add(project.name);
        }
      }
      this._setStatus(`工作区：${this.overview.root}（${this._totalMaterials()} 个材质）`);
      this.render();
    } catch (error) {
      this._setStatus(`读取工作区失败：${messageOf(error)}`, 'error');
      this.body.replaceChildren(empty('读取工作区失败', [h('p.swb-hint', { text: messageOf(error) })]));
    }
  }

  /** 材质总数。 */
  _totalMaterials() {
    let total = 0;
    for (const list of this.materials.values()) total += list.length;
    return total;
  }

  /** 重建 UI。 */
  render() {
    const overview = this.overview;
    if (!overview) {
      this.body.replaceChildren(empty('正在读取工作区…'));
      return;
    }
    const projects = overview.projects ?? [];
    const current = this.getCurrent();

    const tree = h('div.swb-tree');
    if (projects.length === 0) {
      tree.append(
        empty('还没有项目', [
          button('新建第一个项目', () => this._promptCreateProject(), { variant: 'primary' }),
          button('载入示例', (e) => this._promptLoadExample(e), { variant: 'ghost' }),
        ]),
      );
    }
    for (const node of this._projectTree(projects, current)) tree.append(node);

    this.body.replaceChildren(
      h('div.swb-res__toolbar', {}, [
        button('新建项目', () => this._promptCreateProject(), { variant: 'ghost' }),
        button('载入示例', (e) => this._promptLoadExample(e), { variant: 'ghost', title: '把插件自带的示例拷进当前工作区' }),
        button('刷新', () => this.reload(), { variant: 'ghost' }),
      ]),
      this._storageBar(),
      tree,
    );
  }

  /**
   * 载入插件自带的示例。
   *
   * 示例随插件包走（`examples/<名字>/`），所以换机器、重装 profile、
   * 或者把存储位置改到别处，示例都还在。已存在时会问一句要不要覆盖。
   *
   * @param {Event} [event] 用来定位弹出菜单
   */
  async _promptLoadExample(event) {
    let examples = [];
    try {
      const result = await this.call('example.list');
      examples = Array.isArray(result?.examples) ? result.examples : [];
    } catch (error) {
      this._setStatus(`读示例列表失败：${messageOf(error)}`, 'error');
      return;
    }
    if (examples.length === 0) {
      this._setStatus('插件里没有自带示例', 'info');
      return;
    }

    /** 真去载入一个示例。 */
    const load = async (example, overwrite = false) => {
      try {
        const result = await this.call('example.load', { name: example.name, overwrite });
        const lib = (result.library ?? []).length;
        this._setStatus(
          `已载入示例 ${result.project}（${(result.materials ?? []).join(', ') || '无材质'}）` +
            (lib > 0 ? `，附带 ${lib} 个用户节点` : ''),
          'ok',
        );
        // 示例可能自带用户节点（如 ifsTunnel / fourierSeries），刚装进工作区 ——
        // 面板得同步一次节点库，否则本地库里没有它，
        // 一打开就报「不认识的节点类型」。（就是"加节点不用重启"那条路）
        if (lib > 0) await this.handlers.onNodeLibraryChanged?.();
        this.expanded.add(result.project);
        await this.reload();
        const first = result.materials?.[0];
        if (first) this.handlers.onOpen?.(result.project, first);
      } catch (error) {
        if (error?.code === 'example-exists' || /已经存在/.test(messageOf(error))) {
          if (window.confirm(`${example.name} 已经存在，用示例覆盖掉当前这一份？`)) await load(example, true);
          else this._setStatus('已取消', 'info');
          return;
        }
        this._setStatus(`载入示例失败：${messageOf(error)}`, 'error');
      }
    };

    if (examples.length === 1) {
      await load(examples[0]);
      return;
    }
    const items = examples.map((example) =>
      menuItem(`${example.name} — ${example.title}`, () => load(example)),
    );
    const rect = event?.currentTarget?.getBoundingClientRect?.();
    popup(items, rect ? rect.left : 240, rect ? rect.bottom + 4 : 120);
  }

  /**
   * 存储位置那一行。
   *
   * 为什么要放在这儿：工作区根目录以前只能改 profile 的 `cordis.patch.yml`，
   * 而且没有配置时**面板和 agent 各算各的** —— agent 把材质写进 A，
   * 用户在面板里看到的是 B（空的），于是资源树永远空、一堆按钮点了没反应。
   * 现在这里能直接改，改完两边都认（落到 `<DSH_HOME>/shader-workbench.json`）。
   *
   * @returns {Element}
   */
  _storageBar() {
    const info = this.settings ?? {};
    const root = info.root ?? this.overview?.root ?? '(未知)';
    const saved = info.settings?.workspaceRoot;
    const overridden = info.overriddenBy;

    const children = [
      h('span.swb-res__rootlabel', { text: '存储位置' }),
      h('code.swb-res__rootpath', { text: root, title: root }),
    ];

    if (overridden === 'config') {
      children.push(badge('来自插件配置', 'warn'));
    } else if (overridden === 'env') {
      children.push(badge('来自环境变量', 'warn'));
    } else if (!saved) {
      children.push(badge('自动推断', 'muted'));
    }

    const tools = h('div.swb-res__roottools', {}, [
      button('更改', () => this._promptStorageRoot(), { variant: 'ghost', title: '换一个存储位置（绝对路径）' }),
      button('复制路径', () => this._copyStorageRoot(root), { variant: 'ghost' }),
    ]);
    if (saved) {
      tools.append(button('重置', () => this._resetStorageRoot(), { variant: 'ghost', title: '清掉手动设置，回到自动推断' }));
    }

    return h('div.swb-res__root', {}, [h('div.swb-res__roothead', {}, children), tools]);
  }

  /** 改存储位置。 */
  async _promptStorageRoot() {
     this.dialogHost?.remove();
    const info = this.settings ?? {};
    const current = info.settings?.workspaceRoot ?? info.root ?? '';

    const input = h('input.swb-input.swb-dialog__input', {
      type: 'text',
      value: current,
      placeholder: 'D:\\Projects\\DSHP\\shader-workbench',
      spellcheck: 'false',
    });

    const close = () => {
      this.dialogHost?.remove();
      this.dialogHost = null;
    };

    const commit = async () => {
      const value = input.value.trim();
      if (value === '') {
        this._setStatus('已取消（路径为空）', 'info');
        close();
        return;
      }
      close();
      try {
        const result = await this.call('settings.write', { workspaceRoot: value });
        this._setStatus(`存储位置已改为 ${result.root}`, 'ok');
        await this.reload();
        this.handlers.onWorkspaceChanged?.(result.root);
      } catch (error) {
        this._setStatus(`改存储位置失败：${messageOf(error)}`, 'error');
      }
    };

    const host = h('div.swb-dialog', {}, [
      h('div.swb-snap__head', {}, [
        h('strong', { text: '更改存储位置' }),
        button('关闭', close, { variant: 'ghost' }),
      ]),
      h('div.swb-hint', {
        text: '必须是绝对路径。工作区目录会在第一次写入时自动创建。',
      }),
      input,
      h('div.swb-dialog__actions', {}, [
        button('确定', () => void commit(), { variant: 'primary' }),
        button('取消', close, { variant: 'ghost' }),
      ]),
    ]);

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    });

    this.dialogHost = host;
    this.root.append(host);
    input.focus();
    input.select?.();
  }

  /** 清掉手动设置。 */
  async _resetStorageRoot() {
    try {
      const result = await this.call('settings.write', { workspaceRoot: '' });
      this._setStatus(`已重置，现在用 ${result.root}`, 'ok');
      await this.reload();
      this.handlers.onWorkspaceChanged?.(result.root);
    } catch (error) {
      this._setStatus(`重置失败：${messageOf(error)}`, 'error');
    }
  }

  /** 浏览器打不开资源管理器，就先把路径递到剪贴板。 */
  _copyStorageRoot(root) {
    navigator.clipboard?.writeText(root).then(
      () => this._setStatus(`路径已复制：${root}`, 'ok'),
      () => this._setStatus(`存储位置：${root}`, 'info'),
    );
  }

  /**
   * 项目列表 → **多级树**。
   *
   * 项目名可以带斜杠（`傅里叶/series`），于是磁盘上就是
   * `<工作区>/projects/傅里叶/series/`，面板这边按 `/` 分组渲染。
   * 分组纯客户端推导 —— 不用给宿主加一套"文件夹"接口，
   * 目录本身就是事实来源。
   *
   * @param {object[]} projects
   * @param {object} current
   * @returns {Node[]}
   */
  _projectTree(projects, current) {
    /** 顶层分组名 → 该组下的项目（可能还有子组）。 */
    const groups = new Map();
    const roots = [];
    for (const project of projects) {
      const parts = String(project.name).split('/').filter(Boolean);
      if (parts.length <= 1) {
        roots.push(project);
        continue;
      }
      let level = groups;
      let path = '';
      for (let i = 0; i < parts.length - 1; i += 1) {
        path = path ? `${path}/${parts[i]}` : parts[i];
        if (!level.has(path)) level.set(path, { name: parts[i], path, groups: new Map(), projects: [] });
        const node = level.get(path);
        if (i === parts.length - 2) node.projects.push(project);
        level = node.groups;
      }
    }

    const out = [];
    /** 递归渲染一层：先分组，再项目（都按名字排）。 */
    const emit = (groupMap, projectList, depth) => {
      const items = [
        ...[...groupMap.values()].map((g) => ({ kind: 'group', g })),
        ...projectList.map((p) => ({ kind: 'project', p })),
      ].sort((a, b) => {
        const an = a.kind === 'group' ? a.g.name : a.p.name;
        const bn = b.kind === 'group' ? b.g.name : b.p.name;
        return an.localeCompare(bn);
      });
      for (const item of items) {
        if (item.kind === 'project') {
          out.push(this._projectRow(item.p, current, depth));
          if (this.expanded.has(item.p.name)) out.push(this._materialList(item.p, current));
          continue;
        }
        const open = this.expandedFolders.has(item.g.path);
        out.push(
          h(
            'div.swb-tree__row.swb-tree__row--folder',
            {
              style: `padding-left:${6 + depth * 12}px`,
              on: {
                click: () => {
                  if (open) this.expandedFolders.delete(item.g.path);
                  else this.expandedFolders.add(item.g.path);
                  this.render();
                },
              },
            },
            [
              h('span.swb-tree__caret', { text: open ? '▾' : '▸' }),
              h('span.swb-tree__name', { text: `📁 ${item.g.name}` }),
              badge(String(this._countProjects(item.g)), 'muted'),
            ],
          ),
        );
        if (open) emit(item.g.groups, item.g.projects, depth + 1);
      }
    };
    emit(groups, roots, 0);
    return out;
  }

  /** 一个分组下（含子分组）一共有多少项目。 */
  _countProjects(group) {
    let n = group.projects.length;
    for (const sub of group.groups.values()) n += this._countProjects(sub);
    return n;
  }

  /** 项目一行。 */
  _projectRow(project, current, depth = 0) {
    const open = this.expanded.has(project.name);
    const materials = this.materials.get(project.name) ?? [];
    const row = h('div.swb-tree__row', {
      style: `padding-left:${6 + depth * 12}px`,
      class: current.project === project.name ? 'swb-tree__row--current' : undefined,
      on: {
        click: () => {
          if (open) this.expanded.delete(project.name);
          else this.expanded.add(project.name);
          this.render();
        },
        contextmenu: (e) => {
          e.preventDefault();
          popup(
            [
              menuItem('在这个项目里新建材质', () => this._promptCreateMaterial(project.name)),
              menuItem('打一个项目快照（对所有材质）', () => this._snapshotProject(project.name)),
              h('div.swb-menu__sep'),
              menuItem('在文件管理器中打开', () => this._revealProject(project.name)),
            ],
            e.clientX,
            e.clientY,
          );
        },
      },
    }, [
      h('span.swb-tree__caret', { text: open ? '▾' : '▸' }),
      h('span.swb-tree__name', { text: project.title || project.name }),
      badge(String(materials.length), 'muted'),
    ]);
    return row;
  }

  /** 某项目下的材质列表。 */
  _materialList(project, current) {
    const materials = this.materials.get(project.name) ?? [];
    const box = h('div.swb-tree__children');
    box.append(
      h('div.swb-tree__row.swb-tree__row--action', {
        on: { click: () => this._promptCreateMaterial(project.name) },
      }, [h('span.swb-tree__caret', { text: '＋' }), h('span.swb-tree__name', { text: '新建材质' })]),
    );
    if (materials.length === 0) {
      box.append(h('div.swb-tree__hint', { text: '这个项目还没有材质' }));
      return box;
    }
    for (const material of materials) {
      box.append(this._materialRow(project, material, current));
    }
    return box;
  }

  /** 材质一行。 */
  _materialRow(project, material, current) {
    const active = current.project === project.name && current.material === material.name;
     const resourceCount = material.resourceCount ?? 0;
    const row = h('div.swb-tree__row.swb-tree__row--material', {
      class: active ? 'swb-tree__row--current' : undefined,
      title: material.updatedAt ? `更新于 ${timeAgo(material.updatedAt)}` : material.name,
      on: {
        click: () => this.handlers.onOpen?.(project.name, material.name),
        contextmenu: (e) => {
          e.preventDefault();
          this._materialMenu(e, project.name, material.name);
        },
      },
    }, [
     h('span.swb-tree__caret', { text: resourceCount > 0 ? `${resourceCount}▣` : '▢' }),
      h('span.swb-tree__name', { text: material.title || material.name }),
    ]);
    return row;
  }

  /** 材质右键菜单。 */
  _materialMenu(e, project, material) {
    const items = [
      menuItem('打开', () => this.handlers.onOpen?.(project, material)),
      menuItem('保存当前图到这个材质', () => this.handlers.onSaveTo?.(project, material)),
      h('div.swb-menu__sep'),
      menuItem('导出为…', () => this._exportMenu(project, material, e.clientX, e.clientY)),
      menuItem('导出 ZIP…', () => this._exportZip(project, material)),
      h('div.swb-menu__sep'),
      menuItem('打快照', () => this._snapshot(project, material)),
      menuItem('查看快照…', () => this._showSnapshots(project, material)),
      h('div.swb-menu__sep'),
      menuItem('导入纹理…', () => this._pickTexture(project, material)),
      menuItem('导入材质文件…', () => this._importMaterial(project, material)),
      menuItem('从 Shadertoy 导入…', () => this._importShadertoy(project, material)),
      h('div.swb-menu__sep'),
      menuItem('归档到 .trash（不删除）', () => this._archive(project, material), { tone: 'danger' }),
    ];
    popup(items, e.clientX, e.clientY);
  }

  /**
   * 导出格式的子菜单。
   *
   * 目标列表是**问 host 要**的，不写死 —— 导出目标走的是注册机制，
   * 面板这边写死一份就会和实际能力脱节（以后加目标还得改两处）。
   */
  async _exportMenu(project, material, x, y) {
    try {
      const { targets } = await this.call('material.exportTargets', {});
      const items = targets.map((t) => menuItem(
        `${t.label}  (.${t.extension})`,
        () => this._export(project, material, t),
      ));
      popup(items, x, y);
    } catch (error) {
      this._setStatus(`取导出目标失败：${messageOf(error)}`, 'error');
    }
  }

  /** 真导出一次。产物落在材质目录里；二进制顺手触发一次下载。 */
  async _export(project, material, target) {
    try {
      const res = await this.call('material.export', { project, material, target: target.id });
      if (target.binary) {
        const bytes = Uint8Array.from(atob(res.data), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = res.fileName;
        link.click();
        URL.revokeObjectURL(url);
        this._setStatus(`已导出 ${res.fileName}（${res.bytes} 字节）→ ${res.path}`, 'ok');
      } else {
        this._setStatus(`已导出 ${res.fileName} → ${res.path}`, 'ok');
      }
    } catch (error) {
      this._setStatus(`导出失败：${messageOf(error)}`, 'error');
    }
  }

  /**
   * 把整个材质目录打包下载。
   *
   * 打包在 host 那侧做（零依赖自研 ZIP，store 模式），面板只负责把 base64
   * 还原成字节再触发下载 —— 这样「打包」这件事只有一份实现。
   */
  async _exportZip(project, material) {
    try {
      const res = await this.call('material.exportZip', { project, material });
      this._download(res.data, res.fileName, 'application/zip');
      const where = res.path ? ` → ${res.path}` : '（只读工作区，没有落盘）';
      this._setStatus(`已导出 ${res.fileName}：${res.fileCount} 个条目 / ${res.bytes} 字节${where}`, 'ok');
    } catch (error) {
      this._setStatus(`导出 ZIP 失败：${messageOf(error)}`, 'error');
    }
  }

  /** 从 base64 触发一次浏览器下载。 */
  _download(base64, fileName, mime = 'application/octet-stream') {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    // 立刻 revoke 在部分浏览器里会打断下载，挪到下一帧
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  /**
   * 从 Shadertoy 源码导入。
   *
   * 用 textarea 而不是 `window.prompt`：Shadertoy 的代码是几百行的多行文本，
   * prompt 是单行的，粘进去就废了。
   *
   * 导入会**替换**当前材质的图，所以先弹一句确认。
   */
  _importShadertoy(project, material) {
    this.dialogHost?.remove();
    const area = h('textarea.swb-input.swb-dialog__text', {
      spellcheck: 'false',
      placeholder: '把 Shadertoy 的源码整段粘进来（要包含 void mainImage(out vec4 fragColor, in vec2 fragCoord)）',
    });
    const urlInput = h('input.swb-input.swb-dialog__input', { type: 'text', placeholder: '来源链接（可留空）' });
    const close = () => {
      this.dialogHost?.remove();
      this.dialogHost = null;
    };
    const host = h('div.swb-dialog', {}, [
      h('div.swb-snap__head', {}, [
        h('strong', { text: `从 Shadertoy 导入 → ${project} / ${material}` }),
        button('关闭', close, { variant: 'ghost' }),
      ]),
      h('div.swb-hint', { text: '导入会替换这个材质当前的节点图（先打快照可以找回）。' }),
      area,
      urlInput,
      h('div.swb-dialog__actions', {}, [
        button('导入', async () => {
          const source = area.value ?? '';
          if (source.trim() === '') {
            this._setStatus('源码是空的', 'error');
            return;
          }
          try {
            const res = await this.call('material.importShadertoy', {
              project,
              material,
              source,
              ...(urlInput.value.trim() ? { sourceUrl: urlInput.value.trim() } : {}),
            });
            close();
            await this.reload();
            this.handlers.onRestored?.(project, material);
            const feats = res.features ?? {};
            const bits = [];
            if (feats.channels?.length) bits.push(`通道 ${feats.channels.join('/')}`);
            if (feats.buffers?.length) bits.push(`Buffer ${feats.buffers.join('/')}`);
            const warnings = res.warnings ?? [];
            this._setStatus(
              `已导入为节点 ${res.nodeType}${bits.length ? `（用到 ${bits.join('，')}）` : ''}`
              + (warnings.length ? `；提醒：${warnings.join(' / ')}` : ''),
              warnings.length > 0 ? 'info' : 'ok',
            );
          } catch (error) {
            this._setStatus(`导入失败：${messageOf(error)}`, 'error');
          }
        }),
        button('取消', close, { variant: 'ghost' }),
      ]),
    ]);
    this.dialogHost = host;
    this.root.append(host);
    area.focus();
  }

  // ─────────────────────── 动作 ───────────────────────

  /** 新建项目。 */
  async _promptCreateProject() {
    const name = window.alert('项目名（字母/数字/下划线/连字符）');
    if (!name) return;
    try {
      await this.call('project.create', { name: name.trim() });
      this.expanded.add(name.trim());
      await this.reload();
      this._setStatus(`已建项目 ${name.trim()}`, 'ok');
    } catch (error) {
      this._setStatus(`建项目失败：${messageOf(error)}`, 'error');
    }
  }

  /** 新建材质。 */
  async _promptCreateMaterial(project) {
    const name = window.alert(`在「${project}」里新建材质，名字：`);
    if (!name) return;
    try {
      await this.call('material.create', { project, name: name.trim() });
      this.expanded.add(project);
      await this.reload();
      this.handlers.onOpen?.(project, name.trim());
      this._setStatus(`已建材质 ${name.trim()}`, 'ok');
    } catch (error) {
      this._setStatus(`建材质失败：${messageOf(error)}`, 'error');
    }
  }

  /** 打快照。 */
  async _snapshot(project, material) {
    try {
      const label = window.alert('快照标签（可留空）') ?? '';
      const result = await this.call('material.snapshot', { project, material, label: label.trim() });
      this._setStatus(`已打快照 ${result.id}`, 'ok');
    } catch (error) {
      this._setStatus(`打快照失败：${messageOf(error)}`, 'error');
    }
  }

  /** 项目级快照。 */
  async _snapshotProject(project) {
    const materials = this.materials.get(project) ?? [];
    if (materials.length === 0) {
      this._setStatus('这个项目没有材质', 'error');
      return;
    }
    let done = 0;
    for (const material of materials) {
      try {
        await this.call('material.snapshot', { project, material: material.name, label: 'project-batch' });
        done += 1;
      } catch {
        // 单个失败不打断
      }
    }
    this._setStatus(`已给 ${done}/${materials.length} 个材质打快照`, done === materials.length ? 'ok' : 'error');
  }

  /** 列出并选择快照。 */
  async _showSnapshots(project, material) {
    try {
      const result = await this.call('material.snapshots', { project, material });
      const list = result.snapshots ?? [];
      if (list.length === 0) {
        this._setStatus('这个材质还没有快照', 'error');
        return;
      }
      this.snapshotHost?.remove();
      const rows = list.map((snap) =>
        h('div.swb-snap__row', {}, [
          h('div.swb-snap__meta', {}, [
            h('code', { text: snap.id }),
            h('span.swb-hint', { text: timeAgo(snap.createdAt) }),
          ]),
          button('回滚', async () => {
            if (!window.confirm(`回滚到 ${snap.id}？当前状态会先自动存一份快照。`)) return;
            try {
              await this.call('material.restore', { project, material, snapshotId: snap.id });
              this.snapshotHost?.remove();
              this._setStatus('已回滚', 'ok');
              this.handlers.onRestored?.(project, material);
            } catch (error) {
              this._setStatus(`回滚失败：${messageOf(error)}`, 'error');
            }
          }, { variant: 'ghost' }),
        ]),
      );
      this.snapshotHost = h('div.swb-snap', {}, [
        h('div.swb-snap__head', {}, [
          h('strong', { text: `${project} / ${material} 的快照` }),
          button('关闭', () => {
            this.snapshotHost?.remove();
            this.snapshotHost = null;
          }, { variant: 'ghost' }),
        ]),
        ...rows,
      ]);
      this.root.append(this.snapshotHost);
    } catch (error) {
      this._setStatus(`读快照失败：${messageOf(error)}`, 'error');
    }
  }

  /** 归档材质。 */
  async _archive(project, material) {
    if (!window.confirm(`把「${material}」移到 .trash？\n不会真的删除，之后可以从 .trash 里找回来。`)) return;
    try {
      const result = await this.call('material.archive', { project, material });
      await this.reload();
      this._setStatus(`已移到 ${result.movedTo}`, 'ok');
    } catch (error) {
      this._setStatus(`归档失败：${messageOf(error)}`, 'error');
    }
  }

  /** 在文件管理器中打开项目目录（借助浏览器打不开，只给提示）。 */
  _revealProject(project) {
    const root = this.overview?.root ?? '';
    const hint = `${root}\\projects\\${project}`;
    navigator.clipboard?.writeText(hint).then(
      () => this._setStatus(`路径已复制到剪贴板：${hint}`, 'ok'),
      () => this._setStatus(`项目目录：${hint}`, 'info'),
    );
  }

  /** 选一张图导入。 */
  _pickTexture(project, material) {
    const input = h('input', { type: 'file', accept: 'image/*,.dds,.ktx,.ktx2,.hdr', style: { display: 'none' } });
    document.body.append(input);
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return;
      const slot = window.alert('绑定到哪个通道？iChannel0 / iChannel1 / iChannel2 / iChannel3', 'iChannel0');
      if (!slot) return;
      await this.handlers.onImportTexture?.(project, material, file, slot.trim());
    });
    input.click();
  }

  /**
   * 导入材质文件：从磁盘上选 graph.json / material.json / shader.frag，
   * 在同一个材质目录里还原出来。这是 M3 的「导入」能力。
   */
  _importMaterial(project, material) {
    const input = h('input', {
      type: 'file',
      multiple: 'true',
      accept: '.json,.frag,.glsl',
      style: { display: 'none' },
    });
    document.body.append(input);
    input.addEventListener('change', async () => {
      const files = [...(input.files ?? [])];
      input.remove();
      if (files.length === 0) return;
      let graph = null;
      let manifestPatch = null;
      const shaders = [];
      for (const file of files) {
        const text = await file.text();
        const lower = file.name.toLowerCase();
        if (lower.endsWith('.json')) {
          try {
            const parsed = JSON.parse(text);
            if (parsed && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) graph = parsed;
            else if (parsed && typeof parsed === 'object' && ('graphPath' in parsed || 'shaderFiles' in parsed)) manifestPatch = parsed;
          } catch (error) {
            this._setStatus(`${file.name} 不是合法 JSON：${messageOf(error)}`, 'error');
            return;
          }
        } else {
          shaders.push({ name: file.name, text });
        }
      }
      if (!graph && !manifestPatch) {
        this._setStatus('没找到可用的 graph.json 或 material.json', 'error');
        return;
      }
      try {
        await this.call('material.save', {
          project,
          material,
          graph: graph ?? undefined,
          manifest: manifestPatch ?? undefined,
        });
        for (const shader of shaders) {
          this.handlers.onImportedShader?.(project, material, shader.name, shader.text);
        }
        this._setStatus(`已导入 ${files.length} 个文件`, 'ok');
        this.handlers.onRestored?.(project, material);
      } catch (error) {
        this._setStatus(`导入失败：${messageOf(error)}`, 'error');
      }
    });
    input.click();
  }

  /** 状态行。 */
  _setStatus(text, tone = 'info') {
    this.status.textContent = text;
    this.status.dataset.tone = tone;
  }
}

/**
 * 从任意错误里抠出可读信息。
 * @param {any} error
 * @returns {string}
 */
export function messageOf(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  return error.error?.message ?? error.message ?? JSON.stringify(error);
}

export { section, divider, GRAPH_FILE, MATERIAL_FILE };
