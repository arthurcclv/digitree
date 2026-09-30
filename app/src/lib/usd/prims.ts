import { hexRgb, srgbToLinear, type Rgb } from "../colour";
import { asset, connect, decl, prop, rel, str, tuple, tuples, numbers, type Prim } from "./usda";

/**
 * The prims every package is built from: a `Mesh`, a `UsdPreviewSurface`
 * material, an `Xform`. Generic: they know no layer. See *A layer package* in
 * `specs/spec.md`.
 */

/** An sRGB hex colour as linear RGB, which `UsdPreviewSurface` constants are. */
export function linearRgb(hex: string): Rgb {
  return srgbToLinear(hexRgb(hex));
}

export interface MeshData {
  /** Flat `x, y, z` triples. */
  points: ArrayLike<number>;
  faceVertexCounts: ArrayLike<number>;
  faceVertexIndices: ArrayLike<number>;
  /** Flat triples, one per point. */
  normals?: ArrayLike<number>;
  /** Flat pairs, one per point. */
  st?: ArrayLike<number>;
  /** One colour for the whole mesh, linear. */
  displayColor?: Rgb;
  doubleSided?: boolean;
  /** The bound material's path. */
  material?: string;
  /** More property lines. */
  extra?: string[];
}

function extentOf(points: ArrayLike<number>): string {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], points[i + k]);
      max[k] = Math.max(max[k], points[i + k]);
    }
  }
  if (!Number.isFinite(min[0])) return "[(0, 0, 0), (0, 0, 0)]";
  return `[${tuple(min)}, ${tuple(max)}]`;
}

export function meshPrim(name: string, m: MeshData): Prim {
  const props: string[] = [];
  if (m.doubleSided) props.push(prop("bool", "doubleSided", "1", { uniform: true }));
  props.push(prop("float3[]", "extent", extentOf(m.points)));
  props.push(prop("int[]", "faceVertexCounts", numbers(m.faceVertexCounts)));
  props.push(prop("int[]", "faceVertexIndices", numbers(m.faceVertexIndices)));
  if (m.material) props.push(rel("material:binding", m.material));
  if (m.normals) props.push(prop("normal3f[]", "normals", tuples(m.normals, 3), { interpolation: "vertex" }));
  props.push(prop("point3f[]", "points", tuples(m.points, 3)));
  if (m.displayColor) {
    props.push(prop("color3f[]", "primvars:displayColor", `[${tuple(m.displayColor)}]`, { interpolation: "constant" }));
  }
  if (m.st) props.push(prop("texCoord2f[]", "primvars:st", tuples(m.st, 2), { interpolation: "vertex" }));
  props.push(prop("token", "subdivisionScheme", str("none"), { uniform: true }));
  props.push(...(m.extra ?? []));
  return {
    type: "Mesh",
    name,
    meta: m.material ? ['prepend apiSchemas = ["MaterialBindingAPI"]'] : undefined,
    props,
  };
}

export interface MaterialOptions {
  /** A constant base colour, linear. */
  diffuse?: Rgb;
  /** Read the base colour from the mesh's `displayColor` instead. */
  diffuseFromDisplayColor?: boolean;
  /** A texture inside the package, read with `st`, for the base colour. */
  texture?: string;
  /** Also take opacity from the texture's alpha. */
  opacityFromTexture?: boolean;
  /** Alpha-mask cutoff; 0 means blended. */
  opacityThreshold?: number;
  roughness?: number;
}

/** A `UsdPreviewSurface` material at `<parent>/<name>`. */
export function previewMaterial(parent: string, name: string, o: MaterialOptions): Prim {
  const path = `${parent}/${name}`;
  const surface: string[] = [prop("token", "info:id", str("UsdPreviewSurface"), { uniform: true })];
  const children: Prim[] = [];
  if (o.texture) {
    surface.push(connect("color3f", "inputs:diffuseColor", `${path}/Texture.outputs:rgb`));
    if (o.opacityFromTexture) surface.push(connect("float", "inputs:opacity", `${path}/Texture.outputs:a`));
  } else if (o.diffuseFromDisplayColor) {
    surface.push(connect("color3f", "inputs:diffuseColor", `${path}/DisplayColor.outputs:result`));
  } else {
    surface.push(prop("color3f", "inputs:diffuseColor", tuple(o.diffuse ?? [0.18, 0.18, 0.18])));
  }
  if (o.opacityThreshold) surface.push(prop("float", "inputs:opacityThreshold", String(o.opacityThreshold)));
  surface.push(prop("float", "inputs:roughness", String(o.roughness ?? 0.9)));
  surface.push(decl("token", "outputs:surface"));
  children.push({ type: "Shader", name: "Surface", props: surface });

  if (o.texture) {
    children.push({
      type: "Shader",
      name: "Texture",
      props: [
        prop("token", "info:id", str("UsdUVTexture"), { uniform: true }),
        prop("asset", "inputs:file", asset(o.texture)),
        prop("token", "inputs:sourceColorSpace", str("sRGB")),
        connect("float2", "inputs:st", `${path}/St.outputs:result`),
        prop("token", "inputs:wrapS", str("repeat")),
        prop("token", "inputs:wrapT", str("repeat")),
        decl("float", "outputs:a"),
        decl("float3", "outputs:rgb"),
      ],
    });
    children.push(primvarReader("St", "float2", "st"));
  }
  if (o.diffuseFromDisplayColor && !o.texture) children.push(primvarReader("DisplayColor", "float3", "displayColor"));

  return {
    type: "Material",
    name,
    props: [connect("token", "outputs:surface", `${path}/Surface.outputs:surface`)],
    children,
  };
}

function primvarReader(name: string, kind: "float2" | "float3", varname: string): Prim {
  return {
    type: "Shader",
    name,
    props: [
      prop("token", "info:id", str(`UsdPrimvarReader_${kind}`), { uniform: true }),
      prop("string", "inputs:varname", str(varname)),
      decl(kind, "outputs:result"),
    ],
  };
}

/** An `Xform` with the given ops, in order: `translate`, then `rotateX`, then `scale`. */
export function xform(
  name: string,
  children: Prim[],
  ops: { translate?: [number, number, number]; rotateXDeg?: number } = {},
  meta?: string[],
): Prim {
  const props: string[] = [];
  const order: string[] = [];
  if (ops.translate) {
    props.push(prop("double3", "xformOp:translate", tuple(ops.translate)));
    order.push("xformOp:translate");
  }
  if (ops.rotateXDeg !== undefined) {
    props.push(prop("float", "xformOp:rotateX", String(ops.rotateXDeg)));
    order.push("xformOp:rotateX");
  }
  if (order.length) props.push(prop("token[]", "xformOpOrder", `[${order.map(str).join(", ")}]`, { uniform: true }));
  return { type: "Xform", name, meta, props, children };
}
