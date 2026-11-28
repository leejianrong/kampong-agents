// KAM-340: the smoke and isolation gate for the hosted server, run against a real deployment of the chart (see
// .github/workflows/hosted-smoke.yml). Plain Node, no dependencies. It signs up two tenants and checks, over HTTP:
//   - deploy, webhook, approve and finish for tenant A;
//   - twenty webhooks in flight at once across both tenants, each finishing with its own tenant's result;
//   - tenant B cannot read, approve, list or export anything of A's.
// It starts by proving the isolation check can fail: the same check pointed at a server that leaks must throw.
//
//   BASE_URL=http://127.0.0.1:8080 node e2e/hosted-smoke/smoke.mjs

import { createServer } from "node:http";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8080";

class Tenant {
  constructor(name, base) {
    this.name = name;
    this.base = base;
    this.cookie = "";
  }
  async req(method, path, body, extra = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        origin: this.base,
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...extra,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text, headers: res.headers };
  }
  async signUp() {
    const email = `${this.name}-${Date.now()}-${Math.random().toString(16).slice(2)}@smoke.test`;
    const res = await fetch(this.base + "/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: this.base },
      body: JSON.stringify({ email, password: "correct-horse-battery-staple", name: this.name }),
    });
    if (!res.ok)
      throw new Error(`sign-up for ${this.name} failed: ${res.status} ${await res.text()}`);
    this.cookie = (res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""])
      .map((c) => c.split(";")[0])
      .join("; ");
    const org = await this.req("POST", "/api/auth/organization/create", {
      name: this.name,
      slug: `${this.name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    });
    if (org.status !== 200)
      throw new Error(`create workspace for ${this.name} failed: ${org.text}`);
    return this;
  }
}

const spec = (tag) => `version: "1.1"
agent:
  id: smoke
  name: "Smoke ${tag}"
  role: "r"
  goal: "g"
  workflow:
    - step: stamp
      type: transform
      set:
        owner: "${tag}"
    - step: review
      type: approval
      message: "Continue for ${tag}?"
    - step: done
      type: transform
      set:
        owner: "${tag}"
`;

function check(cond, message) {
  if (!cond) throw new Error(message);
}

async function until(fn, what, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The isolation check: `other` asks for `runId`, which belongs to someone else, and must be told it is not there. */
export async function assertRunInvisible(other, runId) {
  const read = await other.req("GET", `/api/runs/${runId}`);
  check(read.status === 404, `${other.name} could read run ${runId}: HTTP ${read.status}`);
  const approve = await other.req("POST", `/api/runs/${runId}/approve`, { approved: true });
  check(approve.status === 404, `${other.name} could act on run ${runId}: HTTP ${approve.status}`);
}

async function canary() {
  // A server that ignores the workspace and answers every request with 200: the check must throw against it.
  const leaky = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  await new Promise((r) => leaky.listen(0, "127.0.0.1", r));
  const { port } = leaky.address();
  try {
    const stranger = new Tenant("canary", `http://127.0.0.1:${port}`);
    let caught = false;
    try {
      await assertRunInvisible(stranger, "00000000-0000-0000-0000-000000000000");
    } catch {
      caught = true;
    }
    check(caught, "the isolation check did not fail against a server that leaks");
  } finally {
    leaky.close();
  }
  console.log("ok  the isolation check fails against a leaking server");
}

async function deployed(tenant, tag) {
  const created = await tenant.req("POST", "/api/specs", {
    name: `smoke-${tag}`,
    source: spec(tag),
  });
  check(created.status === 201, `${tenant.name}: create spec: ${created.text}`);
  const specId = created.json.id;
  const dep = await tenant.req("PUT", `/api/specs/${specId}/deployment`);
  check(dep.status === 200, `${tenant.name}: deploy: ${dep.text}`);
  return { specId, path: dep.json.webhookPath };
}

async function fire(tenant, path) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  check(res.status === 201, `webhook ${path}: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()).id;
}

async function main() {
  await canary();
  if (process.env.CANARY_ONLY) return;

  const health = await fetch(BASE + "/healthz");
  check(health.ok, `/healthz: HTTP ${health.status}`);
  console.log("ok  /healthz");

  const a = await new Tenant("a", BASE).signUp();
  const b = await new Tenant("b", BASE).signUp();
  const tagA = `A-${Date.now()}`;
  const tagB = `B-${Date.now()}`;
  const depA = await deployed(a, tagA);
  const depB = await deployed(b, tagB);
  console.log("ok  two tenants signed up and deployed");

  // One run end to end: webhook, pause for approval, approve, finish.
  const first = await fire(a, depA.path);
  const paused = await until(async () => {
    const r = await a.req("GET", `/api/runs/${first}`);
    return r.json?.state?.status === "awaiting_approval" ? r : undefined;
  }, "the run to ask for approval");
  check(paused.json.state.status === "awaiting_approval", "run did not pause");
  await assertRunInvisible(b, first);
  const approved = await a.req("POST", `/api/runs/${first}/approve`, { approved: true });
  check(approved.status === 200, `approve: ${approved.text}`);
  const finished = await until(async () => {
    const r = await a.req("GET", `/api/runs/${first}`);
    return r.json?.state?.status === "completed" ? r : undefined;
  }, "the approved run to finish");
  check(finished.json.state.finalOutput.done.owner === tagA, "the finished run has another owner");
  console.log("ok  deploy, webhook, approve, finish");

  // Twenty at once, interleaved: each one ends with its own tenant's tag, and never the other's.
  const jobs = [];
  for (let i = 0; i < 10; i++) {
    jobs.push({ tenant: a, tag: tagA, other: b, id: fire(a, depA.path) });
    jobs.push({ tenant: b, tag: tagB, other: a, id: fire(b, depB.path) });
  }
  for (const job of jobs) job.id = await job.id;
  for (const job of jobs) {
    await until(async () => {
      const r = await job.tenant.req("GET", `/api/runs/${job.id}`);
      return r.json?.state?.status === "awaiting_approval";
    }, `run ${job.id} to ask for approval`);
    await assertRunInvisible(job.other, job.id);
  }
  await Promise.all(
    jobs.map((job) => job.tenant.req("POST", `/api/runs/${job.id}/approve`, { approved: true })),
  );
  for (const job of jobs) {
    const done = await until(async () => {
      const r = await job.tenant.req("GET", `/api/runs/${job.id}`);
      return r.json?.state?.status === "completed" ? r : undefined;
    }, `run ${job.id} to finish`);
    const out = done.json.state.finalOutput;
    check(
      out.stamp.owner === job.tag && out.done.owner === job.tag,
      `run ${job.id} of ${job.tenant.name} ended with ${JSON.stringify(out)}`,
    );
  }
  console.log("ok  twenty runs in flight keep their own tenant's result");

  // B cannot see A's other objects, and A's export holds nothing of B's.
  const specs = await b.req("GET", "/api/specs");
  check(
    !specs.text.includes(depA.specId) && !specs.text.includes(tagA),
    "B's spec list mentions A's spec",
  );
  const peekSpec = await b.req("GET", `/api/specs/${depA.specId}`);
  check(peekSpec.status === 404, `B read A's spec: HTTP ${peekSpec.status}`);
  const peekDep = await b.req("GET", `/api/specs/${depA.specId}/deployment`);
  check(peekDep.status === 404, `B read A's deployment: HTTP ${peekDep.status}`);
  const auditB = await b.req("GET", "/api/audit");
  check(auditB.status === 200, `audit export: HTTP ${auditB.status}`);
  check(!auditB.text.includes(depA.specId), "B's audit export mentions A's spec");
  console.log("ok  tenant B sees nothing of tenant A");
  console.log("smoke passed");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`SMOKE FAILED: ${err.message}`);
    process.exit(1);
  });
}
