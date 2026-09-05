import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelClient } from "@kampong/engine";
import {
  EXIT_EXECUTION_FAILURE,
  EXIT_SUCCESS,
  EXIT_USAGE_ERROR,
  EXIT_VALIDATION_FAILURE,
  runCli,
} from "../../src/cli.js";
import { capture, capturePipedStdin } from "./test-helpers.js";

// SLICES.md V3 unit test plan: "CLI exit codes are correct for success,
// validation failure, and execution failure cases" and "CLI output is
// valid, parseable JSON when requested." Uses the `RunCliTestOptions.model`
// test seam (cli.ts) to exercise the "success" path with zero network
// dependency -- the real `kampong` binary never has this seam available.

function textModel(text = "ok"): ModelClient {
  return {
    async generateText() {
      return text;
    },
    async generateStructured<T>() {
      return { result: {}, confidence: 1 } as T;
    },
  };
}

const SIMPLE_SPEC = `version: "1.0"
agent:
  id: greeter
  name: "Greeter"
  role: "Front desk"
  goal: "Greet visitors."
  workflow:
    - step: greet
      action: say_hello
`;

const BROKEN_SPEC = `version: "1.0"
agent:
  id: broken
`;

const TWO_STEP_SPEC = `version: "1.0"
agent:
  id: greeter
  name: "Greeter"
  role: "Front desk"
  goal: "Greet visitors."
  workflow:
    - step: greet
      action: say_hello
    - step: farewell
      action: say_bye
`;

describe("runCli -- top level", () => {
  it("no command prints usage to stderr and exits with a usage error", async () => {
    const { io, err } = capture();
    const code = await runCli([], io);
    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(err.join("\n")).toContain("Usage: kampong");
  });

  it("--help exits 0 and prints usage to stdout", async () => {
    const { io, out } = capture();
    const code = await runCli(["--help"], io);
    expect(code).toBe(EXIT_SUCCESS);
    expect(out.join("\n")).toContain("Usage: kampong");
  });

  it("an unknown command is a usage error, not a crash", async () => {
    const { io, err } = capture();
    const code = await runCli(["frobnicate"], io);
    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(err.join("\n")).toContain('unknown command "frobnicate"');
  });
});

describe("kampong run -- exit codes (SLICES.md V3 unit test plan)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-cli-run-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 0 on a completed run", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, SIMPLE_SPEC);
    const { io, out } = capture();

    const code = await runCli(["run", specPath, "--input", "hi"], io, { model: textModel() });

    expect(code).toBe(EXIT_SUCCESS);
    expect(out.join("\n")).toContain("Run completed");
  });

  it("exits 1 (validation failure) when the spec fails schema validation", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, BROKEN_SPEC);
    const { io } = capture();

    const code = await runCli(["run", specPath, "--input", "hi"], io, { model: textModel() });

    expect(code).toBe(EXIT_VALIDATION_FAILURE);
  });

  it("exits 1 when the spec file doesn't exist at all", async () => {
    const { io } = capture();
    const code = await runCli(["run", join(dir, "missing.yaml"), "--input", "hi"], io);
    expect(code).toBe(EXIT_VALIDATION_FAILURE);
  });

  it("exits 2 (execution failure) when the run fails -- e.g. no model configured and no test model injected", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, SIMPLE_SPEC);
    const { io, err } = capture();

    const code = await runCli(["run", specPath, "--input", "hi"], io); // no injected model

    expect(code).toBe(EXIT_EXECUTION_FAILURE);
    expect(err.join("\n")).toContain("agent.model");
  });

  it("exits 64 (usage error) when --input is missing", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, SIMPLE_SPEC);
    const { io, err } = capture();

    const code = await runCli(["run", specPath], io);

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(err.join("\n")).toContain("--input");
  });

  it("exits 64 on an unrecognized --tools value", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, SIMPLE_SPEC);
    const { io } = capture();

    const code = await runCli(["run", specPath, "--input", "hi", "--tools", "bogus"], io);

    expect(code).toBe(EXIT_USAGE_ERROR);
  });

  it("exits 64 on a non-numeric --timeout value (KAN-1185)", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, SIMPLE_SPEC);
    const { io, err } = capture();

    const code = await runCli(["run", specPath, "--input", "hi", "--timeout", "soon"], io);

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(err.join("\n")).toContain("--timeout must be a positive integer");
  });

  it("exits 64 on a zero/negative --timeout value (KAN-1185)", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, SIMPLE_SPEC);
    const { io } = capture();

    const code = await runCli(["run", specPath, "--input", "hi", "--timeout", "0"], io);

    expect(code).toBe(EXIT_USAGE_ERROR);
  });

  it("accepts a valid --timeout and runs normally (KAN-1185)", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, SIMPLE_SPEC);
    const { io, out } = capture();

    const code = await runCli(["run", specPath, "--input", "hi", "--timeout", "5000"], io, {
      model: textModel(),
    });

    expect(code).toBe(EXIT_SUCCESS);
    expect(out.join("\n")).toContain("Run completed");
  });

  it("exits 64, not 2, when a flag is given with no following value (finding #3)", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, SIMPLE_SPEC);
    const { io, err } = capture();

    // `--input` is the last argument -- no value follows it.
    const code = await runCli(["run", specPath, "--input"], io);

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(err.join("\n")).toContain("--input requires a value");
    expect(err.join("\n")).not.toContain("unexpected error");
  });

  it("kampong dev also exits 64, not 2, when a flag is given with no following value (finding #3)", async () => {
    const { io, err } = capture();

    const code = await runCli(["dev", ".", "--spec"], io);

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(err.join("\n")).toContain("--spec requires a value");
    expect(err.join("\n")).not.toContain("unexpected error");
  });
});

describe("kampong run --json (SLICES.md V3 unit test plan: parseable JSON output)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-cli-json-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits exactly one parseable JSON object on success", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, SIMPLE_SPEC);
    const { io, out } = capture();

    const code = await runCli(["run", specPath, "--input", "hi", "--json"], io, {
      model: textModel("hello there"),
    });

    expect(code).toBe(EXIT_SUCCESS);
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]!);
    expect(parsed.success).toBe(true);
    expect(parsed.status).toBe("completed");
  });

  it("emits parseable JSON with validation errors on a validation failure", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, BROKEN_SPEC);
    const { io, out } = capture();

    const code = await runCli(["run", specPath, "--input", "hi", "--json"], io);

    expect(code).toBe(EXIT_VALIDATION_FAILURE);
    const parsed = JSON.parse(out[0]!);
    expect(parsed.success).toBe(false);
    expect(parsed.phase).toBe("validation");
    expect(Array.isArray(parsed.errors)).toBe(true);
  });

  it("emits parseable JSON describing an execution failure", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, SIMPLE_SPEC);
    const { io, out } = capture();

    const code = await runCli(["run", specPath, "--input", "hi", "--json"], io);

    expect(code).toBe(EXIT_EXECUTION_FAILURE);
    const parsed = JSON.parse(out[0]!);
    expect(parsed.success).toBe(false);
    expect(typeof parsed.error).toBe("string");
  });
});

describe("kampong run -- progress output in non-JSON mode (KAN-1185)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-cli-progress-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints a progress line for each step BEFORE the run completes, in non-JSON mode", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, TWO_STEP_SPEC);
    const { io, out } = capture();

    const code = await runCli(["run", specPath, "--input", "hi"], io, { model: textModel() });

    expect(code).toBe(EXIT_SUCCESS);
    // Both steps' progress lines appear...
    expect(out.some((line) => line.includes("greet") && line.includes("running"))).toBe(true);
    expect(out.some((line) => line.includes("farewell") && line.includes("running"))).toBe(true);
    // ...and strictly before the "Run completed" line, not after (proves
    // this is genuine *progress* output -- printed as each step starts --
    // not something printed retroactively once the whole run is done).
    const completedIndex = out.findIndex((line) => line.includes("Run completed"));
    const progressIndexes = out
      .map((line, i) => ({ line, i }))
      .filter(
        ({ line }) =>
          line.includes("running") && (line.includes("greet") || line.includes("farewell")),
      )
      .map(({ i }) => i);
    expect(completedIndex).toBeGreaterThan(-1);
    expect(progressIndexes.length).toBeGreaterThan(0);
    for (const i of progressIndexes) {
      expect(i).toBeLessThan(completedIndex);
    }
  });

  it("--json mode stays exactly one parseable JSON line -- no progress lines mixed into stdout", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, TWO_STEP_SPEC);
    const { io, out } = capture();

    const code = await runCli(["run", specPath, "--input", "hi", "--json"], io, {
      model: textModel(),
    });

    expect(code).toBe(EXIT_SUCCESS);
    expect(out).toHaveLength(1);
    expect(() => JSON.parse(out[0]!)).not.toThrow();
    expect(out[0]).not.toContain("running");
  });
});

describe("kampong run -- approval prompt / --approve-all (KAN-1110)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kampong-cli-approval-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const GUARDRAIL_SPEC = `version: "1.0"
agent:
  id: refund-agent
  name: "Refund Agent"
  role: "Support"
  goal: "Handle refunds."
  guardrails:
    confidence_threshold: 0.85
    fallback_action: escalate_to_human
  workflow:
    - step: evaluate
      action: check_eligibility
      confidence_gate: true
`;

  function lowConfidenceModel(): ModelClient {
    return {
      async generateText() {
        return "unused";
      },
      async generateStructured<T>() {
        return { result: { eligible: true }, confidence: 0.1 } as T;
      },
    };
  }

  it("--approve-all resolves the pause automatically with no stdin interaction and completes", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, GUARDRAIL_SPEC);
    const { io, out, err } = capture(); // empty stdin -- would hang forever if actually prompted

    const code = await runCli(["run", specPath, "--input", "refund #1", "--approve-all"], io, {
      model: lowConfidenceModel(),
    });

    expect(code).toBe(EXIT_SUCCESS);
    // The auto-approve diagnostic goes to stderr, never stdout (finding #4)
    // -- stdout stays reserved for the run's actual output.
    expect(err.join("\n")).toContain("auto-approving");
    expect(out.join("\n")).not.toContain("auto-approving");
  });

  it("--approve-all with --json emits exactly one JSON object on stdout -- the auto-approve diagnostic never leaks into it (finding #4)", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, GUARDRAIL_SPEC);
    const { io, out, err } = capture();

    const code = await runCli(
      ["run", specPath, "--input", "refund #1", "--approve-all", "--json"],
      io,
      { model: lowConfidenceModel() },
    );

    expect(code).toBe(EXIT_SUCCESS);
    expect(out).toHaveLength(1);
    expect(() => JSON.parse(out[0]!)).not.toThrow();
    expect(err.join("\n")).toContain("auto-approving");
  });

  it("without --approve-all, an explicit stdin 'y' approves and the run completes", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, GUARDRAIL_SPEC);
    const { io, out } = capture(["y"]);

    const code = await runCli(["run", specPath, "--input", "refund #1"], io, {
      model: lowConfidenceModel(),
    });

    expect(code).toBe(EXIT_SUCCESS);
    expect(out.join("\n")).toContain("Run completed");
  });

  it("the interactive approval prompt is written through the injected io, not the real process.stdout (finding #6)", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, GUARDRAIL_SPEC);
    const { io, out } = capture(["y"]);

    const code = await runCli(["run", specPath, "--input", "refund #1"], io, {
      model: lowConfidenceModel(),
    });

    expect(code).toBe(EXIT_SUCCESS);
    // If this were still written to the real process.stdout, capture()'s
    // `out` array -- which readline never touches directly -- wouldn't see it.
    expect(out.join("\n")).toContain("Approval required");
  });

  it("without --approve-all, an explicit stdin 'n' rejects and the run exits with an execution failure", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, GUARDRAIL_SPEC);
    const { io } = capture(["n", "not sure about this one"]);

    const code = await runCli(["run", specPath, "--input", "refund #1"], io, {
      model: lowConfidenceModel(),
    });

    expect(code).toBe(EXIT_EXECUTION_FAILURE);
  });

  // Regression coverage for KAN-1217: "kampong run --json"'s trace array
  // must show "rejected" for the step whose rejection ended the run, not
  // "failed" -- pre-fix, the top-level `status` correctly read "rejected"
  // while the trace entry for the exact same event hardcoded "failed".
  it("--json's trace array shows the rejected step's status as 'rejected', not 'failed'", async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, GUARDRAIL_SPEC);
    const { io, out } = capture(["n:not sure about this one"]);

    const code = await runCli(["run", specPath, "--input", "refund #1", "--json"], io, {
      model: lowConfidenceModel(),
    });

    expect(code).toBe(EXIT_EXECUTION_FAILURE);
    const parsed = JSON.parse(out[0]!);
    expect(parsed.status).toBe("rejected");
    const rejectedEntry = parsed.trace[parsed.trace.length - 1];
    expect(rejectedEntry).toEqual({
      step: "evaluate",
      status: "rejected",
      error: "not sure about this one",
    });
  });

  it('a combined "n:<reason>" answer rejects and carries the reason through to the report', async () => {
    const specPath = join(dir, "agent.yaml");
    writeFileSync(specPath, GUARDRAIL_SPEC);
    const { io, out } = capture(["n:not sure about this one"]);

    const code = await runCli(["run", specPath, "--input", "refund #1", "--json"], io, {
      model: lowConfidenceModel(),
    });

    expect(code).toBe(EXIT_EXECUTION_FAILURE);
    const parsed = JSON.parse(out[0]!);
    expect(parsed.success).toBe(false);
    expect(parsed.status).toBe("rejected");
    expect(parsed.error).toBe("not sure about this one");
  });

  // Regression coverage for KAN-1186: "kampong run: rejecting a guardrail/
  // approval prompt via piped stdin silently hangs and exits 0 instead of
  // reporting a rejected run (exit 2)". Root cause was `promptApproval`
  // making TWO sequential `rl.question()` calls against the same
  // `readline/promises` Interface -- fine against a real TTY, but against a
  // piped/non-TTY stdin delivered as a single chunk (what `capturePipedStdin`
  // reproduces, unlike `capture`'s one-chunk-per-line delivery -- see its
  // docstring), Node's readline eagerly drains the whole chunk on the first
  // read, stranding the second `question()` with nothing left to resolve it.
  // That hung forever and, since nothing else kept the event loop alive, the
  // process silently exited 0 without ever reaching this report. The fix
  // reads the y/N answer and an optional "n:<reason>" in a single
  // `question()`, so there's no second call to strand.
  describe("KAN-1186: piped/non-TTY stdin (single-chunk delivery) must never hang on rejection", () => {
    it("an old-style two-line 'n' + reason answer, delivered as one chunk, does not hang and reports a rejected run", async () => {
      const specPath = join(dir, "agent.yaml");
      writeFileSync(specPath, GUARDRAIL_SPEC);
      // Exactly the bug report's repro shape: `printf 'n\nsome reason\n' | ...`
      // arrives as ONE chunk containing both lines -- pre-fix, this hung.
      const { io, out } = capturePipedStdin("n\nsome reason\n");

      const code = await runCli(["run", specPath, "--input", "refund #1", "--json"], io, {
        model: lowConfidenceModel(),
      });

      expect(code).toBe(EXIT_EXECUTION_FAILURE);
      expect(out).toHaveLength(1);
      const parsed = JSON.parse(out[0]!);
      expect(parsed.success).toBe(false);
      expect(parsed.status).toBe("rejected");
    });

    it('a single-chunk "n:<reason>" answer does not hang, rejects, and carries the reason through', async () => {
      const specPath = join(dir, "agent.yaml");
      writeFileSync(specPath, GUARDRAIL_SPEC);
      const { io, out } = capturePipedStdin("n:not sure about this one\n");

      const code = await runCli(["run", specPath, "--input", "refund #1", "--json"], io, {
        model: lowConfidenceModel(),
      });

      expect(code).toBe(EXIT_EXECUTION_FAILURE);
      const parsed = JSON.parse(out[0]!);
      expect(parsed.success).toBe(false);
      expect(parsed.status).toBe("rejected");
      expect(parsed.error).toBe("not sure about this one");
    });

    it("a single-chunk 'y' answer approves and completes without hanging", async () => {
      const specPath = join(dir, "agent.yaml");
      writeFileSync(specPath, GUARDRAIL_SPEC);
      const { io, out } = capturePipedStdin("y\n");

      const code = await runCli(["run", specPath, "--input", "refund #1"], io, {
        model: lowConfidenceModel(),
      });

      expect(code).toBe(EXIT_SUCCESS);
      expect(out.join("\n")).toContain("Run completed");
    });
  });
});

describe("kampong dev -- argument validation", () => {
  it("rejects a non-numeric --port as a usage error", async () => {
    const { io, err } = capture();
    const code = await runCli(["dev", ".", "--port", "not-a-number"], io);
    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(err.join("\n")).toContain("--port");
  });
});
