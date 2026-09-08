import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { registerBurstRoutes } from "../server/burst-routes.mjs";
import { schemaErrorFormatter } from "../server/request-schemas.mjs";

const REPO = "repoAAAAAAAAAAAAAA";

function fakeService() {
  const burst = { burstId: "burst-1", status: "ready", candidates: [{ repositoryId: REPO, status: "proposed", goal: "g" }] };
  return {
    calls: [],
    async create() { this.calls.push(["create"]); return burst; },
    list() { return [burst]; },
    get(id) { return id === "burst-1" ? burst : null; },
    async approve(id, repo, body) { this.calls.push(["approve", id, repo, body]); return { ...burst.candidates[0], status: "approved", planId: "plan-1" }; },
    decline(id, repo) { this.calls.push(["decline", id, repo]); return { ...burst.candidates[0], status: "declined" }; },
    async rescan(id, repo) { this.calls.push(["rescan", id, repo]); return { ...burst.candidates[0], status: "scanning" }; },
  };
}

async function app(t, service) {
  const instance = Fastify({ schemaErrorFormatter, ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });
  instance.setErrorHandler((error, _request, reply) => reply.code(error instanceof TypeError ? 400 : 500).send({ error: error.message }));
  const invalidated = [];
  registerBurstRoutes(instance, { bursts: service, invalidate: () => invalidated.push(1) });
  t.after(() => instance.close());
  return { instance, invalidated };
}

test("create, list and read", async (t) => {
  const service = fakeService();
  const { instance } = await app(t, service);
  assert.equal((await instance.inject({ method: "POST", url: "/api/bursts" })).statusCode, 201);
  assert.equal((await instance.inject({ url: "/api/bursts" })).json().bursts.length, 1);
  assert.equal((await instance.inject({ url: "/api/bursts/burst-1" })).json().burstId, "burst-1");
  assert.equal((await instance.inject({ url: "/api/bursts/nope" })).statusCode, 404);
});

test("a create that starts nothing answers 200 with the reason", async (t) => {
  const service = fakeService();
  service.create = async () => ({ status: "no_starred_repositories", message: "No starred repositories", burstId: null });
  const { instance } = await app(t, service);
  const response = await instance.inject({ method: "POST", url: "/api/bursts" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, "no_starred_repositories");
});

test("approve passes the goal override and invalidates dashboard caches", async (t) => {
  const service = fakeService();
  const { instance, invalidated } = await app(t, service);
  const response = await instance.inject({ method: "POST", url: `/api/bursts/burst-1/candidates/${REPO}/approve`, payload: { goal: "Edited" } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().planId, "plan-1");
  assert.deepEqual(service.calls.at(-1), ["approve", "burst-1", REPO, { goal: "Edited" }]);
  assert.equal(invalidated.length, 1);
  assert.equal((await instance.inject({ method: "POST", url: `/api/bursts/burst-1/candidates/${REPO}/approve`, payload: { goal: 7 } })).statusCode, 400);
  assert.equal((await instance.inject({ method: "POST", url: `/api/bursts/burst-1/candidates/${REPO}/approve`, payload: { goal: "x".repeat(4_001) } })).statusCode, 400);
  assert.equal((await instance.inject({ method: "POST", url: `/api/bursts/burst-1/candidates/bad/approve`, payload: {} })).statusCode, 400);
  assert.equal((await instance.inject({ method: "POST", url: `/api/bursts/nope/candidates/${REPO}/approve`, payload: {} })).statusCode, 400);
});

test("decline and rescan", async (t) => {
  const service = fakeService();
  const { instance } = await app(t, service);
  assert.equal((await instance.inject({ method: "POST", url: `/api/bursts/burst-1/candidates/${REPO}/decline` })).json().status, "declined");
  assert.equal((await instance.inject({ method: "POST", url: `/api/bursts/burst-1/candidates/${REPO}/rescan` })).json().status, "scanning");
});

test("routes are unavailable without a service", async (t) => {
  const instance = Fastify();
  instance.setErrorHandler((error, _request, reply) => reply.code(error.statusCode || 500).send({ error: error.message }));
  registerBurstRoutes(instance, { bursts: null, invalidate: () => {} });
  t.after(() => instance.close());
  assert.equal((await instance.inject({ url: "/api/bursts" })).statusCode, 503);
  assert.equal((await instance.inject({ method: "POST", url: "/api/bursts" })).statusCode, 503);
});
