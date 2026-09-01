import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { parseModelGeometry } from "./model-geometry";

type Point = readonly [number, number, number];
type Triangle = readonly [Point, Point, Point];

const tetrahedron: Triangle[] = [
  [
    [0, 0, 0],
    [0, 1, 0],
    [1, 0, 0],
  ],
  [
    [0, 0, 0],
    [1, 0, 0],
    [0, 0, 1],
  ],
  [
    [0, 0, 0],
    [0, 0, 1],
    [0, 1, 0],
  ],
  [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
];

function binaryStl(triangles: readonly Triangle[]): ArrayBuffer {
  const bytes = new Uint8Array(84 + triangles.length * 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, triangles.length, true);
  triangles.forEach((triangle, triangleIndex) => {
    let offset = 84 + triangleIndex * 50 + 12;
    for (const vertex of triangle) {
      for (const coordinate of vertex) {
        view.setFloat32(offset, coordinate, true);
        offset += 4;
      }
    }
  });
  return bytes.buffer;
}

function binaryStlWithTriangleCount(triangleCount: number): ArrayBuffer {
  const buffer = new ArrayBuffer(84 + triangleCount * 50);
  new DataView(buffer).setUint32(80, triangleCount, true);
  return buffer;
}

function translatedReversedTetrahedron(offsetX: number): Triangle[] {
  return tetrahedron.map(([a, b, c]) => [
    [c[0] + offsetX, c[1], c[2]],
    [b[0] + offsetX, b[1], b[2]],
    [a[0] + offsetX, a[1], a[2]],
  ]);
}

function threeMf(model: string): ArrayBuffer {
  const archive = zipSync({
    "3D/3dmodel.model": new TextEncoder().encode(model),
    "[Content_Types].xml": new TextEncoder().encode("<Types />"),
  });
  return archive.buffer.slice(
    archive.byteOffset,
    archive.byteOffset + archive.byteLength,
  ) as ArrayBuffer;
}

const tetrahedron3mf = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="centimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" name="Díl" type="model"><mesh><vertices>
      <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/>
      <vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/>
    </vertices><triangles>
      <triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/>
      <triangle v1="0" v2="3" v3="2"/><triangle v1="1" v2="2" v3="3"/>
    </triangles></mesh></object>
  </resources>
  <build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 5 6 7"/></build>
</model>`;

describe("STL geometry", () => {
  it("reads binary dimensions, volume, and preview triangles", async () => {
    const geometry = await parseModelGeometry("STL", binaryStl(tetrahedron));
    expect(geometry.dimensions).toEqual({ width: 1, depth: 1, height: 1 });
    expect(geometry.triangleCount).toBe(4);
    expect(geometry.previewTriangles).toHaveLength(36);
    expect(geometry.volumeMm3).toBeCloseTo(1 / 6, 6);
  });

  it("reads ASCII STL and rejects incomplete facets", async () => {
    const valid = new TextEncoder().encode(`solid part
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 1 0
endloop
endfacet
endsolid part`).buffer;
    await expect(parseModelGeometry("STL", valid)).resolves.toMatchObject({
      triangleCount: 1,
    });
    const invalid = new TextEncoder().encode("solid part\nvertex 0 0 0").buffer;
    await expect(parseModelGeometry("STL", invalid)).rejects.toMatchObject({
      code: "INVALID_GEOMETRY",
    });
  });

  it("stops local work when the triangle budget is exhausted", async () => {
    await expect(
      parseModelGeometry("STL", binaryStlWithTriangleCount(100_001)),
    ).rejects.toMatchObject({ code: "PREVIEW_LIMIT_EXCEEDED" });
  });

  it("sums disconnected body volumes regardless of winding", async () => {
    const geometry = await parseModelGeometry(
      "STL",
      binaryStl([...tetrahedron, ...translatedReversedTetrahedron(2)]),
    );

    expect(geometry.dimensions).toEqual({ width: 3, depth: 1, height: 1 });
    expect(geometry.triangleCount).toBe(8);
    expect(geometry.volumeMm3).toBeCloseTo(2 / 6, 6);
  });
});

describe("3MF geometry", () => {
  it("applies units and build transforms while preserving dimensions", async () => {
    const geometry = await parseModelGeometry("3MF", threeMf(tetrahedron3mf));
    expect(geometry.bodyNames).toEqual(["Díl"]);
    expect(geometry.objectCount).toBe(1);
    expect(geometry.dimensions).toEqual({ width: 10, depth: 10, height: 10 });
    expect(geometry.volumeMm3).toBeCloseTo(1_000 / 6, 5);
  });

  it("scales build translations using the model unit", async () => {
    const twoInstances = tetrahedron3mf.replace(
      '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 5 6 7"/>',
      '<item objectid="1"/><item objectid="1" transform="1 0 0 0 1 0 0 0 1 2 0 0"/>',
    );
    const geometry = await parseModelGeometry("3MF", threeMf(twoInstances));

    expect(geometry.objectCount).toBe(2);
    expect(geometry.dimensions).toEqual({ width: 30, depth: 10, height: 10 });
  });

  it("sums mirrored instance volumes instead of cancelling them", async () => {
    const mirroredInstance = tetrahedron3mf.replace(
      '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 5 6 7"/>',
      '<item objectid="1"/><item objectid="1" transform="-1 0 0 0 1 0 0 0 1 2 0 0"/>',
    );
    const geometry = await parseModelGeometry("3MF", threeMf(mirroredInstance));

    expect(geometry.objectCount).toBe(2);
    expect(geometry.volumeMm3).toBeCloseTo(2_000 / 6, 5);
  });

  it("blocks painted or multimaterial 3MF instead of flattening it", async () => {
    const painted = tetrahedron3mf.replace(
      "<resources>",
      '<resources><colorgroup id="8"><color color="#ff0000"/></colorgroup>',
    );
    await expect(parseModelGeometry("3MF", threeMf(painted))).rejects.toEqual(
      expect.objectContaining({
        code: "PAINTED_OR_MULTIMATERIAL_3MF",
      }),
    );
  });

  it("reports malformed archives as recoverable preview errors", async () => {
    await expect(
      parseModelGeometry("3MF", new Uint8Array([1, 2, 3]).buffer),
    ).rejects.toMatchObject({ code: "INVALID_GEOMETRY" });
  });

  it("rejects archives with excessive entry counts before extraction", async () => {
    const entries = Object.fromEntries(
      Array.from({ length: 1_025 }, (_, index) => [
        `Metadata/${index}.txt`,
        new Uint8Array(),
      ]),
    );
    const archive = zipSync(entries);
    const buffer = archive.buffer.slice(
      archive.byteOffset,
      archive.byteOffset + archive.byteLength,
    ) as ArrayBuffer;
    await expect(parseModelGeometry("3MF", buffer)).rejects.toMatchObject({
      code: "PREVIEW_LIMIT_EXCEEDED",
    });
  });
});
