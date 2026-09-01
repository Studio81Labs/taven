import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { parseModelGeometry } from "./model-geometry";

type Point = readonly [number, number, number];
type Triangle = readonly [Point, Point, Point];

const materialNamespace =
  "http://schemas.microsoft.com/3dmanufacturing/material/2015/02";
const packageRelationshipsNamespace =
  "http://schemas.openxmlformats.org/package/2006/relationships";

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

function scaledTetrahedron(
  scale: number,
  offset: Point,
  reversed = false,
): Triangle[] {
  return tetrahedron.map((triangle) => {
    const transformed = triangle.map((point): Point => [
      point[0] * scale + offset[0],
      point[1] * scale + offset[1],
      point[2] * scale + offset[2],
    ]);
    return reversed
      ? [transformed[2]!, transformed[1]!, transformed[0]!]
      : [transformed[0]!, transformed[1]!, transformed[2]!];
  });
}

function threeMf(model: string): ArrayBuffer {
  return threeMfArchive({
    "3D/3dmodel.model": new TextEncoder().encode(model),
    "[Content_Types].xml": new TextEncoder().encode("<Types />"),
  });
}

function threeMfArchive(entries: Record<string, Uint8Array>): ArrayBuffer {
  const archive = zipSync(entries);
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

  it.each([false, true])(
    "subtracts a nested cavity shell regardless of winding (reversed=%s)",
    async (reversed) => {
      const geometry = await parseModelGeometry(
        "STL",
        binaryStl([
          ...scaledTetrahedron(4, [0, 0, 0]),
          ...scaledTetrahedron(1, [0.5, 0.5, 0.5], reversed),
        ]),
      );

      expect(geometry.dimensions).toEqual({ width: 4, depth: 4, height: 4 });
      expect(geometry.volumeMm3).toBeCloseTo(63 / 6, 6);
    },
  );

  it("does not merge a solid merely because its bounds are nested", async () => {
    const geometry = await parseModelGeometry(
      "STL",
      binaryStl([
        ...scaledTetrahedron(4, [0, 0, 0]),
        ...scaledTetrahedron(0.5, [3, 3, 3], true),
      ]),
    );

    expect(geometry.dimensions).toEqual({ width: 4, depth: 4, height: 4 });
    expect(geometry.volumeMm3).toBeCloseTo(64.125 / 6, 6);
  });

  it("rejects intersecting disconnected shells", async () => {
    await expect(
      parseModelGeometry(
        "STL",
        binaryStl([
          ...scaledTetrahedron(4, [0, 0, 0]),
          ...scaledTetrahedron(3, [0.5, 0.5, 0.5], true),
        ]),
      ),
    ).rejects.toMatchObject({ code: "INVALID_GEOMETRY" });
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

  it("uses the package relationship to select a noncanonical root model", async () => {
    const paintedAuxiliary = tetrahedron3mf.replace(
      '<triangle v1="0" v2="2" v3="1"/>',
      '<triangle v1="0" v2="2" v3="1" paint_color="#ff0000"/>',
    );
    const geometry = await parseModelGeometry(
      "3MF",
      threeMfArchive({
        "3D/auxiliary.model": new TextEncoder().encode(paintedAuxiliary),
        "Models/printable.model": new TextEncoder().encode(tetrahedron3mf),
        "_rels/.rels": new TextEncoder().encode(
          `<Relationships xmlns="${packageRelationshipsNamespace}"><Relationship Target="/Models/printable.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`,
        ),
      }),
    );

    expect(geometry.dimensions).toEqual({ width: 10, depth: 10, height: 10 });
    expect(geometry.volumeMm3).toBeCloseTo(1_000 / 6, 5);
  });

  it("does not guess an arbitrary model part when no root is declared", async () => {
    await expect(
      parseModelGeometry(
        "3MF",
        threeMfArchive({
          "Models/printable.model": new TextEncoder().encode(tetrahedron3mf),
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_GEOMETRY" });
  });

  it("rejects ambiguous package root relationships", async () => {
    const encode = (value: string) => new TextEncoder().encode(value);
    await expect(
      parseModelGeometry(
        "3MF",
        threeMfArchive({
          "Models/first.model": encode(tetrahedron3mf),
          "Models/second.model": encode(tetrahedron3mf),
          "_rels/.rels": encode(
            `<Relationships xmlns="${packageRelationshipsNamespace}"><Relationship Target="/Models/first.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/><Relationship Target="/Models/second.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`,
          ),
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_GEOMETRY" });
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

  it("sums disconnected shell volumes within one mesh", async () => {
    const multipleShells = tetrahedron3mf
      .replace(
        "</vertices>",
        '<vertex x="2" y="0" z="0"/><vertex x="3" y="0" z="0"/><vertex x="2" y="1" z="0"/><vertex x="2" y="0" z="1"/></vertices>',
      )
      .replace(
        "</triangles>",
        '<triangle v1="4" v2="5" v3="6"/><triangle v1="4" v2="7" v3="5"/><triangle v1="4" v2="6" v3="7"/><triangle v1="5" v2="7" v3="6"/></triangles>',
      );
    const geometry = await parseModelGeometry("3MF", threeMf(multipleShells));

    expect(geometry.objectCount).toBe(1);
    expect(geometry.dimensions).toEqual({ width: 30, depth: 10, height: 10 });
    expect(geometry.volumeMm3).toBeCloseTo(2_000 / 6, 5);
  });

  it("rejects singular build transforms", async () => {
    const singular = tetrahedron3mf.replace(
      'transform="1 0 0 0 1 0 0 0 1 5 6 7"',
      'transform="0 0 0 0 1 0 0 0 1 5 6 7"',
    );

    await expect(
      parseModelGeometry("3MF", threeMf(singular)),
    ).rejects.toMatchObject({ code: "INVALID_GEOMETRY" });
  });

  it("allows unused appearance resources", async () => {
    const unusedAppearance = tetrahedron3mf
      .replace(
        '<model unit="centimeter"',
        `<model unit="centimeter" xmlns:m="${materialNamespace}"`,
      )
      .replace(
        "<resources>",
        '<resources><m:colorgroup id="8"><m:color color="#ff0000"/></m:colorgroup>',
      );

    await expect(
      parseModelGeometry("3MF", threeMf(unusedAppearance)),
    ).resolves.toMatchObject({ objectCount: 1 });
  });

  it("ignores painted triangle markup in comments and CDATA", async () => {
    const commentedPaint = tetrahedron3mf.replace(
      "</triangles>",
      '<!-- <triangle paint_color="#ff0000"/> --><![CDATA[<triangle paint_color="#00ff00"/>]]></triangles>',
    );

    await expect(
      parseModelGeometry("3MF", threeMf(commentedPaint)),
    ).resolves.toMatchObject({ objectCount: 1 });
  });

  it("ignores paint-like attributes from unrelated namespaces", async () => {
    const vendorMetadata = tetrahedron3mf
      .replace(
        '<model unit="centimeter"',
        '<model unit="centimeter" xmlns:vendor="urn:vendor"',
      )
      .replace(
        '<triangle v1="0" v2="2" v3="1"/>',
        '<triangle v1="0" v2="2" v3="1" vendor:paint_color="#ff0000" vendor:mmu_segmentation="4"/>',
      );

    await expect(
      parseModelGeometry("3MF", threeMf(vendorMetadata)),
    ).resolves.toMatchObject({ objectCount: 1 });
  });

  it("excludes non-printable build items from preview eligibility and geometry", async () => {
    const object = /<object id="1"[\s\S]*?<\/object>/u.exec(
      tetrahedron3mf,
    )?.[0];
    expect(object).toBeDefined();
    const disabledObject = object!
      .replace('id="1"', 'id="2" pid="8" pindex="0"')
      .replace(
        '<triangle v1="0" v2="2" v3="1"/>',
        '<triangle v1="0" v2="2" v3="1" slic3r:mmu_segmentation="4"/>',
      );
    const model = tetrahedron3mf
      .replace(
        '<model unit="centimeter"',
        `<model unit="centimeter" xmlns:m="${materialNamespace}" xmlns:slic3r="http://schemas.slic3r.org/3mf/2017/06"`,
      )
      .replace(
        "</resources>",
        `<m:colorgroup id="8"><m:color color="#ff0000"/></m:colorgroup>${disabledObject}</resources>`,
      )
      .replace(
        "</build>",
        '<item objectid="2" printable="0" transform="1 0 0 0 1 0 0 0 1 20 0 0"/></build>',
      );

    await expect(parseModelGeometry("3MF", threeMf(model))).resolves.toEqual(
      expect.objectContaining({
        bodyNames: ["Díl"],
        dimensions: { width: 10, depth: 10, height: 10 },
        objectCount: 1,
        volumeMm3: expect.closeTo(1_000 / 6, 5),
      }),
    );
  });

  it("blocks explicit paint markers on printable geometry", async () => {
    const painted = tetrahedron3mf.replace(
      '<triangle v1="0" v2="2" v3="1"/>',
      '<triangle v1="0" v2="2" v3="1" paint_color="4"/>',
    );

    await expect(
      parseModelGeometry("3MF", threeMf(painted)),
    ).rejects.toMatchObject({ code: "PAINTED_OR_MULTIMATERIAL_3MF" });
  });

  it("allows one uniformly assigned base material", async () => {
    const singleMaterial = tetrahedron3mf
      .replace(
        "<resources>",
        '<resources><basematerials id="8"><base name="PLA" displaycolor="#ffffffff"/></basematerials>',
      )
      .replace('<object id="1"', '<object id="1" pid="8" pindex="0"');

    await expect(
      parseModelGeometry("3MF", threeMf(singleMaterial)),
    ).resolves.toMatchObject({ objectCount: 1 });
  });

  it("rejects incomplete triangle property assignments", async () => {
    const incomplete = tetrahedron3mf
      .replace(
        "<resources>",
        '<resources><basematerials id="8"><base name="PLA" displaycolor="#ffffffff"/></basematerials>',
      )
      .replace('<object id="1"', '<object id="1" pid="8" pindex="0"')
      .replace(
        '<triangle v1="0" v2="2" v3="1"/>',
        '<triangle v1="0" v2="2" v3="1" pid="8"/>',
      );

    await expect(
      parseModelGeometry("3MF", threeMf(incomplete)),
    ).rejects.toMatchObject({ code: "INVALID_GEOMETRY" });
  });

  it("blocks assigned appearance properties instead of flattening them", async () => {
    const painted = tetrahedron3mf
      .replace(
        '<model unit="centimeter"',
        `<model unit="centimeter" xmlns:m="${materialNamespace}"`,
      )
      .replace(
        "<resources>",
        '<resources><m:colorgroup id="8"><m:color color="#ff0000"/></m:colorgroup>',
      )
      .replace('<object id="1"', '<object id="1" pid="8" pindex="0"');
    await expect(parseModelGeometry("3MF", threeMf(painted))).rejects.toEqual(
      expect.objectContaining({
        code: "PAINTED_OR_MULTIMATERIAL_3MF",
      }),
    );
  });

  it("blocks multiple assigned base materials", async () => {
    const multimaterial = tetrahedron3mf
      .replace(
        "<resources>",
        '<resources><basematerials id="8"><base name="PLA" displaycolor="#ffffffff"/><base name="PETG" displaycolor="#000000ff"/></basematerials>',
      )
      .replace('<object id="1"', '<object id="1" pid="8" pindex="0"')
      .replace(
        '<triangle v1="0" v2="2" v3="1"/>',
        '<triangle v1="0" v2="2" v3="1" pid="8" p1="1"/>',
      );

    await expect(
      parseModelGeometry("3MF", threeMf(multimaterial)),
    ).rejects.toMatchObject({ code: "PAINTED_OR_MULTIMATERIAL_3MF" });
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
