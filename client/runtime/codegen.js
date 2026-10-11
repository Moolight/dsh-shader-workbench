/**
 * 节点图 → GLSL 代码生成器。
 *
 * 纯函数、零依赖、**不碰 WebGL**：可以放进 Node 里单测，
 * 也可以在浏览器里给热重载用。这是 M1 的核心。
 *
 * 生成规则：
 *  - 从 Pass 的输出节点（type `output`）反向深度优先遍历，每个节点落一行 GLSL 语句。
 *  - 语句形如 `vec3 n3 = <表达式>;`，变量名由节点 id 派生并保证合法唯一。
 *  - 同一节点被多个下游引用时只算一次（DFS 记忆化）；成环直接报错。
 *  - 端口类型不匹配时自动转换：float→vecN 广播，vecN→float 取 `.x`，vecN→vecM 截断补零。
 *
 * @module dsh-shader-workbench/client/runtime/codegen
 */

import { NODE_BY_TYPE, resolveHelpers, renderHelpers, resolvePorts } from '../../shared/nodes.js';
import { PORT_TYPES, passSubgraph } from '../../shared/graph.js';

/** 各类型的零值字面量。 */
const ZERO = { float: '0.0', vec2: 'vec2(0.0)', vec3: 'vec3(0.0)', vec4: 'vec4(0.0)' };

/** 各类型的分量名。 */
const COMPONENTS = {
  float: ['x'],
  vec2: ['x', 'y'],
  vec3: ['x', 'y', 'z'],
  vec4: ['x', 'y', 'z', 'w'],
};

/**
 * 把 JS 值序列化成 GLSL 字面量。
 * @param {any} value
 * @param {string} type 目标 GLSL 类型
 * @returns {string}
 */
export function glslLiteral(value, type) {
  const num = (n) => {
    const x = Number(n);
    if (!Number.isFinite(x)) return '0.0';
    if (Number.isInteger(x) && Math.abs(x) < 1e16) return `${x}.0`;
    return String(x);
  };

  if (value === undefined || value === null) return ZERO[type] ?? '0.0';

  if (type === 'float') {
    if (Array.isArray(value)) return num(value[0] ?? 0);
    return num(value);
  }

  const size = Number(type.slice(3));
  let arr;
  if (Array.isArray(value)) arr = value;
  else if (typeof value === 'number') arr = [value];
  else arr = [];

  const out = [];
  for (let i = 0; i < size; i++) {
    // 分量不足时：第 4 位补 1（alpha 默认不透明），其余补 0
    const fallback = i === 3 && size === 4 ? 1 : 0;
    out.push(num(arr[i] ?? fallback));
  }
  return `${type}(${out.join(', ')})`;
}

/**
 * 把表达式从 `from` 类型转成 `to` 类型。
 * @param {string} expr
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
export function castExpr(expr, from, to) {
  if (from === to) return expr;
  if (!PORT_TYPES.includes(from) || !PORT_TYPES.includes(to)) return expr;

  const fromComps = COMPONENTS[from];
  const toComps = COMPONENTS[to];

  // 标量 → 向量：广播
  if (from === 'float') return `${to}(${expr})`;

  // 向量 → 标量：取 x
  if (to === 'float') return `(${expr}).x`;

  // 向量 → 向量：截断或补位。
  // 补位规则：第 4 位（alpha）补 1.0，其余补 0.0。
  // 这条很关键——vec3 颜色提升成 vec4 时如果 alpha 补 0，画面会全透明。
  const used = fromComps.slice(0, toComps.length);
  const parts = used.map((c) => `(${expr}).${c}`);
  while (parts.length < toComps.length) {
    parts.push(toComps[parts.length] === 'w' ? '1.0' : '0.0');
  }
  return `${to}(${parts.join(', ')})`;
}

/**
 * 把节点 id 变成一个合法且稳定的 GLSL 变量名。
 * @param {string} id
 * @returns {string}
 */
function varName(id) {
  // GLSL 保留「含连续下划线」的标识符（`a__b` 直接编译不过），所以把替换产生的
  // `__` 压成一个 `_`。**组展开最容易踩这个**：子图 id 要加前缀，落到变量名里
  // 一旦出现连续下划线，真机上就是一片红。
  const safe = String(id)
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_');
  return /^[A-Za-z_]/.test(safe) ? `n_${safe}` : `n_v${safe}`;
}

/**
 * 一个 Pass 的编译上下文。
 */
class Emitter {
  /**
   * @param {object} graph 归一化后的完整图
   * @param {string} passName
   * @param {object} opts { uniforms }
   */
  constructor(graph, passName, opts) {
    this.graph = graph;
    this.passName = passName;
    this.uniforms = opts.uniforms ?? {};
    this.nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
    /**
     * 连线表。
     *
     * 刻意是**自己的一份拷贝**，不是 `graph.edges` 的引用：展开组（group）的时候
     * 要把子图的连线并进来，直接 push 到调用方的图上会污染他手里的数据。
     */
    this.edges = [...(graph.edges ?? [])];
    /**
     * 展开组时登记的「组输入 → 外层表达式」。
     * key 是**加了前缀之后**的子图节点 id。
     * @type {Map<string, {expr:string, type:string}>}
     */
    this.inputOverrides = new Map();
    /** 已经展开过的组节点 id，避免重复并表。 */
    this.expandedGroups = new Set();
    /** 组嵌套深度，防止组套组套到自己。 */
    this.groupDepth = 0;
    /** 重复组：节点 id → 各输出端口对应的 carry 变量名（循环只吐一次） */
    this.repeatCarryVars = new Map();
    /** 当前所在的循环变量名（loopIndex 节点读它） */
    this.loopVars = [];
    /** 节点 id → 它的输出表达式（缓存） */
    this.outExpr = new Map();
    /** 正在访问中的节点 id，用于成环检测 */
    this.visiting = new Set();
    /** 已产出的语句 */
    this.lines = [];
    /** 用到的 helper 名 */
    this.helpers = new Set();
    /** 用到的 glslPrelude 片段（按节点类型去重） */
    this.preludes = new Map();
    /** 用到的 iChannel 槽位 */
    this.channels = new Set();
    /** 用到的 Buffer 采样 */
    this.buffers = new Set();
    /**
     * 隐式发现的 uniform：图里用了「自定义参数」节点但图级 uniforms[] 没声明它。
     * 值是 GLSL 初始化表达式。自动补声明，而不是生成一段编译不过的代码。
     * @type {Map<string, string>}
     */
    this.inferredUniforms = new Map();
    /** 诊断 */
    this.errors = [];
    this.warnings = [];
  }

  /**
   * 取某节点某输出端口的表达式（必要时递归生成上游语句）。
   * @param {string} nodeId
   * @param {string} portId
   * @returns {string}
   */
  expr(nodeId, portId) {
    // 缓存键必须带端口：split / group 这类多输出节点，同一个节点不同端口
    // 表达式是不同的。以前只按 nodeId 缓存，多输出节点第二个端口会拿到第一个的结果。
    const key = `${nodeId}\u0000${portId}`;
    const cached = this.outExpr.get(key);
    if (cached !== undefined) return cached;

    if (this.visiting.has(nodeId)) {
      this.errors.push({ code: 'cycle', message: `节点图存在环路，节点 ${nodeId} 被自己依赖` });
      return ZERO.float;
    }

    const node = this.nodeById.get(nodeId);
    if (!node) {
      this.errors.push({ code: 'missing-node', message: `连线指向了不存在的节点 ${nodeId}` });
      return ZERO.float;
    }

    const def = NODE_BY_TYPE.get(node.type);
    if (!def) {
      this.errors.push({ code: 'unknown-node', message: `不认识的节点类型：${node.type}` });
      return ZERO.float;
    }

    this.visiting.add(nodeId);
    try {
      const built = this.buildNode(node, def, portId);
      this.outExpr.set(key, built);
      return built;
    } finally {
      this.visiting.delete(nodeId);
    }
  }

  /**
   * 生成一个节点的表达式，需要时把语句推进 this.lines。
   * @param {object} node
   * @param {object} def
   * @param {string} portId 下游要取哪个输出端口
   * @returns {string}
   */
  buildNode(node, def, portId) {
    for (const h of def.helpers ?? []) this.helpers.add(h);
    if (def.glslPrelude) this.preludes.set(node.type, def.glslPrelude);

    // 组输入：表达式由外层喂进来（展开组的时候登记好的）
    const override = this.inputOverrides.get(node.id);
    if (override !== undefined) return override.expr;
    if (node.type === 'groupInput') {
      // 没被展开过 = 它被放在了组外面，这个位置没有「外面」可以接
      this.errors.push({
        code: 'group-input-outside',
        message: `「组输入」节点只能在组里面用（${node.id}）；画布上的组是 type 为 group 的那个节点`,
      });
      return ZERO.float;
    }

    // 组：把子图内联展开（`repeat > 1` 时会在外面套一层 for 循环）
    if (node.type === 'group') return this.buildGroup(node, def, portId);

    // 循环轮次：只在重复组的循环体里有意义
    if (node.type === 'loopIndex') {
      if (this.loopVars.length === 0) {
        this.errors.push({
          code: 'loop-index-outside',
          message: `「循环轮次」节点只能放在重复组（repeat > 1）的循环体里（${node.id}）`,
        });
        return ZERO.float;
      }
      return `float(${this.loopVars[this.loopVars.length - 1]})`;
    }

    // 组输出是子图内部的终点，不该被当表达式取
    if (node.type === 'groupOutput') return ZERO.float;

    const params = { ...(node.params ?? {}) };

    // split：多输出节点，输出端口直接映射到输入表达式的分量
    if (def.split) {
      const src = this.inputExpr(node, def, 'in');
      const idx = { x: 0, y: 1, z: 2, w: 3 }[portId] ?? 0;
      return `(${src.expr}).${COMPONENTS[src.type][idx] ?? 'x'}`;
    }
  // 音频采样：iChannel 是一张 2 行纹理，y=0 频谱，y=1 波形
    if (def.audioSample) {
      const ch = normChannel(params.channel);
      this.channels.add(ch);              // 必须：否则 header 不会声明 sampler2D

      const port = def.audioSample === 'wave' ? 't' : 'bin';
      const src = this.inputExpr(node, def, port);
      const x = castExpr(src.expr, src.type, 'float');

      if (def.audioSample === 'wave') {
        // 纹理素值 0..1，波形还原到 −1..1
        return `(texture(${ch}, vec2(clamp(${x}, 0.0, 1.0), 1.0)).x * 2.0 - 1.0)`;
      }
      return `texture(${ch}, vec2(clamp(${x}, 0.0, 1.0), 0.0)).x`;
    }
    // 纹理采样
    if (def.textureSample) {
      const uv = this.inputExpr(node, def, 'uv');
      const uvExpr = castExpr(uv.expr, uv.type, 'vec2');
      if (def.textureSample === 'channel') {
        const ch = normChannel(params.channel);
        this.channels.add(ch);
        return `texture(${ch}, ${uvExpr})`;
      }
      const buf = normBuffer(params.buffer);
      this.buffers.add(buf);
      return `texture(${buf}, ${uvExpr})`;
    }

    // output：终止节点，不该被当表达式取
    if (def.terminal) return 'vec4(0.0)';

    // uniform：直接引用外部 uniform 名。若图级没声明，这里补一份声明，
    // 否则生成的代码引用一个未声明的变量，编译器直接报 syntax error。
    if (node.type === 'uniform') {
      const name = String(params.name ?? 'uValue').replace(/[^A-Za-z0-9_]/g, '') || 'uValue';
      const outType = this.outputType(node, def, portId);
      if (!this.inferredUniforms.has(name)) {
        this.inferredUniforms.set(name, this.uniformInitializer(outType));
      }
      return name;
    }

    const rawCode = typeof params.expr === 'string' && node.type === 'custom' ? params.expr : def.code;
    const code = this.coerceValueParams(this.substitute(rawCode, node, def, params), node, def, params);
    const type = this.outputType(node, def, portId);
    const name = varName(node.id);
    if (this.lines.includes(`${glslType(type)} ${name} = ${code};`)) return name;
    this.lines.push(`${glslType(type)} ${name} = ${code};`);
    return name;
  }

  /**
   * 展开一个组节点。
   *
   * 做法是"并表"而不是新建一个子 Emitter：把子图的节点/连线加上 `<组id>::` 前缀
   * 并进当前 Emitter，再把子图里的「组输入」节点登记成外层表达式，
   * 最后取子图里对应输出端口的「组输出」节点的输入表达式。
   *
   * 这么做的好处是 helper / prelude / 语句 / 诊断全是同一份，
   * 生成的代码天然是内联的一段，不需要把两个 Emitter 的结果缝起来。
   *
   * @param {object} node 组节点实例
   * @param {object} def
   * @param {string} portId 要取哪个输出端口
   * @returns {string} GLSL 表达式
   */
  buildGroup(node, def, portId) {
    const group = node.params?.graph;
    if (group === null || typeof group !== 'object' || !Array.isArray(group.nodes) || group.nodes.length === 0) {
      this.errors.push({
        code: 'empty-group',
        message: `组 ${node.id} 还没有内容（画布上框选节点 → 右键「打成 Group」）`,
      });
      return ZERO.float;
    }

    const outputs = Array.isArray(group.outputs) ? group.outputs : [];
    const spec = outputs.find((p) => String(p.id) === String(portId));
    if (!spec) {
      this.errors.push({ code: 'unknown-group-port', message: `组 ${node.id} 没有输出端口 ${portId}` });
      return ZERO.float;
    }

    if (this.groupDepth > 8) {
      this.errors.push({ code: 'group-too-deep', message: `组嵌套超过 8 层：${node.id}（是不是自己套自己？）` });
      return ZERO.float;
    }

    const prefix = `${node.id}::`;
    if (this.expandedGroups.has(node.id)) {
      // 已经展开过：重复组直接给对应的 carry 变量，普通组走下面的单次路径
      const carry = this.repeatCarryVars.get(node.id);
      if (carry && carry.has(portId)) return carry.get(portId);
    }

    // 重复组（`repeat > 1`）：循环体只写一遍，外面套 `for`
    const repeat = Math.max(1, Math.round(Number(node.params?.repeat ?? 1)) || 1);
    if (repeat > 1) return this.buildRepeatedGroup(node, def, group, portId, repeat, prefix);

    if (!this.expandedGroups.has(node.id)) {
      this.expandedGroups.add(node.id);
      this.groupDepth += 1;
      try {
        for (const sub of group.nodes) {
          const id = prefix + sub.id;
          if (this.nodeById.has(id)) continue;
          this.nodeById.set(id, { ...sub, id });
        }
        for (const edge of group.edges ?? []) {
          this.edges.push({
            from: { node: prefix + edge.from.node, port: edge.from.port },
            to: { node: prefix + edge.to.node, port: edge.to.port },
          });
        }
        // 子图里的「组输入」= 外层喂进来的那根线
        for (const sub of group.nodes) {
          if (sub.type !== 'groupInput') continue;
          const portIn = String(sub.params?.port ?? 'in');
          this.inputOverrides.set(prefix + sub.id, this.inputExpr(node, def, portIn));
        }
      } finally {
        this.groupDepth -= 1;
      }
    }

    const outNode = group.nodes.find(
      (sub) => sub.type === 'groupOutput' && String(sub.params?.port ?? 'out') === String(portId),
    );
    if (!outNode) {
      this.errors.push({
        code: 'group-output-missing',
        message: `组 ${node.id} 声明了输出端口 ${portId}，但子图里没有对应的「组输出」节点`,
      });
      return ZERO.float;
    }

    const outDef = NODE_BY_TYPE.get('groupOutput');
    const got = this.inputExpr({ ...outNode, id: prefix + outNode.id }, outDef, 'color');
    return castExpr(got.expr, got.type, spec.type ?? 'vec4');
  }

  /**
   * 求一个**重复组**（`repeat > 1`）的输出。
   *
   * 为什么要有这个：把"重复"写成"复制"代价极大 —— IFS 隧道 99 步展开是 676 KB
   * 着色器、2 MB 图、codegen 352 ms，加载直接卡住；贝塞尔的 24 段也是 51 KB。
   * 重复是语言结构，循环体只该写一遍。
   *
   * 语义：
   *   - `carries`（默认取 inputs ∩ outputs）是**跨迭代传递**的值，
   *     每轮开头读进来、轮末写回去；其余的输入是循环不变量，每轮用外层表达式。
   *   - 循环体里可以放 `loopIndex` 节点拿到当前轮次（float）。
   *
   * 生成的样子：
   * ```glsl
   * vec4 g_c_dist = <外层输入>;        // 初值
   * for (int g_i = 0; g_i < 99; g_i++) {
   *   <循环体语句，groupInput 绑到 carry 变量>
   *   g_c_dist = <轮末的新值>;
   * }
   * // 组的输出 = 对应的 carry 变量
   * ```
   *
   * @param {object} node 组节点
   * @param {object} def
   * @param {object} group `params.graph`
   * @param {string} portId 要取哪个输出
   * @param {number} repeat 重复次数
   * @param {string} prefix 子图 id 前缀
   * @returns {string} GLSL 表达式（carry 变量名）
   */
  buildRepeatedGroup(node, def, group, portId, repeat, prefix) {
    const outputs = Array.isArray(group.outputs) ? group.outputs : [];
    const inputs = Array.isArray(group.inputs) ? group.inputs : [];
    /** 输入端口 → 子图里的 groupInput 节点 */
    const inputNodeOf = (id) =>
      group.nodes.find((n) => n.type === 'groupInput' && String(n.params?.port ?? 'in') === String(id));

    const carryIds = new Set(
      Array.isArray(group.carries) && group.carries.length > 0
        ? group.carries.map(String)
        : inputs.filter((p) => outputs.some((o) => String(o.id) === String(p.id))).map((p) => String(p.id)),
    );
    if (carryIds.size === 0) {
      this.errors.push({
        code: 'repeat-without-carry',
        message: `重复组 ${node.id} 没有任何跨迭代传递的值（carries），循环体算了也没人用`,
      });
      return ZERO.float;
    }

    // 已经发过这个循环了：直接给变量名
    const existing = this.repeatCarryVars.get(node.id);
    if (existing) return existing.get(portId) ?? ZERO.float;

    const base = varName(node.id);
    const idxVar = `${base}_i`;
    const carryVar = new Map();
    for (const id of carryIds) carryVar.set(id, `${base}_c_${varName(id)}`);

    // ① 先把 carry 变量声明出来（初值 = 外层喂进来的表达式）
    for (const port of inputs) {
      if (!carryIds.has(String(port.id))) continue;
      const init = this.inputExpr(node, def, port.id);
      this.lines.push(`${glslType(port.type ?? init.type)} ${carryVar.get(String(port.id))} = ${init.expr};`);
    }

    // ② 展开子图（同普通组）
    for (const sub of group.nodes) {
      const id = prefix + sub.id;
      if (!this.nodeById.has(id)) this.nodeById.set(id, { ...sub, id });
    }
    for (const edge of group.edges ?? []) {
      this.edges.push({
        from: { node: prefix + edge.from.node, port: edge.from.port },
        to: { node: prefix + edge.to.node, port: edge.to.port },
      });
    }
    // 输入绑定：carry 读上一轮的值，其余每轮用外层表达式
    for (const port of inputs) {
      const sub = inputNodeOf(port.id);
      if (!sub) continue;
      const key = String(port.id);
      this.inputOverrides.set(
        prefix + sub.id,
        carryIds.has(key)
          ? { expr: carryVar.get(key), type: port.type ?? 'vec4' }
          : this.inputExpr(node, def, port.id),
      );
    }

    // ③ 捕获循环体语句（把 this.lines 临时换掉）
    const savedLines = this.lines;
    this.lines = [];
    this.loopVars.push(idxVar);
    const outDef = NODE_BY_TYPE.get('groupOutput');
    const outExprs = new Map();
    try {
      for (const out of outputs) {
        const outNode = group.nodes.find(
          (sub) => sub.type === 'groupOutput' && String(sub.params?.port ?? 'out') === String(out.id),
        );
        if (!outNode) {
          this.errors.push({
            code: 'group-output-missing',
            message: `重复组 ${node.id} 声明了输出端口 ${out.id}，但子图里没有对应的「组输出」节点`,
          });
          continue;
        }
        outExprs.set(String(out.id), this.inputExpr({ ...outNode, id: prefix + outNode.id }, outDef, 'color'));
      }
    } finally {
      this.loopVars.pop();
    }
    const bodyLines = this.lines;
    this.lines = savedLines;

    // ④ 吐循环
    this.lines.push(`for (int ${idxVar} = 0; ${idxVar} < ${repeat}; ${idxVar}++) {`);
    for (const line of bodyLines) this.lines.push(`  ${line}`);
    for (const out of outputs) {
      const id = String(out.id);
      if (!carryIds.has(id) || !outExprs.has(id)) continue;
      this.lines.push(`  ${carryVar.get(id)} = ${outExprs.get(id).expr};`);
    }
    this.lines.push('}');

    // ⑤ 组的输出 = carry 变量
    const final = new Map();
    for (const id of carryIds) final.set(id, carryVar.get(id));
    this.repeatCarryVars.set(node.id, final);
    this.expandedGroups.add(node.id);

    if (!final.has(portId)) {
      this.errors.push({
        code: 'unknown-group-port',
        message: `重复组 ${node.id} 的输出端口 ${portId} 不是跨迭代的量（carries 里没有它）`,
      });
      return ZERO.float;
    }
    return final.get(portId);
  }

  /**
   * 求某节点输入端口接的表达式。
   * @param {object} node
   * @param {object} def
   * @param {string} inputPort
   * @returns {{expr:string, type:string}}
   */
  inputExpr(node, def, inputPort) {
    const portDef = resolvePorts(node, 'in').find((p) => p.id === inputPort);
    const declared = portDef?.type ?? 'float';
    const edge = this.edges.find((e) => e.to.node === node.id && e.to.port === inputPort);
    if (edge) {
      const upNode = this.nodeById.get(edge.from.node);
      const upDef = upNode ? NODE_BY_TYPE.get(upNode.type) : null;
      const upType = upDef ? this.outputType(upNode, upDef, edge.from.port) : 'float';
      const expr = this.expr(edge.from.node, edge.from.port);
      return { expr: castExpr(expr, upType, declared), type: declared };
    }
    // 没接线：用户改过的端口缺省值优先，其次用节点库里定义的
    const overridden = node.paramDefaults?.[inputPort];
    const value = overridden !== undefined ? overridden : portDef?.def;
    return { expr: glslLiteral(value, declared), type: declared };
  }

  /**
   * 某节点某输出端口的类型（考虑 dynamicOut）。
   * @param {object} node
   * @param {object} def
   * @param {string} portId
   * @returns {string}
   */
  outputType(node, def, portId) {
    const ports = resolvePorts(node, 'out');
    const found = ports.find((p) => p.id === portId) ?? ports[0];
    return found?.type ?? 'float';
  }

  /**
   * 某类型的 uniform 零值初始化表达式。
   * @param {string} type
   * @returns {string}
   */
  uniformInitializer(type) {
    return uniformInitializerFor(type);
  }

  /**
   * 把「整段就是一个值参数」的表达式重新按**输出端口类型**序列化一遍。
   *
   * 场景：`const` 节点的 value 是 vec3，但 outType 被设成了 float。
   * 直接输出 `vec3(...)` 会让声明 `float x = vec3(...)` 编译不过。
   * 这里识别出这种「节点代码就是 `$p.xxx`」的情况，按目标类型重新生成字面量。
   *
   * @param {string} code substitute 之后的结果
   * @param {object} node
   * @param {object} def
   * @param {object} params
   * @returns {string}
   */
  coerceValueParams(code, node, def, params) {
    const match = /^\$p\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(def.code ?? '');
    if (!match) return code;
    const meta = def.params?.[match[1]];
    if (!meta || !['vec2', 'vec3', 'vec4', 'color', 'float'].includes(meta.type)) return code;
    const value = params[match[1]] === undefined ? meta.value : params[match[1]];
    const target = this.outputType(node, def, def.outputs[0]?.id);
    return glslLiteral(value, target === 'color' ? 'vec3' : target);
  }

  /**
   * 替换模板里的 `$in.*` / `$p.*` 占位符。
   *
   * **要递归替换**：`custom` 节点的表达式本身就是 `$in.a` 这种模板，
   * 展开一次之后里面还是占位符，必须一路展开到没有 `$` 为止。
   *
   * @param {string} code
   * @param {object} node
   * @param {object} def
   * @param {object} params
   * @param {number} [depth] 递归深度保护
   * @returns {string}
   */
  substitute(code, node, def, params, depth = 0) {
    if (depth > 8) return '0.0';
    let out = String(code ?? '');

    out = out.replace(/\$in\.([A-Za-z_][A-Za-z0-9_]*)/g, (_m, portId) => {
      const { expr } = this.inputExpr(node, def, portId);
      return `(${expr})`;
    });

    out = out.replace(/\$p\.([A-Za-z_][A-Za-z0-9_]*)/g, (_m, key) => {
      const meta = def.params?.[key];
      const type = meta?.type ?? 'float';
      // 参数可能没填（节点实例上没有这个键），退回节点库里定义的默认值
      const effective = params[key] === undefined ? meta?.value : params[key];

      if (type === 'text') {
        const text = String(effective ?? '');
        // 表达式参数里若还带占位符，递归展开一层
        return text.includes('$') ? this.substitute(text, node, def, params, depth + 1) : text;
      }
      if (type === 'color') return glslLiteral(effective, 'vec3');
      if (type === 'select') {
        // select 的值是字符串（通道名 / Buffer 名 / 类型名），原样输出
        return String(effective ?? meta?.options?.[0] ?? '0.0');
      }
      if (type === 'bool') return effective ? '1.0' : '0.0';
      if (type === 'int') return String(Math.trunc(Number(effective) || 0));
      if (type === 'vec2' || type === 'vec3' || type === 'vec4') return glslLiteral(effective, type);
      return glslLiteral(effective, 'float');
    });

    return out;
  }
}

/**
 * GLSL 类型名。
 * @param {string} t
 * @returns {string}
 */
function glslType(t) {
  return PORT_TYPES.includes(t) ? t : 'float';
}

/**
 * 把各种形状的 uniform 输入统一成 `{name, type, init}` 数组。
 *
 * 接受：
 *   - `{ uTime: 1.5 }`（值表，最常见的调用方式）
 *   - `[{ name: 'uTime', type: 'float', value: 1.5 }]`（图里 uniforms[] 的样子）
 *   - `[{ name, type, init: 'vec3(0.0)' }]`（已经算好的声明）
 *
 * @param {any} input
 * @returns {Array<{name:string,type:string,init:string}>}
 */
export function normalizeUniformDecls(input) {
  if (input === undefined || input === null) return [];
  const entries = Array.isArray(input)
    ? input.map((item) => [item?.name, item?.type ?? 'float', item?.value ?? item?.init])
    : Object.entries(input).map(([name, value]) => {
        if (value && typeof value === 'object' && !Array.isArray(value) && 'type' in value) {
          return [name, value.type ?? 'float', value.value];
        }
        return [name, Array.isArray(value) ? `vec${value.length}` : 'float', value];
      });

  const seen = new Set();
  const out = [];
  for (const [rawName, rawType, rawValue] of entries) {
    const name = String(rawName ?? '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const type = PORT_TYPES.includes(rawType) ? rawType : 'float';
    // 已经算好的 GLSL 表达式直接透传，否则按类型序列化
    const isGlslExpr = typeof rawValue === 'string' && /^[a-zA-Z_][A-Za-z0-9_]*\s*\(/.test(rawValue.trim());
    out.push({
      name,
      type,
      init: isGlslExpr ? rawValue : glslLiteral(rawValue, type),
    });
  }
  return out;
}

/**
 * 通道名归一化。
 * @param {any} raw
 * @returns {string}
 */
function normChannel(raw) {
  const s = String(raw ?? '');
  return /^iChannel[0-3]$/.test(s) ? s : 'iChannel0';
}

/**
 * Buffer 名归一化。
 * @param {any} raw
 * @returns {string}
 */
function normBuffer(raw) {
  const s = String(raw ?? '');
  return /^Buffer[A-D]$/.test(s) ? s : 'BufferA';
}

/**
 * 标准 Shadertoy 前导声明。
 * @param {object} opts
 * @param {string[]} opts.channels 需要的 iChannel
 * @param {string[]} [opts.buffers] 需要采样的其它 Pass（BufferA..D）
 * @param {Array<{name:string,type:string,init:string}>} [opts.uniforms] 自定义 uniform 声明
 * @param {boolean} opts.isBuffer 是否是 Buffer Pass（多一个 iFrame）
 * @returns {string}
 */
export function shadertoyHeader({ channels = [], buffers = [], uniforms = [], isBuffer = false } = {}) {
  const lines = [
    // 这一行必须是文件第一行，且前面不能有空行或注释，
    // 否则编译器会退回 ES 1.00，`in/out`、`texture()` 全部报错。
    '#version 300 es',
    'precision highp float;',
    'precision highp int;',
    '',
  ];
  lines.push('uniform vec3 iResolution;');
  lines.push('uniform float iTime;');
  lines.push('uniform float iTimeDelta;');
  if (isBuffer) lines.push('uniform int iFrame;');
  lines.push('uniform vec4 iMouse;');
  lines.push('uniform vec4 iDate;');
  for (const ch of ['iChannel0', 'iChannel1', 'iChannel2', 'iChannel3']) {
    if (channels.includes(ch)) lines.push(`uniform sampler2D ${ch};`);
  }
  for (const buf of ['BufferA', 'BufferB', 'BufferC', 'BufferD']) {
    // 一个 Pass 采样自己 = 上一帧，属于合法用法
    if (buffers.includes(buf)) lines.push(`uniform sampler2D ${buf};`);
  }
  for (const uniform of uniforms) {
    const type = PORT_TYPES.includes(uniform?.type) ? uniform.type : 'float';
    // GLSL ES 3.00（WebGL2）**不允许** uniform 声明带初始化器：
    // 写了会报 "cannot initialize this type of qualifier"。
    // 值一律由渲染器每帧上传，所以声明就是裸的。
    lines.push(`uniform ${type} ${uniform.name};`);
  }
  lines.push('');
  lines.push('out vec4 st_fragColor;');
  return lines.join('\n');
}

/**
 * 某类型的 uniform 零值初始化表达式。
 * @param {string} type
 * @returns {string}
 */
export function uniformInitializerFor(type) {
  const t = PORT_TYPES.includes(type) ? type : 'float';
  return t === 'float' ? '0.0' : `${t}(0.0)`;
}

/**
 * 编译一个 Pass 的节点子图为 GLSL。
 *
 * @param {object} graph 归一化后的完整 ShaderGraph
 * @param {string} passName 'image' | 'BufferA'..'BufferD'
 * @param {object} [opts]
 * @param {Record<string, number>} [opts.uniforms] 自定义 uniform 名 → 值（仅用于生成声明的名字）
 * @returns {{ok:boolean, code:string, body:string, header:string, helpers:string[], channels:string[], buffers:string[], uniforms:string[], errors:object[], warnings:string[]}}
 */
export function compileGraph(graph, passName = 'image', opts = {}) {
  const sub = passSubgraph(graph, passName);
  const emitter = new Emitter({ ...graph, nodes: sub.nodes, edges: sub.edges }, passName, opts);

  const declared = normalizeUniformDecls(opts.uniforms);
  const isBuffer = passName !== 'image';

  if (sub.nodes.length === 0) {
    emitter.errors.push({ code: 'empty-pass', message: `Pass ${passName} 还没有任何节点` });
    return {
      ok: false,
      code: '',
      body: '',
      header: '',
      helpers: [],
      channels: [],
      buffers: [],
      uniforms: declared,
      errors: emitter.errors,
      warnings: emitter.warnings,
    };
  }

  const outputs = sub.nodes.filter((n) => n.type === 'output');
  if (outputs.length === 0) {
    emitter.errors.push({ code: 'no-output', message: `Pass ${passName} 少了输出节点` });
  } else if (outputs.length > 1) {
    emitter.warnings.push(`Pass ${passName} 有 ${outputs.length} 个输出节点，只用第一个`);
  }

  let colorExpr = ZERO.vec4;
  if (outputs.length > 0) {
    const outNode = outputs[0];
    const outDef = NODE_BY_TYPE.get('output');
    const got = emitter.inputExpr(outNode, outDef, 'color');
    colorExpr = got.expr;
  }

  // 关键：先把 header 需要的通道 / uniform 收集齐，再拼 body。
  // 通道和隐式 uniform 都是在遍历过程中才登记的，所以 body 必须先跑完。
  const bodyLines = [...emitter.lines];
  const body = ['void main() {', ...bodyLines.map((l) => `  ${l}`), `  st_fragColor = ${colorExpr};`, '}'].join('\n');

  // 图级声明的 uniform 优先；图里用了但没声明的，自动补一份（否则编译不过）
  const uniforms = [...declared];
  const declaredNames = new Set(declared.map((u) => u.name));
  for (const [name, init] of emitter.inferredUniforms) {
    if (declaredNames.has(name)) continue;
    const type = init.startsWith('float') ? 'float' : init.slice(0, init.indexOf('('));
    uniforms.push({ name, type, init, inferred: true });
  }
  for (const uniform of uniforms) {
    if (typeof uniform.init !== 'string' || uniform.init === '') uniform.init = uniformInitializerFor(uniform.type);
  }

  // prelude 里也可能**直接**引用 iChannel / Buffer（比如从 Shadertoy 导入的自定义节点，
  // 它的整段代码都活在 prelude 里）。这些引用不是采样节点产生的，光靠节点扫描看不到，
  // 但 header 必须声明它们，否则生成的 GLSL 引用未声明变量、编译直接报 syntax error。
  for (const text of emitter.preludes.values()) {
    for (const ch of text.match(/iChannel[0-3]/g) ?? []) emitter.channels.add(ch);
    for (const buf of text.match(/Buffer[A-D]/g) ?? []) emitter.buffers.add(buf);
  }

 // `custom` 节点的表达式（以及任何节点模板里手写的采样）也可能直接引用
  // iChannel / Buffer。这些引用不是 textureSample / audioSample 节点产生的，
  // 光靠节点的 def.textureSample 分支看不到 —— 必须扫一遍原始文本。
  // 扫的是**替换前**的模板（`def.code` 和 `params.expr`），占位符 `$in.xxx`
  // 里不会出现通道名，所以替换与否不影响结果。
  for (const node of sub.nodes) {
    const def = NODE_BY_TYPE.get(node.type);
    if (!def) continue;
    const text = node.type === 'custom' && typeof node.params?.expr === 'string'
      ? node.params.expr
      : def.code;
    for (const ch of String(text ?? '').match(/iChannel[0-3]/g) ?? []) emitter.channels.add(ch);
    for (const buf of String(text ?? '').match(/Buffer[A-D]/g) ?? []) emitter.buffers.add(buf);
  }

  const header = shadertoyHeader({
    channels: [...emitter.channels],
    buffers: [...emitter.buffers],
    uniforms,
    isBuffer,
  });

  const helperNames = resolveHelpers(emitter.helpers);
  const preludeParts = [renderHelpers(helperNames), ...emitter.preludes.values()].filter((s) => s !== '');
  const code = [header, ...preludeParts, '', body].join('\n\n');

  return {
    ok: emitter.errors.length === 0,
    code,
    body,
    header,
    helpers: helperNames,
    channels: [...emitter.channels].sort(),
    buffers: [...emitter.buffers].sort(),
    uniforms,
    errors: emitter.errors,
    warnings: emitter.warnings,
  };
}
