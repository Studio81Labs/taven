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

type Point = readonly [number, number, number];
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
  signedVolume = 0;

  addTriangle(a: Point, b: Point, c: Point): void {
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
    this.signedVolume +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) -
        a[1] * (b[0] * c[2] - b[2] * c[0]) +
        a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
    this.triangleCount += 1;
    if (this.triangleCount <= MAX_PREVIEW_TRIANGLES) {
      this.previewTriangles.push(...a, ...b, ...c);
    }
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
      volumeMm3: Math.abs(this.signedVolume),
    };
  }
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

  const geometry = new GeometryAccumulator();
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
    geometry.addTriangle(points[0]!, points[1]!, points[2]!);
  }

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
  const vertexPattern =
    /\bvertex\s+([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:e[-+]?\d+)?)/giu;
  for (const match of source.matchAll(vertexPattern)) {
    vertices.push(
      finitePoint(Number(match[1]), Number(match[2]), Number(match[3])),
    );
    if (vertices.length === 3) {
      geometry.addTriangle(vertices[0]!, vertices[1]!, vertices[2]!);
      vertices.length = 0;
    }
  }
  if (vertices.length !== 0) {
    throw new ModelGeometryError(
      "INVALID_GEOMETRY",
      "Textový STL soubor obsahuje neúplnou plochu.",
    );
  }

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

function parseTransform(value: string | undefined): Transform {
  if (!value) return identityTransform;
  const parts = value.trim().split(/\s+/u).map(Number);
  if (parts.length !== 12 || parts.some((part) => !Number.isFinite(part))) {
    throw new ModelGeometryError(
      "INVALID_GEOMETRY",
      "3MF obsahuje neplatnou transformaci objektu.",
    );
  }
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

function assertSingleMaterial3mf(xml: string): void {
  const resourcePattern =
    /<(?:[\w.-]+:)?(?:basematerials|colorgroup|compositematerials|multiproperties|texture2d|texture2dgroup)\b/iu;
  const propertyPattern = /\s(?:pid|pindex|p1|p2|p3)\s*=/iu;
  if (resourcePattern.test(xml) || propertyPattern.test(xml)) {
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
          transform: parseTransform(attribute(attrs, "transform")),
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
  const objects = parseMeshObjects(xml, unitScale(xml));
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
  for (const itemMatch of buildBody.matchAll(itemPattern)) {
    if (buildItems.length >= MAX_3MF_OBJECTS) {
      throw new ModelGeometryError(
        "PREVIEW_LIMIT_EXCEEDED",
        "3MF obsahuje příliš mnoho sestavených objektů pro místní náhled.",
      );
    }
    const attrs = itemMatch[1] ?? "";
    const objectId = attribute(attrs, "objectid");
    if (objectId) {
      buildItems.push({
        objectId,
        transform: parseTransform(attribute(attrs, "transform")),
      });
    }
  }

  const referenced = new Set(
    [...objects.values()].flatMap((object) =>
      object.components.map((component) => component.objectId),
    ),
  );
  const roots =
    buildItems.length > 0
      ? buildItems
      : [...objects.values()]
          .filter((object) => !referenced.has(object.id))
          .map((object) => ({
            objectId: object.id,
            transform: identityTransform,
          }));

  const geometry = new GeometryAccumulator();
  const bodyNames: string[] = [];
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
    for (const [a, b, c] of object.triangles) {
      geometry.addTriangle(
        applyTransforms(object.vertices[a]!, transforms),
        applyTransforms(object.vertices[b]!, transforms),
        applyTransforms(object.vertices[c]!, transforms),
      );
    }
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

async function parse3mf(bytes: Uint8Array): Promise<ModelGeometry> {
  const { unzipSync } = await import("fflate");
  let totalXmlBytes = 0;
  let archiveEntries = 0;
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
        const isModel = file.name.toLowerCase().endsWith(".model");
        if (!isModel) return false;
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

  const entry =
    Object.entries(files).find(
      ([name]) => name.replace(/^\//u, "").toLowerCase() === "3d/3dmodel.model",
    ) ?? Object.entries(files)[0];
  if (!entry) {
    throw new ModelGeometryError(
      "INVALID_GEOMETRY",
      "Archiv 3MF neobsahuje hlavní model.",
    );
  }

  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(entry[1]);
  } catch {
    throw new ModelGeometryError(
      "INVALID_GEOMETRY",
      "Model v archivu 3MF není platný textový soubor.",
    );
  }
  return { ...parse3mfXml(xml), parseDurationMs: 0 };
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
