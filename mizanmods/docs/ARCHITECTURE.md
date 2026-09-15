# Architecture and reference inspection

## What was inspected

The reference checkout contains a monolithic Node/Express server, SQLite database module and backup databases, frontend/admin pages, uploaded HTML/assets, scripts, a Java Android template, Gradle wrapper and a prebuilt APK. Its package manifest, API route inventory, queue/worker implementation, compiler and signing functions, encryption/HTML processing modules, Android build files and source integration points were inspected. Unrelated utilities include remote content synchronization, Telegram/payment administration and an alternative engine without a complete corresponding template in the checkout.

The selected active path is the **Java/Gradle pipeline**: build request validates an order; the serialized queue forks a worker; that worker copies a template, injects app/HTML/assets, runs Gradle and aligns/signs the output before updating order/download metadata. The old compiler was coupled to client database settings, runtime content endpoints, encrypted loading assets, brand-specific Java constants, remote Firebase links and unrelated overlay logic. Copying its module wholesale would carry those dependencies into a new client.

## Deliberately adapted core

- Standard Gradle 8.13 wrapper, Android plugin 8.12.0 and Java application build approach.
- Per-build isolated workspace and explicit app/package/version generation.
- Trusted HTML/CSS/JS/vector asset injection, with escaping for user-facing text.
- Serialized child-process compilation to protect API responsiveness.
- Release Gradle output → zipalign → apksigner → independent verification.
- Status/history, authenticated download, bounded logs and automatic work-directory removal.

No client-specific Java source, HTML, encrypted blobs, asset packs, database snapshots, old environment files or app binary were copied. The Android activity is newly written, local-only and has no JavaScript/native bridge. A reserved `.invalid` synthetic origin serves local assets through `shouldInterceptRequest`; it is not a live domain or backend. The app has no network permission.

## Clean boundaries

`public` talks only to relative `/api` endpoints. `src/server.js` owns authentication and input boundaries. `Store` owns one new SQLite database. `Queue` owns one active process group and a durable FIFO. `builder.js` owns template generation and trusted external command execution using argument arrays, never shell interpolation. Only ready, verified outputs can be downloaded.

All metadata is single-operator scope. This is not a multi-tenant SaaS authentication design. There is no data sync or sharing with any other installation. The only cross-directory runtime reads are explicitly configured SDK and keystore paths.

## Changes from the reference behavior

- Signing is mandatory; no unsigned-success or weaker variant fallback.
- Exact release output path avoids accidentally selecting stale/debug artifacts.
- Package identifiers and versions are explicit and validated, not randomly derived.
- Java namespace remains `com.mizanmods.shell`; application ID is independently configurable.
- No encryption is presented as secret protection. Offline assets are inspectable.
- Restart recovery preserves queued builds; an interrupted compiler fails clearly.
- Worker timeout kills Gradle descendants, not just the direct Node child.
- No dependency on remote app content or client authentication/payment systems.

These are build-core adaptations, not a claim that the new Android runtime reproduces the reference client's non-build features.
