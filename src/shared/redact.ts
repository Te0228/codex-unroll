/**
 * 密钥脱敏（SPEC §9.1）。
 *
 * 硬约束：脱敏发生在**归一化层**，在数据进入 Entry / React state 之前。
 * 这样 `preview` 与 `rawPretty` 两处都自动覆盖，不会有一处漏网（验收 B7/B8）。
 *
 * 策略两条，取并集：
 *   ① 按字段名（更可靠，优先）——JSON key 命中 SENSITIVE_KEY 即遮蔽其值
 *   ② 按值的形态（兜底）——覆盖嵌在正文里的密钥
 *
 * 一律**保留尾 4 位**：真实排障要能区分「是哪一把 key」（§9.1 的论证）。
 * 尾 4 位不足以复用密钥，但足以判别身份。
 */

/** 遮蔽字符是 U+2022 BULLET，正好 4 个 */
export const MASK = '••••';

/** ① 字段名命中（§9.1 的正则，原样照抄） */
const SENSITIVE_KEY =
  /(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|passwd|credential|authorization|auth[_-]?token|bearer|private[_-]?key|session[_-]?token)/i;

/** 保留尾 4 位；≤4 位的值全遮（否则等于没遮） */
function tail4(s: string): string {
  return s.length > 4 ? s.slice(-4) : '';
}

interface ValueRule {
  /** 必须带 g 标志 */
  re: RegExp;
  /** 命中的整段 → 遮蔽后的写法 */
  mask: (hit: string) => string;
}

/**
 * ② 值形态规则。**顺序有意义**：
 * Bearer 必须排在 JWT 前面，否则 `Bearer eyJ…` 会先被 JWT 规则吃掉，
 * 丢掉可识别的 `Bearer ` 前缀。
 */
const VALUE_RULES: ValueRule[] = [
  // Bearer token：保留 `Bearer ` 前缀（空格归一化为一个）
  { re: /Bearer\s+[A-Za-z0-9._-]{20,}/g, mask: (h) => `Bearer ${MASK}${tail4(h)}` },
  // JWT：没有可识别的前缀分隔符，整体遮蔽
  { re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, mask: (h) => `${MASK}${tail4(h)}` },
  // OpenAI 风格：保留 `sk-`
  { re: /sk-[A-Za-z0-9_-]{16,}/g, mask: (h) => `sk-${MASK}${tail4(h)}` },
  // AWS Access Key：无前缀分隔符，不保留前缀
  { re: /AKIA[0-9A-Z]{16}/g, mask: (h) => `${MASK}${tail4(h)}` },
  // GitHub token：保留 `ghp_` / `gho_` / … 四字前缀
  { re: /gh[pousr]_[A-Za-z0-9]{36,}/g, mask: (h) => `${h.slice(0, 4)}${MASK}${tail4(h)}` },
];

/**
 * 对单个字符串做值形态脱敏（策略②）。
 * 普通文本原样返回（验收 B9）。
 */
export function redactText(s: string): string {
  if (typeof s !== 'string' || s.length === 0) return s;
  let out = s;
  for (const rule of VALUE_RULES) {
    // 遮蔽字符 • 不属于任何规则的字符集，替换结果不会被后续规则二次命中
    out = out.replace(rule.re, (hit) => rule.mask(hit));
  }
  return out;
}

/**
 * 字段名命中时的遮蔽：优先用值形态的写法（能保留 `sk-` 这类可识别前缀），
 * 值不匹配任何已知形态时退回通用 `••••` + 尾 4 位。
 */
function redactSensitiveValue(s: string): string {
  const byForm = redactText(s);
  if (byForm !== s) return byForm;
  return `${MASK}${tail4(s)}`;
}

function walk(value: unknown, underSensitiveKey: boolean): unknown {
  if (typeof value === 'string') {
    return underSensitiveKey ? redactSensitiveValue(value) : redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, underSensitiveKey));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // 一旦落在敏感字段下，整棵子树都按敏感处理
      out[k] = walk(v, underSensitiveKey || SENSITIVE_KEY.test(k));
    }
    return out;
  }
  // number / boolean / null / undefined 原样
  return value;
}

/**
 * 深度遍历，字段名命中（①）+ 值形态命中（②）取并集。
 * **返回新对象，不改原对象。**
 */
export function redactDeep<T>(value: T): T {
  return walk(value, false) as T;
}

/** 供 UI 判断某段文本是否被遮蔽过（显示 🔒 图标用） */
export function isRedacted(s: string): boolean {
  return s.includes(MASK);
}
