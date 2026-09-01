import { orient2d, orient3d } from "robust-predicates";
import type { SaxesAttributeNS, SaxesTagNS } from "saxes";
import type { DirectModelFormat } from "./model-file";

const MAX_PREVIEW_TRIANGLES = 6_000;
const MAX_LOCAL_TRIANGLES = 100_000;
const MAX_3MF_MODEL_XML_BYTES = 16 * 1024 * 1024;
const MAX_3MF_TOTAL_XML_BYTES = 32 * 1024 * 1024;
const MAX_3MF_ARCHIVE_ENTRIES = 1_024;
const MAX_3MF_OBJECTS = 10_000;
const MAX_3MF_VERTICES = 300_000;
const MAX_3MF_COMPONENTS = 20_000;
const MAX_3MF_COMPONENT_DEPTH = 64;
const MAX_3MF_EXPANDED_OBJECTS = 25_000;
const MAX_LOCAL_CONTAINMENT_TRIANGLE_CHECKS = 4 * MAX_LOCAL_TRIANGLES;
const MAX_LOCAL_INTERSHELL_GEOMETRY_CHECKS = 4 * MAX_LOCAL_TRIANGLES;
const MAX_LOCAL_SHELL_PAIR_CHECKS = 1_000_000;
const TRIANGLE_BVH_LEAF_SIZE = 8;
const PACKAGE_RELATIONSHIPS_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const CORE_3MF_NAMESPACE =
  "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
const MATERIAL_3MF_NAMESPACE =
  "http://schemas.microsoft.com/3dmanufacturing/material/2015/02";
const PRODUCTION_3MF_NAMESPACE =
  "http://schemas.microsoft.com/3dmanufacturing/production/2015/06";
const SLIC3R_3MF_NAMESPACE = "http://schemas.slic3r.org/3mf/2017/06";

type Point = readonly [number, number, number];
type TrianglePoints = readonly [Point, Point, Point];
type Transform = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

interface MeshObject {
  components: { objectId: string; transform: Transform }[];
  id: string;
  name?: string;
  triangles: readonly [number, number, number][];
  vertices: Point[];
}

export interface ModelDimensions {
  depth: number;
  height: number;
  width: number;
}

export interface ModelGeometry {
  bodyNames: string[];
  dimensions: ModelDimensions;
  objectCount: number;
  parseDurationMs: number;
  previewTriangles: number[];
  triangleCount: number;
  volumeMm3: number;
}

export type ModelGeometryErrorCode =
  | "INVALID_GEOMETRY"
  | "PAINTED_OR_MULTIMATERIAL_3MF"
  | "PREVIEW_LIMIT_EXCEEDED";

export class ModelGeometryError extends Error {
  constructor(
    readonly code: ModelGeometryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ModelGeometryError";
  }
}

class GeometryAccumulator {
  private readonly maximum = [
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  private readonly minimum = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ];
  readonly previewTriangles: number[] = [];
  triangleCount = 0;
  volumeMm3 = 0;

  addBody(
    triangles: readonly TrianglePoints[],
    explicitVolumeMm3?: number,
  ): void {
    let signedVolume = 0;
    for (const [a, b, c] of triangles) {
      if (this.triangleCount >= MAX_LOCAL_TRIANGLES) {
        throw new ModelGeometryError(
          "PREVIEW_LIMIT_EXCEEDED",
          "Model je příliš složitý pro rychlý náhled v prohlížeči.",
        );
      }
      for (const point of [a, b, c]) {
        for (let axis = 0; axis < 3; axis += 1) {
          this.minimum[axis] = Math.min(this.minimum[axis]!, point[axis]!);
          this.maximum[axis] = Math.max(this.maximum[axis]!, point[axis]!);
        }
      }
      signedVolume +=
        (a[0] * (b[1] * c[2] - b[2] * c[1]) -
          a[1] * (b[0] * c[2] - b[2] * c[0]) +
          a[2] * (b[0] * c[1] - b[1] * c[0])) /
        6;
      this.triangleCount += 1;
      if (this.triangleCount <= MAX_PREVIEW_TRIANGLES) {
        this.previewTriangles.push(...a, ...b, ...c);
      }
    }
    this.volumeMm3 += explicitVolumeMm3 ?? Math.abs(signedVolume);
  }

  finish(): Pick<
    ModelGeometry,
    "dimensions" | "previewTriangles" | "triangleCount" | "volumeMm3"
  > {
    if (this.triangleCount === 0) {
      throw new ModelGeometryError(
        "INVALID_GEOMETRY",
        "V souboru jsme nenašli žádnou tisknutelnou geometrii.",
      );
    }
    return {
      dimensions: {
        width: this.maximum[0]! - this.minimum[0]!,
        depth: this.maximum[1]! - this.minimum[1]!,
        height: this.maximum[2]! - this.minimum[2]!,
      },
      previewTriangles: this.previewTriangles,
      triangleCount: this.triangleCount,
      volumeMm3: this.volumeMm3,
    };
  }
}

function pointKey(point: Point): string {
  return `${point[0]},${point[1]},${point[2]}`;
}

function connectedTriangleBodies(
  triangles: readonly TrianglePoints[],
): TrianglePoints[][] {
  const parents = triangles.map((_, index) => index);
  const edgeOwners = new Map<string, number>();
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root]!;
    while (parents[index] !== index) {
      const next = parents[index]!;
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const unite = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };

  triangles.forEach((triangle, triangleIndex) => {
    const keys = triangle.map(pointKey);
    for (const [left, right] of [
      [keys[0]!, keys[1]!],
      [keys[1]!, keys[2]!],
      [keys[2]!, keys[0]!],
    ] as const) {
      const edge = left < right ? `${left}|${right}` : `${right}|${left}`;
      const owner = edgeOwners.get(edge);
      if (owner === undefined) edgeOwners.set(edge, triangleIndex);
      else unite(triangleIndex, owner);
    }
  });

  const bodies = new Map<number, TrianglePoints[]>();
  triangles.forEach((triangle, triangleIndex) => {
    const root = find(triangleIndex);
    const body = bodies.get(root) ?? [];
    body.push(triangle);
    bodies.set(root, body);
  });
  return [...bodies.values()];
}

function triangleBodyBounds(triangles: readonly TrianglePoints[]): {
  maximum: [number, number, number];
  minimum: [number, number, number];
} {
  const minimum: [number, number, number] = [Infinity, Infinity, Infinity];
  const maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const triangle of triangles) {
    for (const point of triangle) {
      for (let axis = 0; axis < 3; axis += 1) {
        minimum[axis] = Math.min(minimum[axis]!, point[axis]!);
        maximum[axis] = Math.max(maximum[axis]!, point[axis]!);
      }
    }
  }
  return { maximum, minimum };
}

function strictlyContainsBounds(
  outer: ReturnType<typeof triangleBodyBounds>,
  inner: ReturnType<typeof triangleBodyBounds>,
): boolean {
  return outer.minimum.every(
    (minimum, axis) =>
      minimum < inner.minimum[axis]! &&
      outer.maximum[axis]! > inner.maximum[axis]!,
  );
}

type TriangleBounds = ReturnType<typeof triangleBodyBounds>;

interface TriangleBvh {
  bounds: TriangleBounds;
  left?: TriangleBvh;
  right?: TriangleBvh;
  triangleCount: number;
  triangles?: TrianglePoints[];
}

function boundsOverlap(left: TriangleBounds, right: TriangleBounds): boolean {
  return left.minimum.every(
    (minimum, axis) =>
      left.maximum[axis]! >= right.minimum[axis]! &&
      right.maximum[axis]! >= minimum,
  );
}

function buildTriangleBvh(triangles: readonly TrianglePoints[]): TriangleBvh {
  const bounds = triangleBodyBounds(triangles);
  if (triangles.length <= TRIANGLE_BVH_LEAF_SIZE) {
    return {
      bounds,
      triangleCount: triangles.length,
      triangles: [...triangles],
    };
  }
  let splitAxis = 0;
  for (let axis = 1; axis < 3; axis += 1) {
    if (
      bounds.maximum[axis]! - bounds.minimum[axis]! >
      bounds.maximum[splitAxis]! - bounds.minimum[splitAxis]!
    ) {
      splitAxis = axis;
    }
  }
  const sorted = [...triangles].sort((left, right) => {
    const center = (triangle: TrianglePoints) =>
      (triangle[0][splitAxis]! +
        triangle[1][splitAxis]! +
        triangle[2][splitAxis]!) /
      3;
    return center(left) - center(right);
  });
  const middle = Math.floor(sorted.length / 2);
  return {
    bounds,
    left: buildTriangleBvh(sorted.slice(0, middle)),
    right: buildTriangleBvh(sorted.slice(middle)),
    triangleCount: sorted.length,
  };
}

function projectedPoint(
  point: Point,
  projection: number,
): readonly [number, number] {
  return projection === 0
    ? [point[1], point[2]]
    : projection === 1
      ? [point[0], point[2]]
      : [point[0], point[1]];
}

function triangleProjection(triangle: TrianglePoints): number {
  for (let projection = 0; projection < 3; projection += 1) {
    const [a, b, c] = triangle.map((point) =>
      projectedPoint(point, projection),
    );
    if (orient2d(...a!, ...b!, ...c!) !== 0) return projection;
  }
  throw new ModelGeometryError(
    "INVALID_GEOMETRY",
    "Model obsahuje degenerovanou plochu.",
  );
}

function pointInTriangle2d(
  point: readonly [number, number],
  triangle: readonly [
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
  ],
): boolean {
  const [a, b, c] = triangle;
  const ab = orient2d(...a, ...b, ...point);
  const bc = orient2d(...b, ...c, ...point);
  const ca = orient2d(...c, ...a, ...point);
  return (ab >= 0 && bc >= 0 && ca >= 0) || (ab <= 0 && bc <= 0 && ca <= 0);
}

function pointOnSegment2d(
  point: readonly [number, number],
  start: readonly [number, number],
  end: readonly [number, number],
): boolean {
  return (
    Math.min(start[0], end[0]) <= point[0] &&
    point[0] <= Math.max(start[0], end[0]) &&
    Math.min(start[1], end[1]) <= point[1] &&
    point[1] <= Math.max(start[1], end[1])
  );
}

function segmentsTouch2d(
  leftStart: readonly [number, number],
  leftEnd: readonly [number, number],
  rightStart: readonly [number, number],
  rightEnd: readonly [number, number],
): boolean {
  const leftToRightStart = orient2d(...leftStart, ...leftEnd, ...rightStart);
  const leftToRightEnd = orient2d(...leftStart, ...leftEnd, ...rightEnd);
  const rightToLeftStart = orient2d(...rightStart, ...rightEnd, ...leftStart);
  const rightToLeftEnd = orient2d(...rightStart, ...rightEnd, ...leftEnd);
  if (
    ((leftToRightStart > 0 && leftToRightEnd < 0) ||
      (leftToRightStart < 0 && leftToRightEnd > 0)) &&
    ((rightToLeftStart > 0 && rightToLeftEnd < 0) ||
      (rightToLeftStart < 0 && rightToLeftEnd > 0))
  ) {
    return true;
  }
  return (
    (leftToRightStart === 0 &&
      pointOnSegment2d(rightStart, leftStart, leftEnd)) ||
    (leftToRightEnd === 0 && pointOnSegment2d(rightEnd, leftStart, leftEnd)) ||
    (rightToLeftStart === 0 &&
      pointOnSegment2d(leftStart, rightStart, rightEnd)) ||
    (rightToLeftEnd === 0 && pointOnSegment2d(leftEnd, rightStart, rightEnd))
  );
}

function coplanarSegmentTouchesTriangle(
  start: Point,
  end: Point,
  triangle: TrianglePoints,
): boolean {
  const projection = triangleProjection(triangle);
  const projectedStart = projectedPoint(start, projection);
  const projectedEnd = projectedPoint(end, projection);
  const projectedTriangle = triangle.map((point) =>
    projectedPoint(point, projection),
  ) as [
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
  ];
  if (
    pointInTriangle2d(projectedStart, projectedTriangle) ||
    pointInTriangle2d(projectedEnd, projectedTriangle)
  ) {
    return true;
  }
  return projectedTriangle.some((edgeStart, index) =>
    segmentsTouch2d(
      projectedStart,
      projectedEnd,
      edgeStart,
      projectedTriangle[(index + 1) % 3]!,
    ),
  );
}

function segmentTouchesTriangle(
  start: Point,
  end: Point,
  triangle: TrianglePoints,
): boolean {
  const [a, b, c] = triangle;
  const startSide = orient3d(...a, ...b, ...c, ...start);
  const endSide = orient3d(...a, ...b, ...c, ...end);
  if ((startSide > 0 && endSide > 0) || (startSide < 0 && endSide < 0)) {
    return false;
  }
  if (startSide === 0 && endSide === 0) {
    return coplanarSegmentTouchesTriangle(start, end, triangle);
  }
  const ab = orient3d(...start, ...end, ...a, ...b);
  const bc = orient3d(...start, ...end, ...b, ...c);
  const ca = orient3d(...start, ...end, ...c, ...a);
  return (ab >= 0 && bc >= 0 && ca >= 0) || (ab <= 0 && bc <= 0 && ca <= 0);
}

function trianglesTouchOrIntersect(
  left: TrianglePoints,
  right: TrianglePoints,
): boolean {
  const edges = (triangle: TrianglePoints) =>
    [
      [triangle[0], triangle[1]],
      [triangle[1], triangle[2]],
      [triangle[2], triangle[0]],
    ] as const;
  return (
    edges(left).some(([start, end]) =>
      segmentTouchesTriangle(start, end, right),
    ) ||
    edges(right).some(([start, end]) =>
      segmentTouchesTriangle(start, end, left),
    )
  );
}

function spendIntershellCheck(budget: ShellInspectionBudget): void {
  budget.intershellGeometryChecks += 1;
  if (budget.intershellGeometryChecks > MAX_LOCAL_INTERSHELL_GEOMETRY_CHECKS) {
    throw new ModelGeometryError(
      "PREVIEW_LIMIT_EXCEEDED",
      "Model je příliš složitý pro bezpečnou kontrolu oddělených těles.",
    );
  }
}

function shellsTouchOrIntersect(
  left: TriangleBvh,
  right: TriangleBvh,
  budget: ShellInspectionBudget,
): boolean {
  const pending: Array<readonly [TriangleBvh, TriangleBvh]> = [[left, right]];
  while (pending.length > 0) {
    const [leftNode, rightNode] = pending.pop()!;
    spendIntershellCheck(budget);
    if (!boundsOverlap(leftNode.bounds, rightNode.bounds)) continue;
    if (leftNode.triangles && rightNode.triangles) {
      for (const leftTriangle of leftNode.triangles) {
        for (const rightTriangle of rightNode.triangles) {
          spendIntershellCheck(budget);
          if (
            boundsOverlap(
              triangleBodyBounds([leftTriangle]),
              triangleBodyBounds([rightTriangle]),
            ) &&
            trianglesTouchOrIntersect(leftTriangle, rightTriangle)
          ) {
            return true;
          }
        }
      }
      continue;
    }
    if (
      rightNode.triangles ||
      (!leftNode.triangles && leftNode.triangleCount >= rightNode.triangleCount)
    ) {
      pending.push([leftNode.left!, rightNode], [leftNode.right!, rightNode]);
    } else {
      pending.push([leftNode, rightNode.left!], [leftNode, rightNode.right!]);
    }
  }
  return false;
}

function pointInsideShell(
  point: Point,
  triangles: readonly TrianglePoints[],
  budget: ShellInspectionBudget,
): boolean {
  let solidAngle = 0;
  let compensation = 0;
  for (const triangle of triangles) {
    budget.containmentTriangleChecks += 1;
    if (
      budget.containmentTriangleChecks > MAX_LOCAL_CONTAINMENT_TRIANGLE_CHECKS
    ) {
      throw new ModelGeometryError(
        "PREVIEW_LIMIT_EXCEEDED",
        "Model je příliš složitý pro bezpečné rozpoznání vnořených těles.",
      );
    }
    const [a, b, c] = triangle.map(
      (vertex) =>
        [
          vertex[0] - point[0],
          vertex[1] - point[1],
          vertex[2] - point[2],
        ] as Point,
    );
    const aLength = Math.hypot(...a!);
    const bLength = Math.hypot(...b!);
    const cLength = Math.hypot(...c!);
    if (aLength === 0 || bLength === 0 || cLength === 0) {
      throw new ModelGeometryError(
        "INVALID_GEOMETRY",
        "Model obsahuje dotýkající se nebo protínající se tělesa.",
      );
    }
    const numerator =
      a![0] * (b![1] * c![2] - b![2] * c![1]) -
      a![1] * (b![0] * c![2] - b![2] * c![0]) +
      a![2] * (b![0] * c![1] - b![1] * c![0]);
    const denominator =
      aLength * bLength * cLength +
      (a![0] * b![0] + a![1] * b![1] + a![2] * b![2]) * cLength +
      (b![0] * c![0] + b![1] * c![1] + b![2] * c![2]) * aLength +
      (c![0] * a![0] + c![1] * a![1] + c![2] * a![2]) * bLength;
    const angle = 2 * Math.atan2(numerator, denominator);
    const corrected = angle - compensation;
    const next = solidAngle + corrected;
    compensation = next - solidAngle - corrected;
    solidAngle = next;
  }
  const winding = Math.abs(solidAngle) / (4 * Math.PI);
  if (winding <= 1e-6) return false;
  if (Math.abs(winding - 1) <= 1e-6) return true;
  throw new ModelGeometryError(
    "INVALID_GEOMETRY",
    "Model obsahuje dotýkající se nebo protínající se tělesa.",
  );
}

function signedShellVolume(triangles: readonly TrianglePoints[]): number {
  return triangles.reduce(
    (volume, [a, b, c]) =>
      volume +
      (a[0] * (b[1] * c[2] - b[2] * c[1]) -
        a[1] * (b[0] * c[2] - b[2] * c[0]) +
        a[2] * (b[0] * c[1] - b[1] * c[0])) /
        6,
    0,
  );
}

interface ShellInspectionBudget {
  containmentTriangleChecks: number;
  intershellGeometryChecks: number;
  shellPairChecks: number;
}

function nestedShellVolume(
  shells: readonly TrianglePoints[][],
  budget: ShellInspectionBudget,
): number {
  budget.shellPairChecks += (shells.length * (shells.length - 1)) / 2;
  if (budget.shellPairChecks > MAX_LOCAL_SHELL_PAIR_CHECKS) {
    throw new ModelGeometryError(
      "PREVIEW_LIMIT_EXCEEDED",
      "Model obsahuje příliš mnoho oddělených těles pro bezpečný náhled.",
    );
  }
  const bounds = shells.map(triangleBodyBounds);
  const bvhs = new Map<number, TriangleBvh>();
  const bvh = (shellIndex: number): TriangleBvh => {
    const cached = bvhs.get(shellIndex);
    if (cached) return cached;
    const created = buildTriangleBvh(shells[shellIndex]!);
    bvhs.set(shellIndex, created);
    return created;
  };
  for (let leftIndex = 0; leftIndex < shells.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < shells.length;
      rightIndex += 1
    ) {
      if (
        boundsOverlap(bounds[leftIndex]!, bounds[rightIndex]!) &&
        shellsTouchOrIntersect(bvh(leftIndex), bvh(rightIndex), budget)
      ) {
        throw new ModelGeometryError(
          "INVALID_GEOMETRY",
          "Model obsahuje dotýkající se nebo protínající se tělesa.",
        );
      }
    }
  }
  let volumeMm3 = 0;
  shells.forEach((inner, innerIndex) => {
    let depth = 0;
    shells.forEach((outer, outerIndex) => {
      if (
        outerIndex !== innerIndex &&
        strictlyContainsBounds(bounds[outerIndex]!, bounds[innerIndex]!) &&
        pointInsideShell(inner[0]![0], outer, budget)
      ) {
        depth += 1;
      }
    });
    const shellVolume = Math.abs(signedShellVolume(inner));
    volumeMm3 += depth % 2 === 0 ? shellVolume : -shellVolume;
  });
  if (volumeMm3 < 0) {
    throw new ModelGeometryError(
      "INVALID_GEOMETRY",
      "Model obsahuje neplatně vnořená tělesa.",
    );
  }
  return volumeMm3;
}

function addStlBodies(
  geometry: GeometryAccumulator,
  triangles: readonly TrianglePoints[],
): void {
  const budget: ShellInspectionBudget = {
    containmentTriangleChecks: 0,
    intershellGeometryChecks: 0,
    shellPairChecks: 0,
  };
  const shells = connectedTriangleBodies(triangles);
  geometry.addBody(triangles, nestedShellVolume(shells, budget));
}

function finitePoint(x: number, y: number, z: number): Point {
  if (![x, y, z].every(Number.isFinite)) {
    throw new ModelGeometryError(
      "INVALID_GEOMETRY",
      "Geometrie obsahuje neplatné souřadnice.",
    );
  }
  return [x, y, z];
}

function parseBinaryStl(bytes: Uint8Array): ModelGeometry | undefined {
  if (bytes.byteLength < 84) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triangleCount = view.getUint32(80, true);
  if (84 + triangleCount * 50 !== bytes.byteLength) return undefined;
  if (triangleCount > MAX_LOCAL_TRIANGLES) {
    throw new ModelGeometryError(
      "PREVIEW_LIMIT_EXCEEDED",
      "Model je příliš složitý pro rychlý náhled v prohlížeči.",
    );
  }

  const geometry = new GeometryAccumulator();
  const triangles: TrianglePoints[] = [];
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const offset = 84 + triangle * 50 + 12;
    const points = [0, 1, 2].map((vertex) => {
      const vertexOffset = offset + vertex * 12;
      return finitePoint(
        view.getFloat32(vertexOffset, true),
        view.getFloat32(vertexOffset + 4, true),
        view.getFloat32(vertexOffset + 8, true),
      );
    });
    triangles.push([points[0]!, points[1]!, points[2]!]);
  }
  addStlBodies(geometry, triangles);

  return {
    ...geometry.finish(),
    bodyNames: ["Těleso 1"],
    objectCount: 1,
    parseDurationMs: 0,
  };
}

function parseAsciiStl(bytes: Uint8Array): ModelGeometry {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ModelGeometryError(
      "INVALID_GEOMETRY",
      "Soubor STL nemá platnou binární ani textovou strukturu.",
    );
  }

  if (!/^\s*solid(?:\s|$)/iu.test(source)) {
    throw new ModelGeometryError(
      "INVALID_GEOMETRY",
      "Soubor neodpovídá formátu STL.",
    );
  }

  const geometry = new GeometryAccumulator();
  const vertices: Point[] = [];
  const triangles: TrianglePoints[] = [];
  const vertexPattern =
    /\bvertex\s+([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:e[-+]?\d+)?)/giu;
  for (const match of source.matchAll(vertexPattern)) {
    vertices.push(
      finitePoint(Number(match[1]), Number(match[2]), Number(match[3])),
    );
    if (vertices.length === 3) {
      if (triangles.length >= MAX_LOCAL_TRIANGLES) {
        throw new ModelGeometryError(
          "PREVIEW_LIMIT_EXCEEDED",
          "Model je příliš složitý pro rychlý náhled v prohlížeči.",
        );
      }
      triangles.push([vertices[0]!, vertices[1]!, vertices[2]!]);
      vertices.length = 0;
    }
  }
  if (vertices.length !== 0) {
    throw new ModelGeometryError(
      "INVALID_GEOMETRY",
      "Textový STL soubor obsahuje neúplnou plochu.",
    );
  }
  addStlBodies(geometry, triangles);

  return {
    ...geometry.finish(),
    bodyNames: ["Těleso 1"],
    objectCount: 1,
    parseDurationMs: 0,
  };
}

function parseStl(bytes: Uint8Array): ModelGeometry {
  return parseBinaryStl(bytes) ?? parseAsciiStl(bytes);
}

function attribute(source: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(
    `(?:^|\\s)(?:[\\w.-]+:)?${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    "iu",
  ).exec(source);
  return match?.[1] ?? match?.[2];
}

function exactAttribute(source: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(
    `(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    "iu",
  ).exec(source);
  return match?.[1] ?? match?.[2];
}

function requiredNumber(source: string, name: string): number {
  const raw = attribute(source, name);
  const value =
    raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(value)) {
    throw new ModelGeometryError(
      "INVALID_GEOMETRY",
      `3MF obsahuje neplatnou hodnotu ${name}.`,
    );
  }
  return value;
}

const identityTransform: Transform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function parseTransform(
  value: string | undefined,
  translationScale: number,
): Transform {
  if (!value) return identityTransform;
  const parts = value.trim().split(/\s+/u).map(Number);
  if (parts.length !== 12 || parts.some((part) => !Number.isFinite(part))) {
    throw new ModelGeometryError(
      "INVALID_GEOMETRY",
      "3MF obsahuje neplatnou transformaci objektu.",
    );
  }
  const determinant =
    parts[0]! * (parts[4]! * parts[8]! - parts[5]! * parts[7]!) -
    parts[1]! * (parts[3]! * parts[8]! - parts[5]! * parts[6]!) +
    parts[2]! * (parts[3]! * parts[7]! - parts[4]! * parts[6]!);
  if (Math.abs(determinant) < 1e-12) {
    throw new ModelGeometryError(
      "INVALID_GEOMETRY",
      "3MF obsahuje singulární transformaci objektu.",
    );
  }
  parts[9] = parts[9]! * translationScale;
  parts[10] = parts[10]! * translationScale;
  parts[11] = parts[11]! * translationScale;
  return parts as unknown as Transform;
}

function transformPoint(point: Point, transform: Transform): Point {
  return finitePoint(
    point[0] * transform[0] +
      point[1] * transform[3] +
      point[2] * transform[6] +
      transform[9],
    point[0] * transform[1] +
      point[1] * transform[4] +
      point[2] * transform[7] +
      transform[10],
    point[0] * transform[2] +
      point[1] * transform[5] +
      point[2] * transform[8] +
      transform[11],
  );
}

function applyTransforms(
  point: Point,
  transforms: readonly Transform[],
): Point {
  return transforms.reduce(transformPoint, point);
}

function unitScale(xml: string): number {
  const modelTag = /<(?:[\w.-]+:)?model\b([^>]*)>/iu.exec(xml)?.[1] ?? "";
  const unit = (attribute(modelTag, "unit") ?? "millimeter").toLowerCase();
  const scales: Record<string, number> = {
    centimeter: 10,
    foot: 304.8,
    inch: 25.4,
    meter: 1_000,
    micron: 0.001,
    millimeter: 1,
  };
  const scale = scales[unit];
  if (!scale) {
    throw new ModelGeometryError(
      "INVALID_GEOMETRY",
      `Jednotku ${unit} v souboru 3MF neumíme přečíst.`,
    );
  }
  return scale;
}

type PreviewPropertyResource =
  | { entryCount: number; kind: "appearance" }
  | { entryCount: number; kind: "base" }
  | {
      entries: string[][];
      kind: "composite";
      materialIndices: string[];
      materialResourceId: string;
    }
  | { entries: string[][]; kind: "multi"; resourceIds: string[] };

function xmlElements(
  source: string,
  localName: string,
): Array<{ attributes: string; body: string }> {
  const pattern = new RegExp(
    `<(?:[\\w.-]+:)?${localName}\\b([^>]*)>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${localName}\\s*>`,
    "giu",
  );
  return [...source.matchAll(pattern)].map((match) => ({
    attributes: match[1] ?? "",
    body: match[2] ?? "",
  }));
}

function xmlTagAttributes(source: string, localName: string): string[] {
  const pattern = new RegExp(
    `<(?:[\\w.-]+:)?${localName}\\b([^>]*)\\/?\\s*>`,
    "giu",
  );
  return [...source.matchAll(pattern)].map((match) => match[1] ?? "");
}

function indexList(value: string | undefined): string[] {
  return value?.trim().split(/\s+/u).filter(Boolean) ?? [];
}

function isPrintableBuildItem(attributes: string): boolean {
  const printable = attribute(attributes, "printable");
  if (printable !== undefined && printable !== "0" && printable !== "1") {
    throw new ModelGeometryError(
      "INVALID_GEOMETRY",
      "3MF obsahuje neplatný příznak tisknutelnosti objektu.",
    );
  }
  return printable !== "0";
}

function previewPropertyResources(
  xml: string,
): Map<string, PreviewPropertyResource> {
  const resources = new Map<string, PreviewPropertyResource>();
  for (const { attributes, body } of xmlElements(xml, "basematerials")) {
    const id = attribute(attributes, "id");
    if (id) {
      resources.set(id, {
        entryCount: xmlTagAttributes(body, "base").length,
        kind: "base",
      });
    }
  }
  for (const localName of ["colorgroup", "texture2dgroup"] as const) {
    const entryName = localName === "colorgroup" ? "color" : "tex2coord";
    for (const { attributes, body } of xmlElements(xml, localName)) {
      const id = attribute(attributes, "id");
      if (id) {
        resources.set(id, {
          entryCount: xmlTagAttributes(body, entryName).length,
          kind: "appearance",
        });
      }
    }
  }
  for (const { attributes, body } of xmlElements(xml, "compositematerials")) {
    const id = attribute(attributes, "id");
    const materialResourceId = attribute(attributes, "matid");
    const materialIndices = indexList(attribute(attributes, "matindices"));
    if (id && materialResourceId) {
      resources.set(id, {
        entries: xmlTagAttributes(body, "composite").map((entry) => {
          const values = indexList(attribute(entry, "values")).map(Number);
          const selected = materialIndices.filter(
            (_, index) => (values[index] ?? 0) > 0,
          );
          return selected.length > 0 ? selected : [...materialIndices];
        }),
        kind: "composite",
        materialIndices,
        materialResourceId,
      });
    }
  }
  for (const { attributes, body } of xmlElements(xml, "multiproperties")) {
    const id = attribute(attributes, "id");
    const resourceIds = indexList(attribute(attributes, "pids"));
    if (id) {
      resources.set(id, {
        entries: xmlTagAttributes(body, "multi").map((entry) =>
          indexList(attribute(entry, "pindices")),
        ),
        kind: "multi",
        resourceIds,
      });
    }
  }
  return resources;
}

function assertSingleMaterial3mf(xml: string): void {
  const resources = previewPropertyResources(xml);
  const cache = new Map<
    string,
    { assignmentIds: ReadonlySet<string>; hasAppearance: boolean }
  >();
  const invalidAssignment = (): never => {
    throw new ModelGeometryError(
      "INVALID_GEOMETRY",
      "3MF obsahuje neplatné přiřazení materiálu nebo vzhledu.",
    );
  };
  const resolve = (
    resourceId: string,
    propertyIndex: string,
    path: ReadonlySet<string>,
  ): { assignmentIds: ReadonlySet<string>; hasAppearance: boolean } => {
    const key = `${resourceId}\0${propertyIndex}`;
    const cached = cache.get(key);
    if (cached) return cached;
    if (path.has(key)) return invalidAssignment();
    const resource = resources.get(resourceId);
    const index = Number(propertyIndex);
    if (!resource || !Number.isSafeInteger(index) || index < 0) {
      return invalidAssignment();
    }
    const nextPath = new Set(path).add(key);
    const assignmentIds = new Set<string>();
    let hasAppearance = false;
    if (resource.kind === "base" || resource.kind === "appearance") {
      if (index >= resource.entryCount) return invalidAssignment();
      assignmentIds.add(`${resourceId}:${propertyIndex}`);
      hasAppearance = resource.kind === "appearance";
    } else if (resource.kind === "composite") {
      const constituents = resource.entries[index];
      if (!constituents) return invalidAssignment();
      for (const constituent of constituents) {
        const resolved = resolve(
          resource.materialResourceId,
          constituent,
          nextPath,
        );
        resolved.assignmentIds.forEach((value) => assignmentIds.add(value));
        hasAppearance ||= resolved.hasAppearance;
      }
    } else {
      const indices = resource.entries[index];
      if (!indices) return invalidAssignment();
      for (
        let position = 0;
        position < resource.resourceIds.length;
        position += 1
      ) {
        const childResourceId = resource.resourceIds[position]!;
        const childIndex = indices[position];
        if (childIndex === undefined) return invalidAssignment();
        const resolved = resolve(childResourceId, childIndex, nextPath);
        resolved.assignmentIds.forEach((value) => assignmentIds.add(value));
        hasAppearance ||= resolved.hasAppearance;
      }
    }
    const evidence = { assignmentIds, hasAppearance };
    cache.set(key, evidence);
    return evidence;
  };

  const objects = new Map<
    string,
    {
      assignmentIds: Set<string>;
      components: string[];
      hasAppearance: boolean;
      hasPaint: boolean;
    }
  >();
  for (const { attributes: objectAttributes, body } of xmlElements(
    xml,
    "object",
  )) {
    const id = attribute(objectAttributes, "id");
    if (!id) continue;
    const objectPid = attribute(objectAttributes, "pid");
    const objectPindex = attribute(objectAttributes, "pindex");
    const assignmentIds = new Set<string>();
    let hasAppearance = false;
    let hasPaint = false;
    for (const triangleAttributes of xmlTagAttributes(body, "triangle")) {
      hasPaint ||=
        exactAttribute(triangleAttributes, "paint_color") !== undefined ||
        exactAttribute(triangleAttributes, "slic3r:mmu_segmentation") !==
          undefined;
      const trianglePid = attribute(triangleAttributes, "pid");
      const resourceId = trianglePid ?? objectPid;
      const explicitIndices = ["p1", "p2", "p3"]
        .map((name) => attribute(triangleAttributes, name))
        .filter((value): value is string => value !== undefined);
      if (explicitIndices.length > 0 && !resourceId) {
        return invalidAssignment();
      }
      if (!resourceId) continue;
      const indices =
        explicitIndices.length > 0
          ? explicitIndices
          : trianglePid === undefined && objectPindex !== undefined
            ? [objectPindex]
            : invalidAssignment();
      for (const propertyIndex of indices) {
        const evidence = resolve(resourceId, propertyIndex, new Set());
        evidence.assignmentIds.forEach((value) => assignmentIds.add(value));
        hasAppearance ||= evidence.hasAppearance;
      }
    }
    objects.set(id, {
      assignmentIds,
      components: xmlTagAttributes(body, "component")
        .map((component) => attribute(component, "objectid"))
        .filter((value): value is string => Boolean(value)),
      hasAppearance,
      hasPaint,
    });
  }

  const build = xmlElements(xml, "build")[0]?.body ?? "";
  const buildItemAttributes = xmlTagAttributes(build, "item");
  const buildRoots = buildItemAttributes
    .filter(isPrintableBuildItem)
    .map((item) => attribute(item, "objectid"))
    .filter((value): value is string => Boolean(value));
  const referenced = new Set(
    [...objects.values()].flatMap((object) => object.components),
  );
  const roots =
    buildItemAttributes.length > 0
      ? buildRoots
      : [...objects.keys()].filter((id) => !referenced.has(id));
  const assignmentIds = new Set<string>();
  let hasAppearance = false;
  let hasPaint = false;
  const visited = new Set<string>();
  const visit = (objectId: string): void => {
    if (visited.has(objectId)) return;
    visited.add(objectId);
    const object = objects.get(objectId);
    if (!object) return;
    object.assignmentIds.forEach((value) => assignmentIds.add(value));
    hasAppearance ||= object.hasAppearance;
    hasPaint ||= object.hasPaint;
    object.components.forEach(visit);
  };
  roots.forEach(visit);
  if (hasAppearance || hasPaint || assignmentIds.size > 1) {
    throw new ModelGeometryError(
      "PAINTED_OR_MULTIMATERIAL_3MF",
      "Barevný nebo vícemateriálový 3MF přímá kalkulace nepodporuje. Exportujte model bez barev a materiálových vlastností.",
    );
  }
}

function parseMeshObjects(xml: string, scale: number): Map<string, MeshObject> {
  const objects = new Map<string, MeshObject>();
  let objectCount = 0;
  let vertexCount = 0;
  let componentCount = 0;
  let triangleCount = 0;
  const objectPattern =
    /<(?:[\w.-]+:)?object\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?object\s*>/giu;
  for (const objectMatch of xml.matchAll(objectPattern)) {
    objectCount += 1;
    if (objectCount > MAX_3MF_OBJECTS) {
      throw new ModelGeometryError(
        "PREVIEW_LIMIT_EXCEEDED",
        "3MF obsahuje příliš mnoho objektů pro rychlý místní náhled.",
      );
    }
    const properties = objectMatch[1] ?? "";
    const body = objectMatch[2] ?? "";
    const id = attribute(properties, "id");
    if (!id) continue;

    const vertices: Point[] = [];
    const vertexPattern = /<(?:[\w.-]+:)?vertex\b([^>]*)\/?\s*>/giu;
    for (const vertexMatch of body.matchAll(vertexPattern)) {
      vertexCount += 1;
      if (vertexCount > MAX_3MF_VERTICES) {
        throw new ModelGeometryError(
          "PREVIEW_LIMIT_EXCEEDED",
          "3MF obsahuje příliš mnoho vrcholů pro rychlý místní náhled.",
        );
      }
      const attrs = vertexMatch[1] ?? "";
      vertices.push(
        finitePoint(
          requiredNumber(attrs, "x") * scale,
          requiredNumber(attrs, "y") * scale,
          requiredNumber(attrs, "z") * scale,
        ),
      );
    }

    const triangles: [number, number, number][] = [];
    const trianglePattern = /<(?:[\w.-]+:)?triangle\b([^>]*)\/?\s*>/giu;
    for (const triangleMatch of body.matchAll(trianglePattern)) {
      triangleCount += 1;
      if (triangleCount > MAX_LOCAL_TRIANGLES) {
        throw new ModelGeometryError(
          "PREVIEW_LIMIT_EXCEEDED",
          "3MF obsahuje příliš mnoho ploch pro rychlý místní náhled.",
        );
      }
      const attrs = triangleMatch[1] ?? "";
      const indices = [
        requiredNumber(attrs, "v1"),
        requiredNumber(attrs, "v2"),
        requiredNumber(attrs, "v3"),
      ];
      if (
        indices.some(
          (index) => !Number.isSafeInteger(index) || !vertices[index],
        )
      ) {
        throw new ModelGeometryError(
          "INVALID_GEOMETRY",
          "3MF odkazuje na neexistující vrchol.",
        );
      }
      triangles.push(indices as [number, number, number]);
    }

    const components: MeshObject["components"] = [];
    const componentPattern = /<(?:[\w.-]+:)?component\b([^>]*)\/?\s*>/giu;
    for (const componentMatch of body.matchAll(componentPattern)) {
      componentCount += 1;
      if (componentCount > MAX_3MF_COMPONENTS) {
        throw new ModelGeometryError(
          "PREVIEW_LIMIT_EXCEEDED",
          "3MF obsahuje příliš mnoho částí pro rychlý místní náhled.",
        );
      }
      const attrs = componentMatch[1] ?? "";
      const objectId = attribute(attrs, "objectid");
      if (objectId) {
        components.push({
          objectId,
          transform: parseTransform(attribute(attrs, "transform"), scale),
        });
      }
    }

    objects.set(id, {
      components,
      id,
      name: attribute(properties, "name"),
      triangles,
      vertices,
    });
  }
  return objects;
}

function parse3mfXml(xml: string): Omit<ModelGeometry, "parseDurationMs"> {
  assertSingleMaterial3mf(xml);
  const scale = unitScale(xml);
  const objects = parseMeshObjects(xml, scale);
  if (objects.size === 0) {
    throw new ModelGeometryError(
      "INVALID_GEOMETRY",
      "3MF neobsahuje žádný model.",
    );
  }

  const buildItems: { objectId: string; transform: Transform }[] = [];
  const buildBody =
    /<(?:[\w.-]+:)?build\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?build\s*>/iu.exec(
      xml,
    )?.[1] ?? "";
  const itemPattern = /<(?:[\w.-]+:)?item\b([^>]*)\/?\s*>/giu;
  let buildItemCount = 0;
  for (const itemMatch of buildBody.matchAll(itemPattern)) {
    buildItemCount += 1;
    if (buildItemCount > MAX_3MF_OBJECTS) {
      throw new ModelGeometryError(
        "PREVIEW_LIMIT_EXCEEDED",
        "3MF obsahuje příliš mnoho sestavených objektů pro místní náhled.",
      );
    }
    const attrs = itemMatch[1] ?? "";
    if (!isPrintableBuildItem(attrs)) continue;
    const objectId = attribute(attrs, "objectid");
    if (objectId) {
      buildItems.push({
        objectId,
        transform: parseTransform(attribute(attrs, "transform"), scale),
      });
    }
  }

  const referenced = new Set(
    [...objects.values()].flatMap((object) =>
      object.components.map((component) => component.objectId),
    ),
  );
  const roots =
    buildItemCount > 0
      ? buildItems
      : [...objects.values()]
          .filter((object) => !referenced.has(object.id))
          .map((object) => ({
            objectId: object.id,
            transform: identityTransform,
          }));

  const geometry = new GeometryAccumulator();
  const bodyNames: string[] = [];
  const shellBudget: ShellInspectionBudget = {
    containmentTriangleChecks: 0,
    intershellGeometryChecks: 0,
    shellPairChecks: 0,
  };
  let expandedObjectCount = 0;
  const expand = (
    objectId: string,
    transforms: readonly Transform[],
    path: ReadonlySet<string>,
  ): void => {
    expandedObjectCount += 1;
    if (expandedObjectCount > MAX_3MF_EXPANDED_OBJECTS) {
      throw new ModelGeometryError(
        "PREVIEW_LIMIT_EXCEEDED",
        "Sestava 3MF je pro rychlý místní náhled příliš složitá.",
      );
    }
    if (path.size >= MAX_3MF_COMPONENT_DEPTH) {
      throw new ModelGeometryError(
        "PREVIEW_LIMIT_EXCEEDED",
        "Sestava 3MF je pro místní náhled příliš hluboce vnořená.",
      );
    }
    if (path.has(objectId)) {
      throw new ModelGeometryError(
        "INVALID_GEOMETRY",
        "3MF obsahuje cyklický odkaz mezi objekty.",
      );
    }
    const object = objects.get(objectId);
    if (!object) {
      throw new ModelGeometryError(
        "INVALID_GEOMETRY",
        "3MF odkazuje na neexistující objekt.",
      );
    }
    const nextPath = new Set(path).add(objectId);
    if (object.triangles.length > 0) {
      bodyNames.push(object.name?.trim() || `Těleso ${bodyNames.length + 1}`);
    }
    const triangles = object.triangles.map(([a, b, c]): TrianglePoints => [
      applyTransforms(object.vertices[a]!, transforms),
      applyTransforms(object.vertices[b]!, transforms),
      applyTransforms(object.vertices[c]!, transforms),
    ]);
    geometry.addBody(
      triangles,
      nestedShellVolume(connectedTriangleBodies(triangles), shellBudget),
    );
    for (const component of object.components) {
      expand(
        component.objectId,
        [component.transform, ...transforms],
        nextPath,
      );
    }
  };

  for (const root of roots) {
    expand(root.objectId, [root.transform], new Set());
  }

  return {
    ...geometry.finish(),
    bodyNames,
    objectCount: roots.length,
  };
}

function invalid3mfPackage(message: string): never {
  throw new ModelGeometryError("INVALID_GEOMETRY", message);
}

function safeArchivePart(name: string): string {
  if (
    !name ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.split("/").some((part) => part === "" || part === "..")
  ) {
    return invalid3mfPackage("Archiv 3MF obsahuje nebezpečnou cestu.");
  }
  return name;
}

function relationshipSource(name: string): string | undefined {
  if (name === "_rels/.rels") return "";
  const match = /^(.*)\/_rels\/([^/]+)\.rels$/u.exec(name);
  return match ? `${match[1]!}/${match[2]!}` : undefined;
}

function relationshipTarget(sourcePart: string, target: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return invalid3mfPackage("3MF obsahuje nebezpečný odkaz na soubor.");
  }
  if (
    !decoded ||
    decoded.includes("\\") ||
    /[?#]/u.test(decoded) ||
    /^[a-z][a-z0-9+.-]*:/iu.test(decoded)
  ) {
    return invalid3mfPackage("3MF obsahuje nebezpečný odkaz na soubor.");
  }
  const relative = decoded.startsWith("/") ? decoded.slice(1) : decoded;
  if (
    relative
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    return invalid3mfPackage("3MF obsahuje nebezpečný odkaz na soubor.");
  }
  const base = decoded.startsWith("/")
    ? ""
    : sourcePart.includes("/")
      ? sourcePart.slice(0, sourcePart.lastIndexOf("/"))
      : "";
  return safeArchivePart(base ? `${base}/${relative}` : relative);
}

function relationshipAttribute(
  tag: SaxesTagNS,
  local: string,
): string | undefined {
  return Object.values(tag.attributes).find(
    (candidate: SaxesAttributeNS) =>
      candidate.local === local && candidate.uri === "",
  )?.value;
}

function xmlAttributeValue(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
}

function structuralElementName(tag: SaxesTagNS): string {
  return tag.uri === CORE_3MF_NAMESPACE || tag.uri === MATERIAL_3MF_NAMESPACE
    ? tag.local
    : "ignored";
}

async function structuralModelXml(xml: string): Promise<string> {
  const { SaxesParser } = await import("saxes");
  const structural: string[] = [];
  const parser = new SaxesParser({ xmlns: true, position: false });
  parser.on("doctype", () =>
    invalid3mfPackage("3MF obsahuje nepodporovanou XML deklaraci."),
  );
  parser.on("error", () => invalid3mfPackage("Model 3MF není platné XML."));
  parser.on("opentag", (tag) => {
    const tagAttributes = Object.values(tag.attributes);
    if (
      tag.uri === CORE_3MF_NAMESPACE &&
      (tag.local === "component" || tag.local === "item") &&
      tagAttributes.some(
        (candidate: SaxesAttributeNS) =>
          candidate.uri === PRODUCTION_3MF_NAMESPACE &&
          candidate.local === "path",
      )
    ) {
      return invalid3mfPackage(
        "Náhled 3MF s odkazy mezi částmi dokončíme po nahrání.",
      );
    }
    const attributes = tagAttributes
      .filter(
        (candidate: SaxesAttributeNS) =>
          candidate.uri === "" || candidate.uri === SLIC3R_3MF_NAMESPACE,
      )
      .map((candidate: SaxesAttributeNS) => {
        const name =
          candidate.uri === SLIC3R_3MF_NAMESPACE
            ? `slic3r:${candidate.local}`
            : candidate.local;
        return ` ${name}="${xmlAttributeValue(candidate.value)}"`;
      })
      .join("");
    structural.push(`<${structuralElementName(tag)}${attributes}>`);
  });
  parser.on("closetag", (tag) => {
    structural.push(`</${structuralElementName(tag)}>`);
  });
  try {
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof ModelGeometryError) throw error;
    return invalid3mfPackage("Model 3MF není platné XML.");
  }
  return structural.join("");
}

async function packageModelRoots(
  files: Readonly<Record<string, Uint8Array>>,
  archiveParts: ReadonlySet<string>,
): Promise<string[]> {
  const { SaxesParser } = await import("saxes");
  const roots = new Set<string>();
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.endsWith(".rels")) continue;
    const sourcePart = relationshipSource(name);
    if (sourcePart === undefined) {
      return invalid3mfPackage("3MF obsahuje chybně umístěné vztahy.");
    }
    let xml: string;
    try {
      xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return invalid3mfPackage("Vztahy 3MF nejsou platný textový soubor.");
    }
    const parser = new SaxesParser({ xmlns: true, position: false });
    const stack: Array<{ local: string; uri: string }> = [];
    let sawRoot = false;
    parser.on("doctype", () =>
      invalid3mfPackage("3MF obsahuje nepodporovanou XML deklaraci."),
    );
    parser.on("error", () =>
      invalid3mfPackage("Vztahy 3MF nejsou platné XML."),
    );
    parser.on("opentag", (tag) => {
      const parent = stack.at(-1);
      if (stack.length === 0) {
        if (
          tag.uri !== PACKAGE_RELATIONSHIPS_NAMESPACE ||
          tag.local !== "Relationships"
        ) {
          return invalid3mfPackage("Kořen vztahů 3MF není platný.");
        }
        sawRoot = true;
      } else if (
        parent?.uri === PACKAGE_RELATIONSHIPS_NAMESPACE &&
        parent.local === "Relationships" &&
        tag.uri === PACKAGE_RELATIONSHIPS_NAMESPACE &&
        tag.local === "Relationship"
      ) {
        if (
          relationshipAttribute(tag, "TargetMode")?.toLowerCase() === "external"
        ) {
          return invalid3mfPackage("3MF obsahuje externí odkaz.");
        }
        const target = relationshipAttribute(tag, "Target");
        if (!target) {
          return invalid3mfPackage("Vztah 3MF nemá cílový soubor.");
        }
        const packageTarget = relationshipTarget(sourcePart, target);
        if (!archiveParts.has(packageTarget)) {
          return invalid3mfPackage("Vztah 3MF odkazuje na chybějící soubor.");
        }
        if (
          sourcePart === "" &&
          relationshipAttribute(tag, "Type")?.toLowerCase().endsWith("/3dmodel")
        ) {
          roots.add(packageTarget);
        }
      }
      stack.push({ local: tag.local, uri: tag.uri });
    });
    parser.on("closetag", () => {
      stack.pop();
    });
    try {
      parser.write(xml).close();
    } catch (error) {
      if (error instanceof ModelGeometryError) throw error;
      return invalid3mfPackage("Vztahy 3MF nejsou platné XML.");
    }
    if (!sawRoot) {
      return invalid3mfPackage("Vztahům 3MF chybí kořenový element.");
    }
  }
  return [...roots];
}

async function parse3mf(bytes: Uint8Array): Promise<ModelGeometry> {
  const { unzipSync } = await import("fflate");
  let totalXmlBytes = 0;
  let archiveEntries = 0;
  const archiveParts = new Set<string>();
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter(file) {
        archiveEntries += 1;
        if (archiveEntries > MAX_3MF_ARCHIVE_ENTRIES) {
          throw new ModelGeometryError(
            "PREVIEW_LIMIT_EXCEEDED",
            "Archiv 3MF obsahuje příliš mnoho souborů pro bezpečný náhled.",
          );
        }
        if (file.name.endsWith("/")) {
          safeArchivePart(file.name.slice(0, -1));
          return false;
        }
        const name = safeArchivePart(file.name);
        archiveParts.add(name);
        const isModelXml = name.toLowerCase().endsWith(".model");
        const isRelationshipXml = name.endsWith(".rels");
        if (!isModelXml && !isRelationshipXml) return false;
        totalXmlBytes += file.originalSize;
        if (
          file.originalSize > MAX_3MF_MODEL_XML_BYTES ||
          totalXmlBytes > MAX_3MF_TOTAL_XML_BYTES
        ) {
          throw new ModelGeometryError(
            "PREVIEW_LIMIT_EXCEEDED",
            "Model je příliš složitý pro bezpečný náhled v prohlížeči.",
          );
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ModelGeometryError) throw error;
    throw new ModelGeometryError(
      "INVALID_GEOMETRY",
      "Archiv 3MF se nepodařilo otevřít.",
    );
  }

  const packageRoots = await packageModelRoots(files, archiveParts);
  const rootPart =
    packageRoots.length === 1
      ? packageRoots[0]!
      : packageRoots.length === 0 && files["3D/3dmodel.model"]
        ? "3D/3dmodel.model"
        : invalid3mfPackage("Archiv 3MF musí určit právě jeden hlavní model.");
  const rootBytes = files[rootPart];
  if (!rootBytes || !rootPart.toLowerCase().endsWith(".model")) {
    return invalid3mfPackage("Archiv 3MF neobsahuje hlavní model.");
  }

  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(rootBytes);
  } catch {
    throw new ModelGeometryError(
      "INVALID_GEOMETRY",
      "Model v archivu 3MF není platný textový soubor.",
    );
  }
  const structuralXml = await structuralModelXml(xml);
  return { ...parse3mfXml(structuralXml), parseDurationMs: 0 };
}

export async function parseModelGeometry(
  format: DirectModelFormat,
  buffer: ArrayBuffer,
): Promise<ModelGeometry> {
  const startedAt = performance.now();
  const bytes = new Uint8Array(buffer);
  const geometry = format === "STL" ? parseStl(bytes) : await parse3mf(bytes);
  return {
    ...geometry,
    parseDurationMs: Math.round((performance.now() - startedAt) * 10) / 10,
  };
}
