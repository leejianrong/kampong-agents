# Ejecting to TypeScript

When an agent is ready, you can eject it to a standalone TypeScript project that has **zero
dependency on Kampong Agents**. It's built on [Mastra](https://mastra.ai) and its own declared
packages, nothing else. Export is how you graduate from the builder to owning the code.

```sh
kampong export agent.yaml ./my-agent
```

The command validates the spec, generates the project, and tells you how to run it:

```
Exported "hello_agent" to /path/to/my-agent (N files).
  cd ./my-agent && npm install && npm start
```

## Run the exported project

It's an ordinary Node project. In a clean directory, with no reference to this tool:

```sh
cd my-agent
npm install
npm start
```

It produces output behaviorally identical to running the same spec on the canvas or through
`kampong run`. The generated `README.md` explains the project's own options.

## Export is one-way

This is the rule to internalize: export goes spec to code, and never back.

```mermaid
flowchart LR
  spec["agent.yaml"] -->|kampong export| code["standalone TS project"]
  code -.->|"not supported"| spec
```

The canvas and CLI only ever read and write the YAML spec. They never read your generated
TypeScript. If you hand-edit the exported project, those edits live in the project. They don't
sync back to the spec, and re-exporting won't pick them up.

!!! warning "Re-exporting refuses to clobber by default"
    `kampong export` refuses to write into a directory that already exists and isn't empty, so a
    re-export can't silently overwrite edits you've made. Pass `--force` to overwrite on purpose.

## When to export

Export when you want to leave the builder behind: to drop the agent into a larger codebase, run it
in your own infrastructure, or customize it beyond what the spec expresses. Keep iterating on the
spec while it's still changing shape, and export once it's settled.

That's the full loop: design, run, guard, offline-test, and ship.

## Recap

- `kampong export <spec> <dir>` generates a standalone TypeScript project on Mastra with zero
  dependency on Kampong Agents.
- The exported project runs with `npm install && npm start` and behaves identically to the spec
  on the canvas or through `kampong run`.
- Export is one-way: the canvas and CLI never read generated code, and hand-edits to it do not
  sync back.
- Re-export refuses to overwrite a non-empty directory unless you pass `--force`.

That is the end of the tutorial ladder. From here, [Concepts](../concepts.md) explains the design
ideas behind the duality and one-way export, and the [Reference](../reference/cli.md) documents
every CLI flag and `AgentSpec` field.
