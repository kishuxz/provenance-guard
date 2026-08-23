# @provguard/middleware

Framework-neutral monitor and enforce guard for Provenance Guard. No HTTP, no web framework.

Part of [Provenance Guard](https://github.com/kishuxz/provenance-guard). Read the
[root README](https://github.com/kishuxz/provenance-guard#readme) first, and
[docs/LIMITATIONS.md](https://github.com/kishuxz/provenance-guard/blob/main/docs/LIMITATIONS.md)
before citing any number this project produces.

## Install

```bash
npm install @provguard/middleware
```

Requires Node >=20.

## Usage

```ts
import { createGuard } from "@provguard/middleware";

const guard = createGuard({ mode: "monitor" });
```

## Licence

[Apache-2.0](./LICENSE).
