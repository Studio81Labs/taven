import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalizeModel, inspectModel } from "./model-inspection.js";

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
  it("discovers and canonicalizes independently selected 3MF bodies", () => {
    const source = storedZip({
      "3D/3dmodel.model": `<?xml version="1.0"?>
        <model unit="millimeter"><resources>
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

  it("reports bounds over the union of positioned selected bodies", () => {
    const shiftedMesh = cubeMesh
      .replaceAll('x="0"', 'x="100"')
      .replaceAll('x="1"', 'x="101"');
    const source = storedZip({
      "3D/3dmodel.model": `<model unit="millimeter"><resources>
        <object id="1"><mesh>${cubeMesh}</mesh></object>
        <object id="2"><mesh>${shiftedMesh}</mesh></object>
      </resources><build><item objectid="1"/><item objectid="2"/></build></model>`,
    });

    expect(inspectModel("3mf", source).boundingBox.xMicrometers).toBe("101000");
  });

  it("realizes repeated build items and nested component transforms", () => {
    const source = storedZip({
      "3D/3dmodel.model": `<model unit="millimeter"><resources>
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
      "3D/3dmodel.model": `<model unit="millimeter" xmlns:q="urn:production"><resources>
        <object id="1"><components>
          <component objectid="7" q:path="/3D/Objects/part.model" transform="1 0 0 0 1 0 0 0 1 25 0 0"/>
        </components></object>
      </resources><build><item objectid="1"/></build></model>`,
      "3D/_rels/3dmodel.model.rels": `<Relationships>
        <Relationship Target="/3D/Objects/part.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
      </Relationships>`,
      "3D/Objects/part.model": `<model unit="millimeter"><resources>
        <object id="7"><mesh>${cubeMesh}</mesh></object>
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
      "3D/3dmodel.model": `<model unit="millimeter"><resources><object id="1"><mesh>${assignedMesh}</mesh></object></resources><build><item objectid="1"/></build></model>`,
    });

    expect(inspectModel("3mf", source).materialAssignmentCount).toBe(2);
    expect(() =>
      canonicalizeModel("3mf", source, ["body-0001"], 1_000_000),
    ).toThrow("individual offer");
  });

  it("blocks a selection that combines bodies with different materials", () => {
    const materialOne = cubeMesh.replace(
      '<triangle v1="0" v2="2" v3="1"/>',
      '<triangle v1="0" v2="2" v3="1" pid="7" pindex="0"/>',
    );
    const materialTwo = cubeMesh.replace(
      '<triangle v1="0" v2="2" v3="1"/>',
      '<triangle v1="0" v2="2" v3="1" pid="7" pindex="1"/>',
    );
    const source = storedZip({
      "3D/3dmodel.model": `<model unit="millimeter"><resources>
        <object id="1"><mesh>${materialOne}</mesh></object>
        <object id="2"><mesh>${materialTwo}</mesh></object>
      </resources><build><item objectid="1"/><item objectid="2"/></build></model>`,
    });

    expect(inspectModel("3mf", source).materialAssignmentCount).toBe(2);
    expect(() =>
      canonicalizeModel("3mf", source, ["body-0001", "body-0002"], 1_000_000),
    ).toThrow("individual offer");
  });

  it("rejects traversal before reading 3MF relationships", () => {
    const source = storedZip({
      "3D/3dmodel.model": `<model unit="millimeter"><resources><object id="1"><mesh>${cubeMesh}</mesh></object></resources></model>`,
      "_rels/.rels": `<Relationships><Relationship Target="../credential"/></Relationships>`,
    });
    expect(() => inspectModel("3mf", source)).toThrow("unsafe");
  });
});
