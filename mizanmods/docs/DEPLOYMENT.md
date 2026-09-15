# Deployment / operations

## Single dedicated build host

Use a separate Linux account/container, dedicated data volume, dedicated SDK/cache and a newly created signing key. Do not mount another application's data, storage or secrets. Run one MizanMods process per data directory. An exclusive `server.lock` prevents two processes from owning the same queue. If the host crashes, verify the previous process is dead before removing a stale lock. Do not delete a live process's lock.

1. Install Node 22.13+, JDK 17, Android SDK 35/build-tools 35.0.0, accept Android licenses as the client owner.
2. Extract source-only handoff. Run `npm ci --omit=dev`.
3. Create private `.env` / inject environment secrets with permissions `0600`; set a dedicated absolute `DATA_DIR`, SDK path and new signing key.
4. Run `npm run doctor` and resolve every missing check.
5. Run `npm start` under a supervisor; retain a persistent data volume and separately back up the key.
6. Terminate TLS with a new client-owned reverse proxy. Forward the same origin to the Node port; no cross-origin browser API configuration is needed.
7. Keep the backend port private at the firewall. The app binds all interfaces for container/preview compatibility.
8. Run release and device tests before allowing production builds.

The app does not trust forwarded IP headers by default, preventing client-controlled spoofing. Consequently, when behind a reverse proxy the in-process limiter can apply collectively to the proxy IP; use an edge rate limiter and review a narrowly scoped proxy trust policy for your topology. Never blindly set `trust proxy=true` on an internet-accessible Node port.

The static studio may be embedded for development preview. On a production-only deployment add a restrictive `frame-ancestors` CSP at the reverse proxy. Set HSTS at your HTTPS edge. Never deploy the admin bearer token over public HTTP.

## Runtime retention and backups

- `runtime/mizanmods.sqlite`: metadata; WAL/SHM files may exist.
- `runtime/artifacts/<uuid>/MizanMods.apk`: verified release files.
- `runtime/work/<uuid>/`: disposable compiler workspace, removed after build.
- `runtime/gradle/`: installation-specific Gradle cache, not another client's cache.
- Artifact cleanup runs hourly/on startup after the configured age. Metadata is retained; only the most recent 100 builds are listed in the studio. Plan metadata archival/disk monitoring for long-lived hosts.

Use SQLite's online backup API or stop the service before snapshotting all database files. Never copy only a live main DB while ignoring WAL. Back up release signing credentials using the client's approved secret-storage policy; never export them in the source archive. Monitor free disk, Gradle errors, memory and process restarts. Restore to an isolated test host and check data ownership before cutover.

## Release gates still required

No production claim is warranted until a real SDK build, signature check and Android install/launch test pass. Verify API 23/35 WebView, popup dismissal, rotation, accessibility and offline startup. Rebuild a second time and verify update installation with the same signing key and incremented version code.

The current design is a single-operator tool, not a multi-user public service. Public SaaS would additionally require per-user authentication/authorization, audit controls, job ownership, resource quotas, stronger build sandboxing and secret isolation between tenants.
