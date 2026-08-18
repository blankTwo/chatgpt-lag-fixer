// ChatGPT 卡顿修复 —— WebAssembly 裁剪核心（AssemblyScript）
//
// 输入：形如 { mapping: {...}, current_node: "id" } 的对话 JSON 字符串，
//       其中 mapping 是 ChatGPT 的对话节点映射。
// 输出：裁剪后的对话 JSON 字符串（附带统计信息）；当无需裁剪或输入不可用时返回 ""（空串）。
//
// 裁剪会沿着以 current_node 结尾的活动分支，保留最近的 keepTurns 个可见轮次
//（外加用户显式加载的 extra 个更早轮次），丢弃更早的内容。关键在于它会重写保留
// 下来的节点，使结果树中不存在任何悬空引用：
//   * 保留节点的 children 只列出同样被保留的子节点
//   * 若某保留节点的真实父节点被裁掉，则将其重新挂到新的 root 上
//
// 它使用一个手写的极小 JSON 读/写器（不依赖任何外部库），从而让 wasm 保持小巧、无依赖。

// ---------------------------------------------------------------------------
// 极小 JSON 分词器 / 解析器
// ---------------------------------------------------------------------------

class JsonReader {
  src: string;
  pos: i32;
  len: i32;
  ok: bool;

  constructor(src: string) {
    this.src = src;
    this.pos = 0;
    this.len = src.length;
    this.ok = true;
  }

  private peek(): i32 {
    if (this.pos >= this.len) return -1;
    return this.src.charCodeAt(this.pos);
  }

  skipWs(): void {
    while (this.pos < this.len) {
      const c = this.src.charCodeAt(this.pos);
      // 空格、制表符、换行、回车
      if (c == 0x20 || c == 0x09 || c == 0x0a || c == 0x0d) {
        this.pos++;
      } else {
        break;
      }
    }
  }

  expect(ch: i32): bool {
    this.skipWs();
    if (this.peek() == ch) {
      this.pos++;
      return true;
    }
    this.ok = false;
    return false;
  }

  // 若下一个非空白字符 == ch，则消费它并返回 true。
  accept(ch: i32): bool {
    this.skipWs();
    if (this.peek() == ch) {
      this.pos++;
      return true;
    }
    return false;
  }

  // 解析一个 JSON 字符串字面量（假定接下来就是起始引号）。
  readString(): string {
    this.skipWs();
    if (this.peek() != 0x22) {
      this.ok = false;
      return "";
    }
    this.pos++; // 消费起始引号
    let out = "";
    let runStart = this.pos;
    while (this.pos < this.len) {
      const c = this.src.charCodeAt(this.pos);
      if (c == 0x22) {
        // 结束引号
        out += this.src.substring(runStart, this.pos);
        this.pos++;
        return out;
      }
      if (c == 0x5c) {
        // 反斜杠 —— 先冲刷已读段，再处理转义
        out += this.src.substring(runStart, this.pos);
        this.pos++;
        if (this.pos >= this.len) {
          this.ok = false;
          return out;
        }
        const e = this.src.charCodeAt(this.pos);
        this.pos++;
        if (e == 0x22) out += '"';
        else if (e == 0x5c) out += "\\";
        else if (e == 0x2f) out += "/";
        else if (e == 0x62) out += String.fromCharCode(0x08);
        else if (e == 0x66) out += String.fromCharCode(0x0c);
        else if (e == 0x6e) out += "\n";
        else if (e == 0x72) out += "\r";
        else if (e == 0x74) out += "\t";
        else if (e == 0x75) {
          // \uXXXX
          if (this.pos + 4 > this.len) {
            this.ok = false;
            return out;
          }
          const hex = this.src.substring(this.pos, this.pos + 4);
          this.pos += 4;
          out += String.fromCharCode(parseHex4(hex));
        } else {
          this.ok = false;
          return out;
        }
        runStart = this.pos;
      } else {
        this.pos++;
      }
    }
    this.ok = false;
    return out;
  }

  // 跳过一个我们不关心的任意 JSON 值。
  skipValue(): void {
    this.skipWs();
    const c = this.peek();
    if (c == 0x7b) {
      // 对象
      this.skipContainer(0x7b, 0x7d);
    } else if (c == 0x5b) {
      // 数组
      this.skipContainer(0x5b, 0x5d);
    } else if (c == 0x22) {
      this.readString();
    } else {
      // 数字 / true / false / null —— 读到分隔符为止
      while (this.pos < this.len) {
        const ch = this.src.charCodeAt(this.pos);
        if (
          ch == 0x2c || // ,
          ch == 0x7d || // }
          ch == 0x5d || // ]
          ch == 0x20 ||
          ch == 0x09 ||
          ch == 0x0a ||
          ch == 0x0d
        ) {
          break;
        }
        this.pos++;
      }
    }
  }

  private skipContainer(open: i32, close: i32): void {
    // 假定接下来就是起始字符
    this.pos++; // 消费起始字符
    let depth = 1;
    while (this.pos < this.len && depth > 0) {
      const c = this.src.charCodeAt(this.pos);
      if (c == 0x22) {
        this.readString();
        continue;
      }
      if (c == open) depth++;
      else if (c == close) depth--;
      this.pos++;
    }
  }
}

function parseHex4(hex: string): i32 {
  let v = 0;
  for (let i = 0; i < 4; i++) {
    const c = hex.charCodeAt(i);
    let d = 0;
    if (c >= 0x30 && c <= 0x39) d = c - 0x30;
    else if (c >= 0x61 && c <= 0x66) d = c - 0x61 + 10;
    else if (c >= 0x41 && c <= 0x46) d = c - 0x41 + 10;
    v = (v << 4) | d;
  }
  return v;
}

// ---------------------------------------------------------------------------
// 对话模型
// ---------------------------------------------------------------------------

class Node {
  id: string;
  parent: string;        // "" 表示 null
  hasParent: bool;
  children: string[];
  role: string;          // 无 message / 无 role 时为 ""
  hasMessage: bool;
  hidden: bool;          // is_visually_hidden_from_conversation

  constructor(id: string) {
    this.id = id;
    this.parent = "";
    this.hasParent = false;
    this.children = [];
    this.role = "";
    this.hasMessage = false;
    this.hidden = false;
  }
}

// 一个可见"轮次"是指：带有 user/assistant 角色的 message、且未被视觉隐藏的节点。
// system / tool / 隐藏节点属于结构性节点，不计入保留预算。
function isVisibleTurn(n: Node): bool {
  if (!n.hasMessage) return false;
  if (n.hidden) return false;
  return n.role == "user" || n.role == "assistant";
}

// ---------------------------------------------------------------------------
// 解析对话对象
// ---------------------------------------------------------------------------

class Conversation {
  nodes: Map<string, Node>;
  order: string[];       // mapping 键的插入顺序
  currentNode: string;
  root: string;
  valid: bool;

  constructor() {
    this.nodes = new Map<string, Node>();
    this.order = [];
    this.currentNode = "";
    this.root = "";
    this.valid = false;
  }
}

function parseConversation(json: string): Conversation {
  const conv = new Conversation();
  const r = new JsonReader(json);

  if (!r.accept(0x7b)) return conv; // 顶层 "{"

  let sawMapping = false;

  while (true) {
    r.skipWs();
    if (r.accept(0x7d)) break; // "}"
    const key = r.readString();
    if (!r.ok) return conv;
    if (!r.expect(0x3a)) return conv; // ":"

    if (key == "mapping") {
      parseMapping(r, conv);
      if (!r.ok) return conv;
      sawMapping = true;
    } else if (key == "current_node") {
      r.skipWs();
      if (r.peek() == 0x22) {
        conv.currentNode = r.readString();
      } else {
        r.skipValue(); // null 或其它
      }
    } else {
      r.skipValue();
    }

    r.skipWs();
    if (!r.accept(0x2c)) {
      // 没有逗号 → 期望结束大括号
      r.accept(0x7d);
      break;
    }
  }

  conv.valid = sawMapping && conv.nodes.size > 0;
  return conv;
}

function parseMapping(r: JsonReader, conv: Conversation): void {
  if (!r.expect(0x7b)) return; // "{"
  r.skipWs();
  if (r.accept(0x7d)) return; // 空对象

  while (true) {
    const id = r.readString();
    if (!r.ok) return;
    if (!r.expect(0x3a)) return; // ":"
    const node = parseNode(r, id);
    if (!r.ok) return;
    if (!conv.nodes.has(id)) conv.order.push(id);
    conv.nodes.set(id, node);

    r.skipWs();
    if (r.accept(0x2c)) continue;
    r.accept(0x7d);
    break;
  }
}

function parseNode(r: JsonReader, id: string): Node {
  const node = new Node(id);
  if (!r.expect(0x7b)) return node; // "{"
  r.skipWs();
  if (r.accept(0x7d)) return node; // 空节点对象

  while (true) {
    const key = r.readString();
    if (!r.ok) return node;
    if (!r.expect(0x3a)) return node; // ":"

    if (key == "parent") {
      r.skipWs();
      if (r.peek() == 0x22) {
        node.parent = r.readString();
        node.hasParent = true;
      } else {
        r.skipValue(); // null
      }
    } else if (key == "children") {
      parseChildren(r, node);
    } else if (key == "message") {
      r.skipWs();
      if (r.peek() == 0x7b) {
        node.hasMessage = true;
        parseMessage(r, node);
      } else {
        r.skipValue(); // null
      }
    } else {
      r.skipValue();
    }

    r.skipWs();
    if (r.accept(0x2c)) continue;
    r.accept(0x7d);
    break;
  }
  return node;
}

function parseChildren(r: JsonReader, node: Node): void {
  r.skipWs();
  if (r.peek() != 0x5b) {
    r.skipValue();
    return;
  }
  r.pos++; // 消费 "["
  r.skipWs();
  if (r.accept(0x5d)) return; // 空数组
  while (true) {
    r.skipWs();
    if (r.peek() == 0x22) {
      node.children.push(r.readString());
    } else {
      r.skipValue();
    }
    r.skipWs();
    if (r.accept(0x2c)) continue;
    r.accept(0x5d);
    break;
  }
}

function parseMessage(r: JsonReader, node: Node): void {
  if (!r.expect(0x7b)) return; // "{"
  r.skipWs();
  if (r.accept(0x7d)) return;

  while (true) {
    const key = r.readString();
    if (!r.ok) return;
    if (!r.expect(0x3a)) return;

    if (key == "author") {
      parseAuthor(r, node);
    } else if (key == "metadata") {
      parseMetadata(r, node);
    } else {
      r.skipValue();
    }

    r.skipWs();
    if (r.accept(0x2c)) continue;
    r.accept(0x7d);
    break;
  }
}

function parseAuthor(r: JsonReader, node: Node): void {
  r.skipWs();
  if (r.peek() != 0x7b) {
    r.skipValue();
    return;
  }
  r.pos++; // "{"
  r.skipWs();
  if (r.accept(0x7d)) return;
  while (true) {
    const key = r.readString();
    if (!r.ok) return;
    if (!r.expect(0x3a)) return;
    if (key == "role") {
      r.skipWs();
      if (r.peek() == 0x22) {
        node.role = r.readString();
      } else {
        r.skipValue();
      }
    } else {
      r.skipValue();
    }
    r.skipWs();
    if (r.accept(0x2c)) continue;
    r.accept(0x7d);
    break;
  }
}

function parseMetadata(r: JsonReader, node: Node): void {
  r.skipWs();
  if (r.peek() != 0x7b) {
    r.skipValue();
    return;
  }
  r.pos++; // "{"
  r.skipWs();
  if (r.accept(0x7d)) return;
  while (true) {
    const key = r.readString();
    if (!r.ok) return;
    if (!r.expect(0x3a)) return;
    if (key == "is_visually_hidden_from_conversation") {
      r.skipWs();
      // 读取布尔字面量
      const c = r.peek();
      if (c == 0x74) {
        // "true"
        node.hidden = true;
      }
      r.skipValue();
    } else {
      r.skipValue();
    }
    r.skipWs();
    if (r.accept(0x2c)) continue;
    r.accept(0x7d);
    break;
  }
}

// ---------------------------------------------------------------------------
// JSON 写出辅助
// ---------------------------------------------------------------------------

function writeJsonString(sb: StringSink, s: string): void {
  sb.add('"');
  const n = s.length;
  let runStart = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c == 0x22 || c == 0x5c || c < 0x20) {
      if (i > runStart) sb.add(s.substring(runStart, i));
      if (c == 0x22) sb.add('\\"');
      else if (c == 0x5c) sb.add("\\\\");
      else if (c == 0x0a) sb.add("\\n");
      else if (c == 0x0d) sb.add("\\r");
      else if (c == 0x09) sb.add("\\t");
      else if (c == 0x08) sb.add("\\b");
      else if (c == 0x0c) sb.add("\\f");
      else {
        sb.add("\\u");
        sb.add(hex4(c));
      }
      runStart = i + 1;
    }
  }
  if (runStart < n) sb.add(s.substring(runStart, n));
  sb.add('"');
}

function hex4(c: i32): string {
  const digits = "0123456789abcdef";
  let out = "";
  out += digits.charAt((c >> 12) & 0xf);
  out += digits.charAt((c >> 8) & 0xf);
  out += digits.charAt((c >> 4) & 0xf);
  out += digits.charAt(c & 0xf);
  return out;
}

class StringSink {
  private parts: string[];
  constructor() {
    this.parts = [];
  }
  add(s: string): void {
    this.parts.push(s);
  }
  toString(): string {
    return this.parts.join("");
  }
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/**
 * trimConversation
 * @param json      对话对象 JSON 字符串
 * @param keepTurns 保留的最近可见轮次数（>= 1）
 * @param extra     额外保留的更早可见轮次数（用户"加载更多"）
 * @returns 裁剪后的对话 JSON（含统计信息）；未执行裁剪时返回 ""
 */
export function trimConversation(json: string, keepTurns: i32, extra: i32): string {
  if (keepTurns < 1) keepTurns = 1;
  if (extra < 0) extra = 0;
  const budget = keepTurns + extra;

  const conv = parseConversation(json);
  if (!conv.valid) return "";

  // 从 current_node 向上走到 root，确立活动分支。
  const branch: string[] = []; // 顺序为 叶 -> ... -> 根
  let cursor = conv.currentNode;
  // 若 current_node 缺失/未知，则无法可靠裁剪。
  if (cursor == "" || !conv.nodes.has(cursor)) return "";

  const guard = conv.nodes.size + 4; // 防环保护
  let steps = 0;
  while (cursor != "" && conv.nodes.has(cursor)) {
    branch.push(cursor);
    const n = conv.nodes.get(cursor);
    if (!n.hasParent) break;
    cursor = n.parent;
    steps++;
    if (steps > guard) break; // 结构畸形 / 存在环
  }
  // 分支的真实根是最后一个元素。
  const branchRoot = branch[branch.length - 1];

  // 统计分支上（根..叶）的可见轮次数。
  let visibleTotal = 0;
  for (let i = 0; i < branch.length; i++) {
    if (isVisibleTurn(conv.nodes.get(branch[i]))) visibleTotal++;
  }

  const absoluteMessageCount = countAllVisible(conv);

  // 无需裁剪：可见轮次数不超过预算。
  if (visibleTotal <= budget) {
    return buildResult(conv, buildKeepSetAll(conv), branchRoot, visibleTotal, visibleTotal, absoluteMessageCount, false);
  }

  // 决定保留哪些分支节点：最近的 budget 个可见轮次，外加位于被保留区域与其根
  // 之间的所有结构性（非可见）节点。branch 是叶在前，因此持续向上走，
  // 直到收集到 budget 个可见轮次。
  const keep = new Set<string>();
  let visibleKept = 0;
  let cutIndex = branch.length; // 指向 branch 中最旧保留节点的排它下标
  for (let i = 0; i < branch.length; i++) {
    const id = branch[i];
    keep.add(id);
    if (isVisibleTurn(conv.nodes.get(id))) {
      visibleKept++;
      if (visibleKept >= budget) {
        cutIndex = i + 1;
        break;
      }
    }
  }

  // 新的合成根：复用真实分支根的 id，让客户端保有一个稳定的锚点，但把最旧的
  // 保留节点重新挂到它下面。我们保留真实的根节点（通常是结构性/system 锚点），
  // 以便 ChatGPT 的渲染器有一个有效的树入口。最旧的保留*内容*节点是 cutIndex-1。
  const oldestKeptId = branch[cutIndex - 1];

  // 始终保留真实分支根，使树顶结构连贯。
  keep.add(branchRoot);

  const hasOlder = cutIndex < branch.length; // 我们丢弃了切点以上的内容

  // 把最旧的保留内容节点直接重新挂到分支根下
  //（它与根之间的真实祖先已被裁掉）。
  const reparent = new Map<string, string>();
  if (oldestKeptId != branchRoot) {
    reparent.set(oldestKeptId, branchRoot);
  }

  return buildResultTrimmed(
    conv,
    keep,
    reparent,
    branchRoot,
    visibleTotal,
    visibleKept,
    absoluteMessageCount,
    hasOlder
  );
}

function countAllVisible(conv: Conversation): i32 {
  let count = 0;
  const keys = conv.order;
  for (let i = 0; i < keys.length; i++) {
    if (isVisibleTurn(conv.nodes.get(keys[i]))) count++;
  }
  return count;
}

function buildKeepSetAll(conv: Conversation): Set<string> {
  const s = new Set<string>();
  const keys = conv.order;
  for (let i = 0; i < keys.length; i++) s.add(keys[i]);
  return s;
}

// 输出完整（未裁剪）的对话及统计信息 —— 用于无需裁剪的透传场景。
function buildResult(
  conv: Conversation,
  keep: Set<string>,
  root: string,
  visibleTotal: i32,
  visibleKept: i32,
  absoluteMessageCount: i32,
  hasOlder: bool
): string {
  const emptyReparent = new Map<string, string>();
  return buildResultTrimmed(
    conv,
    keep,
    emptyReparent,
    root,
    visibleTotal,
    visibleKept,
    absoluteMessageCount,
    hasOlder
  );
}

// 核心序列化器。保证不产生悬空引用：
//   * 只输出 keep 集合内的节点
//   * 节点的 children 过滤为同样在 keep 内的
//   * 节点的 parent 经 reparent 重写；若真实父节点未保留，则置为 null
function buildResultTrimmed(
  conv: Conversation,
  keep: Set<string>,
  reparent: Map<string, string>,
  root: string,
  visibleTotal: i32,
  visibleKept: i32,
  absoluteMessageCount: i32,
  hasOlder: bool
): string {
  const sb = new StringSink();
  sb.add("{");

  // mapping
  sb.add('"mapping":{');
  const keys = conv.order;
  let first = true;
  for (let i = 0; i < keys.length; i++) {
    const id = keys[i];
    if (!keep.has(id)) continue;
    const node = conv.nodes.get(id);

    if (!first) sb.add(",");
    first = false;

    writeJsonString(sb, id);
    sb.add(":{");

    // id
    sb.add('"id":');
    writeJsonString(sb, id);

    // parent
    sb.add(',"parent":');
    let parentId = node.parent;
    let hasParent = node.hasParent;
    if (reparent.has(id)) {
      parentId = reparent.get(id);
      hasParent = true;
    }
    if (hasParent && keep.has(parentId)) {
      writeJsonString(sb, parentId);
    } else {
      sb.add("null");
    }

    // children（过滤为已保留的）
    sb.add(',"children":[');
    let cFirst = true;
    for (let c = 0; c < node.children.length; c++) {
      const child = node.children[c];
      if (!keep.has(child)) continue;
      // 防护：若该子节点被重新挂到别处，则不在此列出
      if (reparent.has(child) && reparent.get(child) != id) continue;
      if (!cFirst) sb.add(",");
      cFirst = false;
      writeJsonString(sb, child);
    }
    // 若有节点被重新挂到当前节点下，确保把它列为子节点。
    const rk = reparent.keys();
    for (let k = 0; k < rk.length; k++) {
      const childId = rk[k];
      if (reparent.get(childId) == id && keep.has(childId)) {
        let already = false;
        for (let c = 0; c < node.children.length; c++) {
          if (node.children[c] == childId) {
            already = true;
            break;
          }
        }
        if (!already) {
          if (!cFirst) sb.add(",");
          cFirst = false;
          writeJsonString(sb, childId);
        }
      }
    }
    sb.add("]");

    // message role（可为 null）—— 足以让客户端判断轮次类型
    if (node.hasMessage) {
      sb.add(',"message":{"author":{"role":');
      if (node.role != "") {
        writeJsonString(sb, node.role);
      } else {
        sb.add("null");
      }
      sb.add("}");
      if (node.hidden) {
        sb.add(',"metadata":{"is_visually_hidden_from_conversation":true}');
      }
      sb.add("}");
    } else {
      sb.add(',"message":null');
    }

    sb.add("}");
  }
  sb.add("}");

  // current_node
  sb.add(',"current_node":');
  writeJsonString(sb, conv.currentNode);

  // root
  sb.add(',"root":');
  writeJsonString(sb, root);

  // 统计信息
  sb.add(',"visibleTotal":');
  sb.add(visibleTotal.toString());
  sb.add(',"visibleKept":');
  sb.add(visibleKept.toString());
  sb.add(',"absoluteMessageCount":');
  sb.add(absoluteMessageCount.toString());
  sb.add(',"hasOlderMessages":');
  sb.add(hasOlder ? "true" : "false");

  sb.add("}");
  return sb.toString();
}
