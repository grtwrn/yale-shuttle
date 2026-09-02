import { describe, expect, it } from "vitest";

import { UpstreamClient, UpstreamError } from "./upstream.js";

function clientFor(body: unknown, status = 200): UpstreamClient {
  const fetchImpl = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  return new UpstreamClient({ baseUrl: "http://upstream.test", fetchImpl });
}

const good = { id: 1, name: "#40", lat: "41.31", lon: "-72.92", heading: 90, route: 3, lastStop: 100 };

describe("UpstreamClient.buses validates each row on its own", () => {
  it("keeps the good rows when one vehicle is malformed", async () => {
    // A bus logged in but unassigned reports route:null; a dead GPS lat:null.
    // Either used to fail the whole array and empty the fleet for riders.
    const client = clientFor([
      good,
      { ...good, id: 2, name: "#41", route: null },
      { ...good, id: 3, name: "#42", lat: null },
      { ...good, id: 4, name: null },
      "not even an object",
      { ...good, id: 5, name: "#44" },
    ]);
    const buses = await client.buses();
    expect(buses.map((b) => b.id)).toEqual([1, 5]);
    expect(buses[0]).toMatchObject({ id: 1, name: "#40", lat: 41.31, lon: -72.92, route: 3 });
    expect(client.lastDroppedRows).toBe(4);
  });

  it("reports zero drops on a clean response and resets between calls", async () => {
    const client = clientFor([good]);
    expect(await client.buses()).toHaveLength(1);
    expect(client.lastDroppedRows).toBe(0);
  });

  it("still fails loudly when the response is not a list at all", async () => {
    await expect(clientFor({ error: "maintenance" }).buses()).rejects.toBeInstanceOf(UpstreamError);
    await expect(clientFor([], 503).buses()).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("UpstreamClient.routes keeps the published timetable", () => {
  const route = {
    id: 3, name: "Red", short_name: "R", color: "C62828", stops: [1, 2, 3],
    path: [41.31, -72.93, 41.32, -72.92],
  };

  it("threads a trimmed description through", async () => {
    const client = clientFor([{ ...route, description: "  7am - 6pm, M - F " }]);
    const [r] = await client.routes();
    expect(r!.description).toBe("7am - 6pm, M - F");
    expect(r!.path).toEqual([[41.31, -72.93], [41.32, -72.92]]);
  });

  it("omits the field when upstream publishes nothing", async () => {
    const [blank] = await clientFor([{ ...route, description: "   " }]).routes();
    expect(blank).not.toHaveProperty("description");
    const [absent] = await clientFor([route]).routes();
    expect(absent).not.toHaveProperty("description");
  });
});
