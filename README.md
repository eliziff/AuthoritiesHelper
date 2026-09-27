# AuthoritiesHelper

AuthoritiesHelper provides the standalone deployment, launcher and packaging
for Beaver's shared TypeScript Authorities application. The citation, review,
source-preparation and document-output operations are shared with Beaver.

See [the standalone guide](modern/README.md). From a Beaver checkout with this
repository at `AuthoritiesHelper/`:

```powershell
npm run dev:authorities
npm run test:authorities-package
npm run package:authorities
```

The Python application, its web host and its copied grammar have been retired.
Their source and regression tests remain available at
[`eb5b026`](https://github.com/eliziff/AuthoritiesHelper/tree/eb5b0266a7d6b69ad865eee2feda88a228adda18).
The current product's capability and validation contract is
[Authorities production parity](https://github.com/eliziff/Beaver/blob/main/docs/decisions/authorities-parity.md).

[MIT](LICENSE). Third-party components, parser/model assets and legal data retain
their own licenses and notices.
