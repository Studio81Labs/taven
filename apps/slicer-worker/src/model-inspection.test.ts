import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalizeModel, inspectModel } from "./model-inspection.js";

const coreNamespace =
  "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
const productionNamespace =
  "http://schemas.microsoft.com/3dmanufacturing/production/2015/06";
const materialNamespace =
  "http://schemas.microsoft.com/3dmanufacturing/material/2015/02";
const relationshipsNamespace =
  "http://schemas.openxmlformats.org/package/2006/relationships";

function storedZip(entries: Readonly<Record<string, string>>): Uint8Array {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const contents = Buffer.from(value);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(contents.byteLength, 18);
    localHeader.writeUInt32LE(contents.byteLength, 22);
    localHeader.writeUInt16LE(nameBytes.byteLength, 26);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(contents.byteLength, 20);
    centralHeader.writeUInt32LE(contents.byteLength, 24);
    centralHeader.writeUInt16LE(nameBytes.byteLength, 28);
    centralHeader.writeUInt32LE(offset, 42);
    local.push(localHeader, nameBytes, contents);
    central.push(centralHeader, nameBytes);
    offset +=
      localHeader.byteLength + nameBytes.byteLength + contents.byteLength;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBytes.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

const cubeMesh = `
  <vertices>
    <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/>
    <vertex x="0" y="1" z="0"/><vertex x="0" y="0" z="1"/>
  </vertices>
  <triangles>
    <triangle v1="0" v2="2" v3="1"/><triangle v1="0" v2="1" v3="3"/>
    <triangle v1="1" v2="2" v3="3"/><triangle v1="2" v2="0" v3="3"/>
  </triangles>`;

describe("safe model inspection", () => {
  it("parses vertices only from complete ASCII STL facet blocks", () => {
    const source = new TextEncoder().encode(`
      solid vertex 99 99 99
        facet normal 0 0 1
          outer loop
            vertex 0 0 0
            vertex 0 1 0
            vertex 1 0 0
          endloop
        endfacet
        facet normal 0 1 0
          outer loop
            vertex 0 0 0
            vertex 1 0 0
            vertex 0 0 1
          endloop
        endfacet
        facet normal 1 1 1
          outer loop
            vertex 1 0 0
            vertex 0 1 0
            vertex 0 0 1
          endloop
        endfacet
        facet normal 1 0 0
          outer loop
            vertex 0 1 0
            vertex 0 0 0
            vertex 0 0 1
          endloop
        endfacet
      endsolid vertex 88 88 88
    `);

    const inspection = inspectModel("stl", source);
    expect(inspection.bodies[0]?.triangleCount).toBe(4);
    expect(inspection.boundingBox.xMicrometers).toBe("1000");
  });

  it("rejects structurally valid geometry with zero volume or bounds", () => {
    const planar = new TextEncoder().encode(`
      solid planar
        facet normal 0 0 1
          outer loop
            vertex 0 0 0
            vertex 1 0 0
            vertex 0 1 0
          endloop
        endfacet
      endsolid planar
    `);

    expect(() => inspectModel("stl", planar)).toThrow(
      "positive volume and three-dimensional bounds",
    );
  });

  it("rejects body volumes that cannot fit the persistence contract", () => {
    const oversizedCube = cubeMesh
      .replaceAll('x="1"', 'x="4000"')
      .replaceAll('y="1"', 'y="4000"')
      .replaceAll('z="1"', 'z="4000"');
    const source = storedZip({
      "3D/3dmodel.model": `<model xmlns="${coreNamespace}" unit="millimeter">
        <resources><object id="1"><mesh>${oversizedCube}</mesh></object></resources>
        <build><item objectid="1"/></build>
      </model>`,
    });

    try {
      inspectModel("3mf", source);
      expect.fail("oversized model inspection should fail");
    } catch (error) {
      expect(error).toMatchObject({
        failureClass: "deterministic_invalid",
        code: "RESOURCE_LIMIT_EXCEEDED",
      });
    }
  });

  it.each([
    ["inch", "25400", 25_400_000],
    ["meter", "1000000", 1_000_000_000],
  ] as const)(
    "reports and canonicalizes declared 3MF %s units in micrometers",
    (unit, expectedExtent, scaleFactorPpm) => {
      const source = storedZip({
        "3D/3dmodel.model": `<model xmlns="${coreNamespace}" unit="${unit}">
          <resources><object id="1"><mesh>${cubeMesh}</mesh></object></resources>
          <build><item objectid="1"/></build>
        </model>`,
      });

      const inspection = inspectModel("3mf", source);
      expect(inspection.boundingBox).toEqual({
        xMicrometers: expectedExtent,
        yMicrometers: expectedExtent,
        zMicrometers: expectedExtent,
      });
      const canonical = canonicalizeModel(
        "3mf",
        source,
        ["body-0001"],
        scaleFactorPpm,
      );
      expect(canonical.inspection.boundingBox).toEqual(inspection.boundingBox);
      expect(canonical.inspection.bodies[0]?.volumeCubicMicrometers).toBe(
        inspection.bodies[0]?.volumeCubicMicrometers,
      );
    },
  );

  it.each([
    [
      "vertices outside facets",
      `solid invalid
       vertex 0 0 0
       vertex 1 0 0
       vertex 0 1 0
       endsolid invalid`,
    ],
    [
      "incomplete facets",
      `solid invalid
       facet normal 0 0 1
       outer loop
       vertex 0 0 0
       vertex 1 0 0
       endloop
       endfacet
       endsolid invalid`,
    ],
    [
      "extra vertex coordinates",
      `solid invalid
       facet normal 0 0 1
       outer loop
       vertex 0 0 0 1
       vertex 1 0 0
       vertex 0 1 0
       endloop
       endfacet
       endsolid invalid`,
    ],
    [
      "unclosed facets",
      `solid invalid
       facet normal 0 0 1
       outer loop
       vertex 0 0 0
       vertex 1 0 0
       vertex 0 1 0
       endloop
       endsolid invalid`,
    ],
  ])("rejects ASCII STL with %s", (_case, source) => {
    expect(() => inspectModel("stl", new TextEncoder().encode(source))).toThrow(
      /ASCII STL/u,
    );
  });

  it("discovers and canonicalizes independently selected 3MF bodies", () => {
    const source = storedZip({
      "3D/3dmodel.model": `<?xml version="1.0"?>
        <model xmlns="${coreNamespace}" unit="millimeter"><resources>
          <object id="2"><mesh>${cubeMesh}</mesh></object>
          <object id="1"><mesh>${cubeMesh}</mesh></object>
        </resources><build><item objectid="1"/><item objectid="2"/></build></model>`,
    });
    const inspection = inspectModel("3mf", source);
    expect(inspection.bodies.map(({ bodyId }) => bodyId)).toEqual([
      "body-0001",
      "body-0002",
    ]);

    const first = canonicalizeModel("3mf", source, ["body-0001"], 1_000_000);
    const second = canonicalizeModel("3mf", source, ["body-0002"], 1_000_000);
    const combined = canonicalizeModel(
      "3mf",
      source,
      ["body-0001", "body-0002"],
      1_000_000,
    );
    expect(first.inspection.bodies.map(({ bodyId }) => bodyId)).toEqual([
      "body-0001",
    ]);
    expect(second.inspection.bodies.map(({ bodyId }) => bodyId)).toEqual([
      "body-0002",
    ]);
    expect(combined.inspection.bodies).toHaveLength(2);
    expect(combined.sha256).not.toBe(first.sha256);
  });

  it("parses XML structure without treating comments, CDATA, or foreign elements as geometry", () => {
    const meshWithMarkup = cubeMesh.replace(
      "</triangles>",
      `<!-- <triangle v1="0" v2="1" v3="2"/> -->
       <![CDATA[<triangle v1="0" v2="1" v3="2"/>]]>
       <extension:triangle v1="0" v2="1" v3="2"/>
       </triangles>`,
    );
    const source = storedZip({
      "_rels/.rels": `<Relationships xmlns="${relationshipsNamespace}">
        <!-- <Relationship Target="../credential" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/> -->
        <Relationship Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
      </Relationships>`,
      "3D/3dmodel.model": `<model xmlns="${coreNamespace}" xmlns:extension="urn:foreign" unit="millimeter">
        <resources>
          <!-- <object id="9"><mesh>${cubeMesh}</mesh></object> -->
          <object id="1" name="x > y"><mesh>${meshWithMarkup}</mesh></object>
          <extension:object id="8"><extension:mesh/></extension:object>
        </resources>
        <build>
          <!-- <item objectid="9"/> -->
          <item objectid="1"/>
          <![CDATA[<item objectid="9"/>]]>
          <extension:item objectid="8"/>
        </build>
      </model>`,
    });

    const inspection = inspectModel("3mf", source);
    expect(inspection.bodies).toHaveLength(1);
    expect(inspection.bodies[0]?.triangleCount).toBe(4);
  });

  it("accepts namespace-prefixed core 3MF elements", () => {
    const prefixedMesh = cubeMesh.replace(
      /<(\/?)((?:vertices|vertex|triangles|triangle)\b)/gu,
      "<$1c:$2",
    );
    const source = storedZip({
      "3D/3dmodel.model": `<c:model xmlns:c="${coreNamespace}" unit="millimeter">
        <c:resources><c:object id="1"><c:mesh>${prefixedMesh}</c:mesh></c:object></c:resources>
        <c:build><c:item objectid="1"/></c:build>
      </c:model>`,
    });

    expect(inspectModel("3mf", source).bodies[0]?.triangleCount).toBe(4);
  });

  it("reports bounds over the union of positioned selected bodies", () => {
    const shiftedMesh = cubeMesh
      .replaceAll('x="0"', 'x="100"')
      .replaceAll('x="1"', 'x="101"');
    const source = storedZip({
      "3D/3dmodel.model": `<model xmlns="${coreNamespace}" unit="millimeter"><resources>
        <object id="1"><mesh>${cubeMesh}</mesh></object>
        <object id="2"><mesh>${shiftedMesh}</mesh></object>
      </resources><build><item objectid="1"/><item objectid="2"/></build></model>`,
    });

    expect(inspectModel("3mf", source).boundingBox.xMicrometers).toBe("101000");
  });

  it("realizes repeated build items and nested component transforms", () => {
    const source = storedZip({
      "3D/3dmodel.model": `<model xmlns="${coreNamespace}" unit="millimeter"><resources>
        <object id="1"><mesh>${cubeMesh}</mesh></object>
        <object id="2"><components>
          <component objectid="1" transform="1 0 0 0 1 0 0 0 1 10 0 0"/>
        </components></object>
        <object id="3"><mesh>${cubeMesh.replaceAll('x="1"', 'x="999"')}</mesh></object>
      </resources><build>
        <item objectid="2"/>
        <item objectid="2" transform="1 0 0 0 1 0 0 0 1 90 0 0"/>
      </build></model>`,
    });

    const inspection = inspectModel("3mf", source);
    expect(inspection.bodies.map(({ bodyId }) => bodyId)).toEqual([
      "body-0001",
      "body-0002",
    ]);
    expect(inspection.bodies.map(({ triangleCount }) => triangleCount)).toEqual(
      [4, 4],
    );
    expect(inspection.bodies[0]?.bodySha256).not.toBe(
      inspection.bodies[1]?.bodySha256,
    );
    expect(inspection.boundingBox.xMicrometers).toBe("91000");
  });

  it("resolves relationship-authorized production model components", () => {
    const source = storedZip({
      "3D/3dmodel.model": `<model xmlns="${coreNamespace}" unit="millimeter" xmlns:p="${productionNamespace}"><resources>
        <object id="1"><components>
          <component objectid="7" p:path="/3D/Objects/part.model" transform="1 0 0 0 1 0 0 0 1 25 0 0"/>
        </components></object>
      </resources><build><item objectid="1"/></build></model>`,
      "3D/_rels/3dmodel.model.rels": `<Relationships xmlns="${relationshipsNamespace}">
        <Relationship Target="/3D/Objects/part.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
      </Relationships>`,
      "3D/Objects/part.model": `<model xmlns="${coreNamespace}" unit="millimeter"><resources>
        <object id="7"><mesh>${cubeMesh}</mesh></object>
      </resources></model>`,
    });

    const inspection = inspectModel("3mf", source);
    expect(inspection.bodies).toHaveLength(1);
    expect(inspection.bodies[0]?.triangleCount).toBe(4);
    expect(inspection.bodies[0]?.boundingBox.xMicrometers).toBe("1000");
  });

  it("resolves production relationships relative to nested model parts", () => {
    const source = storedZip({
      "3D/3dmodel.model": `<model xmlns="${coreNamespace}" unit="millimeter" xmlns:p="${productionNamespace}"><resources>
        <object id="1"><components>
          <component objectid="7" p:path="/3D/Objects/part-a.model"/>
        </components></object>
      </resources><build><item objectid="1"/></build></model>`,
      "3D/_rels/3dmodel.model.rels": `<Relationships xmlns="${relationshipsNamespace}">
        <Relationship Target="/3D/Objects/part-a.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
      </Relationships>`,
      "3D/Objects/part-a.model": `<model xmlns="${coreNamespace}" unit="millimeter" xmlns:p="${productionNamespace}"><resources>
        <object id="7"><components>
          <component objectid="9" p:path="/3D/Objects/part-b.model" transform="1 0 0 0 1 0 0 0 1 25 0 0"/>
        </components></object>
      </resources></model>`,
      "3D/Objects/_rels/part-a.model.rels": `<Relationships xmlns="${relationshipsNamespace}">
        <Relationship Target="/3D/Objects/part-b.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
      </Relationships>`,
      "3D/Objects/part-b.model": `<model xmlns="${coreNamespace}" unit="millimeter"><resources>
        <object id="9"><mesh>${cubeMesh}</mesh></object>
      </resources></model>`,
    });

    const inspection = inspectModel("3mf", source);
    expect(inspection.bodies).toHaveLength(1);
    expect(inspection.bodies[0]?.triangleCount).toBe(4);
    expect(inspection.bodies[0]?.boundingBox.xMicrometers).toBe("1000");
  });

  it("preserves painted two-extruder evidence as a blocking-capable inspection", async () => {
    const model = await readFile(
      path.resolve(
        "../../tools/slicing-fixtures/fixtures/painted-multimaterial/source/3D/3dmodel.model",
      ),
      "utf8",
    );
    const relationships = await readFile(
      path.resolve(
        "../../tools/slicing-fixtures/fixtures/painted-multimaterial/source/_rels/.rels",
      ),
      "utf8",
    );
    const inspection = inspectModel(
      "3mf",
      storedZip({
        "_rels/.rels": relationships,
        "3D/3dmodel.model": model,
      }),
    );
    expect(inspection.hasPaintAssignments).toBe(true);
    expect(inspection.extruderAssignmentCount).toBe(2);
    expect(inspection.bodies[0]?.extruderAssignmentIds).toEqual([
      "extruder-1",
      "extruder-2",
    ]);
    expect(() =>
      canonicalizeModel(
        "3mf",
        storedZip({
          "_rels/.rels": relationships,
          "3D/3dmodel.model": model,
        }),
        ["body-0001"],
        1_000_000,
      ),
    ).toThrow("individual offer");
  });

  it("detects distinct per-vertex 3MF material assignments", () => {
    const assignedMesh = cubeMesh.replace(
      '<triangle v1="0" v2="2" v3="1"/>',
      '<triangle v1="0" v2="2" v3="1" pid="7" p1="0" p2="1" p3="0"/>',
    );
    const source = storedZip({
      "3D/3dmodel.model": `<model xmlns="${coreNamespace}" unit="millimeter"><resources>
        <basematerials id="7"><base name="one" displaycolor="#FFFFFFFF"/><base name="two" displaycolor="#000000FF"/></basematerials>
        <object id="1"><mesh>${assignedMesh}</mesh></object>
      </resources><build><item objectid="1"/></build></model>`,
    });

    expect(inspectModel("3mf", source).materialAssignmentCount).toBe(2);
    expect(() =>
      canonicalizeModel("3mf", source, ["body-0001"], 1_000_000),
    ).toThrow("individual offer");
  });

  it("blocks a selection that combines bodies with different materials", () => {
    const materialOne = cubeMesh.replace(
      '<triangle v1="0" v2="2" v3="1"/>',
      '<triangle v1="0" v2="2" v3="1" pid="7" p1="0"/>',
    );
    const materialTwo = cubeMesh.replace(
      '<triangle v1="0" v2="2" v3="1"/>',
      '<triangle v1="0" v2="2" v3="1" pid="7" p1="1"/>',
    );
    const source = storedZip({
      "3D/3dmodel.model": `<model xmlns="${coreNamespace}" unit="millimeter"><resources>
        <basematerials id="7"><base name="one" displaycolor="#FFFFFFFF"/><base name="two" displaycolor="#000000FF"/></basematerials>
        <object id="1"><mesh>${materialOne}</mesh></object>
        <object id="2"><mesh>${materialTwo}</mesh></object>
      </resources><build><item objectid="1"/><item objectid="2"/></build></model>`,
    });

    expect(inspectModel("3mf", source).materialAssignmentCount).toBe(2);
    expect(() =>
      canonicalizeModel("3mf", source, ["body-0001", "body-0002"], 1_000_000),
    ).toThrow("individual offer");
  });

  it("resolves composite resources into their base material constituents", () => {
    const source = storedZip({
      "3D/3dmodel.model": `<model xmlns="${coreNamespace}" unit="millimeter" xmlns:m="${materialNamespace}"><resources>
        <basematerials id="7"><base name="one" displaycolor="#FFFFFFFF"/><base name="two" displaycolor="#000000FF"/></basematerials>
        <m:compositematerials id="8" matid="7" matindices="0 1"><m:composite values="0.5 0.5"/></m:compositematerials>
        <object id="1" pid="8" pindex="0"><mesh>${cubeMesh}</mesh></object>
      </resources><build><item objectid="1"/></build></model>`,
    });

    expect(inspectModel("3mf", source).materialAssignmentCount).toBe(2);
    expect(() =>
      canonicalizeModel("3mf", source, ["body-0001"], 1_000_000),
    ).toThrow("individual offer");
  });

  it("resolves multiproperties through composite material resources", () => {
    const source = storedZip({
      "3D/3dmodel.model": `<model xmlns="${coreNamespace}" unit="millimeter" xmlns:m="${materialNamespace}"><resources>
        <basematerials id="7"><base name="one" displaycolor="#FFFFFFFF"/><base name="two" displaycolor="#000000FF"/></basematerials>
        <m:compositematerials id="8" matid="7" matindices="0 1"><m:composite values="0.5 0.5"/></m:compositematerials>
        <m:colorgroup id="9"><m:color color="#FFFFFFFF"/></m:colorgroup>
        <m:multiproperties id="10" pids="8 9"><m:multi pindices="0 0"/></m:multiproperties>
        <object id="1" pid="10" pindex="0"><mesh>${cubeMesh}</mesh></object>
      </resources><build><item objectid="1"/></build></model>`,
    });

    expect(inspectModel("3mf", source).materialAssignmentCount).toBe(3);
    expect(() =>
      canonicalizeModel("3mf", source, ["body-0001"], 1_000_000),
    ).toThrow("individual offer");
  });

  it("rejects missing and out-of-range 3MF property references", () => {
    const missing = storedZip({
      "3D/3dmodel.model": `<model xmlns="${coreNamespace}" unit="millimeter"><resources>
        <object id="1" pid="7" pindex="0"><mesh>${cubeMesh}</mesh></object>
      </resources><build><item objectid="1"/></build></model>`,
    });
    const outOfRange = storedZip({
      "3D/3dmodel.model": `<model xmlns="${coreNamespace}" unit="millimeter"><resources>
        <basematerials id="7"><base name="one" displaycolor="#FFFFFFFF"/></basematerials>
        <object id="1" pid="7" pindex="1"><mesh>${cubeMesh}</mesh></object>
      </resources><build><item objectid="1"/></build></model>`,
    });

    expect(() => inspectModel("3mf", missing)).toThrow("missing resource");
    expect(() => inspectModel("3mf", outOfRange)).toThrow("out of range");
  });

  it("rejects traversal before reading 3MF relationships", () => {
    const source = storedZip({
      "3D/3dmodel.model": `<model xmlns="${coreNamespace}" unit="millimeter"><resources><object id="1"><mesh>${cubeMesh}</mesh></object></resources></model>`,
      "_rels/.rels": `<Relationships xmlns="${relationshipsNamespace}"><Relationship Target="../credential"/></Relationships>`,
    });
    expect(() => inspectModel("3mf", source)).toThrow("unsafe");
  });
});
