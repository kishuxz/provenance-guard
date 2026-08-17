# @provguard/harness

Deterministic, offline pollution-chain reproductions for provenance guard testing.

Each scenario is fixed data:

```ts
{
  id: string;
  name: string;
  mechanism: string;
  description: string;
  chunks: Chunk[];
  simulatedOutput: string;
  expectation: "should_block" | "should_allow";
}
```

The package exports `SCENARIOS`, `listScenarios()`, `getScenario(id)`, and
`runScenario(scenario, guards)`. The `guards` interface is implemented by the
CLI, keeping this package independent from `@provguard/inbound` and
`@provguard/outbound`.

```js
import { runScenario, SCENARIOS } from "@provguard/harness";

const result = await runScenario(SCENARIOS[0], {
  checkChunks(chunks, context) {
    return inboundGuard.check(chunks, context);
  },
  checkOutput(output, context) {
    return outboundGuard.check(output, context);
  }
});
```

No scenario performs network calls, live model calls, filesystem reads, or time
lookups. Runs are byte-identical for the fixed chunks and simulated output.
