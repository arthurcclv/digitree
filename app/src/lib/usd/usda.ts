/**
 * A minimal `.usda` text writer: prims, typed properties and layer metadata,
 * for `specs/spec.md`. Written by hand, like the GeoTIFF writer, because the
 * subset needed is small. It knows no layer and no schema beyond the few
 * value forms below; each caller names its own types.
 *
 * Every number goes through `num`, so the same scene always prints the same
 * text (invariant 3).
 */

/** A number as USD reads it: at most `digits` decimals, trailing zeros trimmed, never `-0`. */
export function num(n: number, digits = 6): string {
  if (!Number.isFinite(n)) throw new Error(`not a finite number: ${n}`);
  const s = n.toFixed(digits).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}

/** A quoted USD string. */
export function str(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}

/** An asset path. `@` cannot appear inside one. */
export function asset(path: string): string {
  if (path.includes("@")) throw new Error(`asset path holds "@": ${path}`);
  return `@${path}@`;
}

/** A tuple, `(1, 2, 3)`. */
export function tuple(values: readonly number[], digits?: number): string {
  return `(${values.map((v) => num(v, digits)).join(", ")})`;
}

/** An array of scalars. */
export function numbers(values: ArrayLike<number>, digits?: number): string {
  const out: string[] = new Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = num(values[i], digits);
  return `[${out.join(", ")}]`;
}

/** An array of `k`-tuples from a flat list. */
export function tuples(flat: ArrayLike<number>, k: number, digits?: number): string {
  if (flat.length % k) throw new Error(`${flat.length} values is not a whole number of ${k}-tuples`);
  const out: string[] = new Array(flat.length / k);
  for (let i = 0; i < flat.length; i += k) {
    let t = num(flat[i], digits);
    for (let j = 1; j < k; j++) t += `, ${num(flat[i + j], digits)}`;
    out[i / k] = `(${t})`;
  }
  return `[${out.join(", ")}]`;
}

/** An array of strings. */
export function strings(values: readonly string[]): string {
  return `[${values.map(str).join(", ")}]`;
}

/** A value inside a metadata dictionary. */
export type DictValue = string | number | boolean | string[] | { asset: string } | { [key: string]: DictValue };

function dictEntry(key: string, v: DictValue, indent: string): string {
  if (typeof v === "string") return `${indent}string ${key} = ${str(v)}`;
  if (typeof v === "number") return `${indent}double ${key} = ${num(v, 9)}`;
  if (typeof v === "boolean") return `${indent}bool ${key} = ${v ? 1 : 0}`;
  if (Array.isArray(v)) return `${indent}string[] ${key} = ${strings(v)}`;
  if ("asset" in v && typeof v.asset === "string") return `${indent}asset ${key} = ${asset(v.asset)}`;
  return `${indent}dictionary ${key} = ${dict(v as Record<string, DictValue>, indent)}`;
}

/** A dictionary, keys sorted. `indent` is the indentation of the line it opens on. */
export function dict(d: Record<string, DictValue>, indent = ""): string {
  const inner = `${indent}    `;
  const keys = Object.keys(d).sort();
  if (!keys.length) return "{\n" + `${indent}}`;
  return `{\n${keys.map((k) => dictEntry(k, d[k], inner)).join("\n")}\n${indent}}`;
}

/** One prim. `props` are whole property lines, as `prop` and `rel` build them. */
export interface Prim {
  type: string;
  name: string;
  /** Prim metadata lines, as `prepend references = @./a.usdz@`. */
  meta?: string[];
  props?: string[];
  children?: Prim[];
}

export interface PropOptions {
  uniform?: boolean;
  /** Primvar interpolation, written as property metadata. */
  interpolation?: "constant" | "uniform" | "vertex" | "faceVarying";
}

/** A property line: `[uniform ]<type> <name> = <value>[ (interpolation = …)]`. */
export function prop(type: string, name: string, value: string, opts: PropOptions = {}): string {
  const head = `${opts.uniform ? "uniform " : ""}${type} ${name}`;
  const meta = opts.interpolation ? ` (\n    interpolation = ${str(opts.interpolation)}\n)` : "";
  return `${head} = ${value}${meta}`;
}

/** A property declared with no value, as a shader output: `<type> <name>`. */
export function decl(type: string, name: string): string {
  return `${type} ${name}`;
}

/** A connection: `<type> <name>.connect = </path.output>`. */
export function connect(type: string, name: string, target: string): string {
  return `${type} ${name}.connect = <${target}>`;
}

/** A relationship: `rel <name> = </path>`. */
export function rel(name: string, target: string): string {
  return `rel ${name} = <${target}>`;
}

function indentLines(text: string, indent: string): string {
  return text
    .split("\n")
    .map((l) => (l ? indent + l : l))
    .join("\n");
}

function primText(p: Prim, indent: string): string {
  const typed = p.type ? `${p.type} ` : "";
  const meta = p.meta?.length ? ` (\n${p.meta.map((m) => `${indent}    ${m}`).join("\n")}\n${indent})` : "";
  const props = (p.props ?? []).map((l) => indentLines(l, `${indent}    `)).join("\n");
  const children = (p.children ?? []).map((c) => primText(c, `${indent}    `)).join("\n\n");
  const inside = [props, children].filter(Boolean).join("\n\n");
  return `${indent}def ${typed}"${p.name}"${meta}\n${indent}{\n${inside ? inside + "\n" : ""}${indent}}`;
}

/** Layer metadata: `defaultPrim`, `upAxis`, `metersPerUnit`, `customLayerData`, … */
export interface LayerMeta {
  defaultPrim: string;
  upAxis: "Y" | "Z";
  metersPerUnit: number;
  customLayerData?: Record<string, DictValue>;
}

/** A whole `.usda` layer. */
export function layer(meta: LayerMeta, prims: Prim[]): string {
  const lines: string[] = [];
  if (meta.customLayerData) lines.push(`    customLayerData = ${dict(meta.customLayerData, "    ")}`);
  lines.push(`    defaultPrim = ${str(meta.defaultPrim)}`);
  lines.push(`    metersPerUnit = ${num(meta.metersPerUnit)}`);
  lines.push(`    upAxis = ${str(meta.upAxis)}`);
  return `#usda 1.0\n(\n${lines.join("\n")}\n)\n\n${prims.map((p) => primText(p, "")).join("\n\n")}\n`;
}

/** A prim name from free text: USD identifiers are `[A-Za-z_][A-Za-z0-9_]*`. */
export function identifier(s: string): string {
  const id = s.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(id) ? id : `_${id}`;
}
