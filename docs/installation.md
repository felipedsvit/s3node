# Installation

## Requirements

- **Node.js >= 22.13.0** (`node:sqlite` is available without an experimental flag)
- No runtime dependencies, no containers, no compilers

## Install from npm

```sh
npm install @felipedsvit/s3node
```

This installs the library and the `s3node` CLI command.

## Run directly with npx (no install required)

```sh
npx @felipedsvit/s3node --data-dir ./data --port 9000
```

## Verify installation

```sh
npx @felipedsvit/s3node --help
npx @felipedsvit/s3node --version
```

## Credential auto-generation

When no access key or secret key is provided, s3node generates a random credential pair on every startup. The banner prints them. To keep credentials stable:

```sh
npx @felipedsvit/s3node --data-dir ./data --access-key AKIDTEST --secret-key test-secret
```

Or via environment variables:

```sh
export S3NODE_ACCESS_KEY_ID=AKIDTEST
export S3NODE_SECRET_ACCESS_KEY=test-secret
npx @felipedsvit/s3node --data-dir ./data
```

The access key is a 20-character hex string. The secret key is a 40-character base64url string.
