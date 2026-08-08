/**
 * 二次解析（F19）——树的渲染交给 react-json-view-lite，**这部分是我们自己的逻辑**，
 * 也是这一层里唯一值得纯函数覆盖的东西。组件行为在 App.test.tsx。
 */
import { describe, expect, it } from 'vitest';
import { EXPAND_LEVELS, expandNestedJson, parseNestedJson } from './jsonTree';

describe('parseNestedJson · 二次解析（F19）', () => {
  /** shell / exec_command 走的这条：arguments 是 JSON 字符串 */
  it('能解析成对象的 JSON 字符串 → 返回解析结果', () => {
    expect(parseNestedJson('{"cmd": "ls -la"}')).toEqual({ cmd: 'ls -la' });
    expect(parseNestedJson('  [1, 2]  ')).toEqual([1, 2]);
  });

  /**
   * ⚠️ apply_patch 走的是另一条：input 是纯文本 patch，绝不能当 JSON。
   * 两条工具调用路径都要支持，只做一条会让另一条彻底显示不出来。
   */
  it('纯文本 patch 不被误解析', () => {
    expect(parseNestedJson('*** Begin Patch\n*** Add File: hello.txt\n+hi\n*** End Patch\n')).toBeNull();
  });

  it('parse 成标量的不算嵌套 JSON（只认对象/数组）', () => {
    expect(parseNestedJson('123')).toBeNull();
    expect(parseNestedJson('"abc"')).toBeNull();
    expect(parseNestedJson('true')).toBeNull();
    expect(parseNestedJson('null')).toBeNull();
  });

  it('坏 JSON 不抛，返回 null', () => {
    expect(parseNestedJson('{oops')).toBeNull();
    expect(parseNestedJson('{"a":')).toBeNull();
  });

  it('非字符串 / 空串一律 null（对象本身不需要二次解析）', () => {
    expect(parseNestedJson({ a: 1 })).toBeNull();
    expect(parseNestedJson(42)).toBeNull();
    expect(parseNestedJson('')).toBeNull();
    expect(parseNestedJson('{')).toBeNull();
  });
});

describe('expandNestedJson · 喂给 JsonView 之前的预处理', () => {
  it('递归把 JSON 字符串换成子树，其余原样', () => {
    const input = {
      type: 'function_call',
      arguments: '{"cmd": "ls -la"}',
      name: 'exec_command',
      n: 1,
    };
    expect(expandNestedJson(input)).toEqual({
      type: 'function_call',
      arguments: { cmd: 'ls -la' },
      name: 'exec_command',
      n: 1,
    });
  });

  it('数组里的、以及嵌套多层的 JSON 字符串都处理', () => {
    expect(expandNestedJson({ a: ['{"b":1}', 'plain'] })).toEqual({ a: [{ b: 1 }, 'plain'] });
    expect(expandNestedJson({ a: '{"b":"{\\"c\\":2}"}' })).toEqual({ a: { b: { c: 2 } } });
  });

  it('patch 文本原样保留（换行不能丢，也不能被当 JSON）', () => {
    const patch = '*** Begin Patch\n+hi\n*** End Patch\n';
    const out = expandNestedJson({ input: patch }) as { input: string };
    expect(out.input).toBe(patch);
    expect(out.input).toContain('\n');
  });

  /** raw 是 Entry 上的对象，改了会污染原文视图 */
  it('不修改入参', () => {
    const input = { arguments: '{"cmd":"ls"}', nested: { k: '[1]' } };
    const copy = structuredClone(input);
    expandNestedJson(input);
    expect(input).toEqual(copy);
  });

  /** 渲染时据此让这些子树默认展开——否则 payload.arguments 在第 2 层会是折叠的 */
  it('二次解析出来的子树记进 nested 集合，原有对象不记', () => {
    const nested = new WeakSet<object>();
    const out = expandNestedJson({ arguments: '{"cmd":"ls"}', keep: { a: 1 } }, nested) as Record<
      string,
      object
    >;
    expect(nested.has(out.arguments)).toBe(true);
    expect(nested.has(out.keep)).toBe(false);
    expect(nested.has(out)).toBe(false);
  });

  it('标量 / null 原样返回，不炸', () => {
    expect(expandNestedJson(null)).toBeNull();
    expect(expandNestedJson(5)).toBe(5);
    expect(expandNestedJson('plain')).toBe('plain');
  });

  /** rollout 是外部数据，病态深度宁可停住也不能栈溢出 */
  it('有深度上限，不会无限递归', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 200; i += 1) deep = { d: deep };
    expect(() => expandNestedJson(deep)).not.toThrow();
  });
});

describe('默认展开层级', () => {
  it('是 2：根 + 一层，payload 的直接子项可见，再深默认折叠', () => {
    expect(EXPAND_LEVELS).toBe(2);
  });
});
