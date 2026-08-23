# @provguard/inbound

Inbound guard for Provenance Guard: classifies chunks by channel and credibility tier before context assembly.

Part of [Provenance Guard](https://github.com/kishuxz/provenance-guard). Read the
[root README](https://github.com/kishuxz/provenance-guard#readme) first, and
[docs/LIMITATIONS.md](https://github.com/kishuxz/provenance-guard/blob/main/docs/LIMITATIONS.md)
before citing any number this project produces.

## Install

```bash
npm install @provguard/inbound
```

Requires Node >=20.

## Usage

```ts
import { classifyChunk, checkSlot, DEFAULT_POLICY } from "@provguard/inbound";
```

## Licence

[Apache-2.0](./LICENSE).
