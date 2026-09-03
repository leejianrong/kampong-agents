#!/usr/bin/env node
// `kampong dev` / `kampong run` / `kampong export` (PLAN.md Shape S5,
// ADR-0005: thin wrapper around the same S1/S3/S6 packages used by the
// canvas app). `kampong dev` starts a Fastify server (ADR-0007) that serves
// the built canvas assets, a spec-CRUD REST API, and an SSE run-progress
// stream. Real commands/routes land with SLICES.md V1/V2/V3/V4 — this file
// is scaffolding only, to prove the build/lint/test pipeline with the
// chosen stack wired in.

import Fastify from "fastify";

export const PACKAGE_NAME = "@kampong/cli";

export function createDevServer() {
  return Fastify({ logger: false });
}
