import { z } from 'zod';

// Routes can (1) filter events with AND-ed conditions and (2) reshape the payload
// with a declarative mapping before it is delivered to a destination.

export const conditionSchema = z.object({
  path: z.string().min(1).max(200),
  op: z.enum(['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'exists', 'in']),
  value: z.unknown().optional(),
});
export type Condition = z.infer<typeof conditionSchema>;

const mappingValue = z.union([
  z.string().min(1).max(200), // source path, e.g. "data.customer.email"
  z.object({ const: z.unknown() }), // literal value
  z.object({ template: z.string().max(2000) }), // string template: "Order {{data.id}} paid"
]);
export const mappingSchema = z.record(z.string().min(1).max(200), mappingValue);
export type Mapping = z.infer<typeof mappingSchema>;

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function getPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const key of path.split('.')) {
    if (current === null || current === undefined || UNSAFE_KEYS.has(key)) return undefined;
    if (Array.isArray(current)) {
      const index = Number(key);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (typeof current === 'object') {
      current = Object.prototype.hasOwnProperty.call(current, key)
        ? (current as Record<string, unknown>)[key]
        : undefined;
    } else {
      return undefined;
    }
  }
  return current;
}

export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  if (keys.some((k) => UNSAFE_KEYS.has(k))) throw new Error(`Unsafe mapping key in "${path}"`);
  let node = target;
  keys.forEach((key, i) => {
    if (i === keys.length - 1) {
      node[key] = value;
      return;
    }
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  });
}

function compare(actual: unknown, op: Condition['op'], expected: unknown): boolean {
  switch (op) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'contains':
      if (typeof actual === 'string') return typeof expected === 'string' && actual.includes(expected);
      if (Array.isArray(actual)) return actual.includes(expected);
      return false;
    case 'in':
      return Array.isArray(expected) && expected.includes(actual);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = Number(actual);
      const b = Number(expected);
      if (Number.isNaN(a) || Number.isNaN(b) || actual === null || actual === '') return false;
      if (op === 'gt') return a > b;
      if (op === 'gte') return a >= b;
      if (op === 'lt') return a < b;
      return a <= b;
    }
  }
}

export function matchesConditions(conditions: Condition[], doc: unknown): boolean {
  return conditions.every((c) => compare(getPath(doc, c.path), c.op, c.value));
}

export function renderTemplate(template: string, doc: unknown): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const v = getPath(doc, path);
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

export function applyMapping(mapping: Mapping | null | undefined, doc: unknown): unknown {
  if (!mapping || Object.keys(mapping).length === 0) return doc;
  const out: Record<string, unknown> = {};
  for (const [target, rule] of Object.entries(mapping)) {
    let value: unknown;
    if (typeof rule === 'string') value = getPath(doc, rule);
    else if ('const' in rule) value = rule.const;
    else value = renderTemplate(rule.template, doc);
    if (value !== undefined) setPath(out, target, value);
  }
  return out;
}
