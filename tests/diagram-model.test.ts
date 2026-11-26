import assert from "node:assert/strict";
import { test } from "node:test";
import { diagramNodeLabel, diagramProjection, initialView, parseDiagram, type Diagram } from "../diagram/model.ts";

const architecture: Diagram = {
  title: "Tracking",
  systemId: "tracking",
  nodes: [
    {
      id: "merchant",
      kind: "person",
      label: "Merchant",
      detail: "Looks up parcels",
    },
    {
      id: "tracking",
      kind: "system",
      label: "Tracking",
      detail: "Tracks parcels",
    },
    {
      id: "api",
      kind: "container",
      label: "Tracking API",
      detail: "Handles queries",
      technology: "Go",
    },
    {
      id: "store",
      kind: "container",
      label: "Scan store",
      detail: "Keeps scans",
      technology: "PostgreSQL",
    },
    {
      id: "carrier",
      kind: "system",
      label: "Carrier",
      detail: "Supplies delivery events",
    },
  ],
  edges: [
    { from: "merchant", to: "tracking", label: "Tracks parcels" },
    {
      from: "merchant",
      to: "api",
      label: "Looks up tracking",
      technology: "HTTPS",
    },
    { from: "api", to: "store", label: "Reads scans", technology: "SQL" },
    { from: "carrier", to: "api", label: "Sends events", technology: "HTTPS" },
    {
      from: "api",
      to: "carrier",
      label: "Requests history",
      technology: "HTTPS",
    },
  ],
};

await test("context expresses directed system interactions and hides implementation details", () => {
  const diagram = parseDiagram(architecture);
  assert.equal(initialView(diagram), "context");
  const context = diagramProjection(diagram, "context");
  assert.deepEqual(
    context.nodes.map((n) => n.id),
    ["merchant", "tracking", "carrier"],
  );
  assert.deepEqual(context.edges, [
    { from: "merchant", to: "tracking", label: "Tracks parcels" },
    { from: "carrier", to: "tracking", label: "Sends events" },
    { from: "tracking", to: "carrier", label: "Requests history" },
  ]);
});

await test("container zoom retains concrete endpoints and never invents an implementation for a context-only system", () => {
  const diagram = parseDiagram({
    ...architecture,
    view: "container",
    nodes: [
      ...architecture.nodes,
      {
        id: "partner",
        kind: "system",
        label: "Partner",
        detail: "Receives reports.",
      },
    ],
    edges: [...architecture.edges, { from: "tracking", to: "partner", label: "Reports outcomes" }],
  });
  const zoom = diagramProjection(diagram, initialView(diagram));
  assert.equal(zoom.system.id, "tracking");
  assert.deepEqual(
    zoom.nodes.map((n) => n.id),
    ["merchant", "api", "store", "carrier"],
  );
  assert.deepEqual(zoom.edges, architecture.edges.slice(1));
});

await test("rollup collapses duplicate boundary edges and preserves distinct purposes", () => {
  const diagram = parseDiagram({
    ...architecture,
    edges: [
      { from: "api", to: "carrier", label: "Reads" },
      { from: "store", to: "carrier", label: "Reads" },
      { from: "api", to: "carrier", label: "Writes" },
      { from: "api", to: "store", label: "Persists events" },
    ],
  });
  assert.deepEqual(diagramProjection(diagram, "context").edges, [
    { from: "tracking", to: "carrier", label: "Reads" },
    { from: "tracking", to: "carrier", label: "Writes" },
  ]);
});

await test("context-only architectures work and the boundary has a valid identity", () => {
  const context = {
    title: "Carrier",
    systemId: "carrier",
    nodes: architecture.nodes.filter((n) => n.kind !== "container"),
    edges: [],
  };
  assert.equal(parseDiagram(context).systemId, "carrier");
  assert.throws(() => parseDiagram({ ...context, view: "container" }), /at least one application/);
  assert.throws(() => parseDiagram({ ...architecture, systemId: "api" }), /systemId/);
  assert.throws(
    () =>
      parseDiagram({
        ...architecture,
        edges: [{ from: "tracking", to: "store", label: "Contains" }],
      }),
    /Containment/,
  );
  assert.throws(
    () =>
      parseDiagram({
        ...architecture,
        edges: [{ from: "tracking", to: "unknown", label: "Uses" }],
      }),
    /Unknown diagram node ID: unknown/,
  );
  assert.throws(
    () =>
      parseDiagram({
        ...architecture,
        nodes: [...architecture.nodes, architecture.nodes[0]],
      }),
    /Duplicate diagram node ID/,
  );
});

await test("display names and responsibilities are safe plain text and IDs disambiguate duplicates", () => {
  const diagram = parseDiagram({
    ...architecture,
    title: "\x1b[31mParcel\x1b[0m\u202e",
    nodes: architecture.nodes.map((n) => ({ ...n, label: "Tracking" })),
  });
  assert.equal(diagram.title, "Parcel");
  const api = diagram.nodes.find((n) => n.id === "api");
  assert.ok(api !== undefined);
  assert.equal(diagramNodeLabel(diagram, api), "Tracking (api)");
  assert.throws(() => parseDiagram({ ...diagram, question: "   " }), /visible characters/);
});
