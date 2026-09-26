# Modern standalone Authorities

This directory owns the local loopback deployment, launcher, packaging, and
standalone browser checks for Beaver's shared TypeScript Authorities core. The
Python application remains available at the repository root.

When this repository is checked out as Beaver's `AuthoritiesHelper` submodule,
run from the Beaver root:

```powershell
npm run dev:authorities
npm run test:authorities-package
npm run package:authorities
```

The package command writes `modern/out/Authorities-win-x64.zip`. Generated
packages and runtimes are never committed.
