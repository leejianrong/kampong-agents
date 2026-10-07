# ADR-0027 spike: JSONata (KAN-1839)

Throwaway scripts that produced the numbers in ADR-0027's "Spike result". They are not part of the build
and not linted for style beyond what the repo checks. To run them, in an empty directory:

```
npm init -y && npm i jsonata@2.2.2
cp <repo>/docs/adr/0027-spike/*.mjs .
node a-determinism.mjs   # what is non-deterministic, and the guards that remove it
node b-bounds.mjs        # time and memory bombs, unguarded vs guarded (uses case.mjs; takes ~1 minute)
node c-builtin.mjs       # JSONata's own timeout/stack options
node d-misc.mjs          # stack depth, parser depth, RegexEngine hook, worker termination
node e-stack.mjs         # tail calls vs non-tail recursion
node f-subset.mjs        # the form subset and its AST round trip
node g-errors.mjs        # error codes and positions
node i-child.mjs         # a child process contains a memory bomb
```

`h-worker-mem.mjs` demonstrates a negative result: a worker with `resourceLimits` does not contain a memory
bomb, the whole process aborts. **Running it crashes node**; that is the point.
