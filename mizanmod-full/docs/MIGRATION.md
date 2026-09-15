# Staged migration, not an in-place rename

## Preserve the working installation

The deployed minimal studio and this full platform have different APIs, session models, database schemas and filesystem layouts. Renaming the old service's folder or copying this over it will break configuration and may lose data. Keep its running port 3000 service until the new platform is accepted.

1. Back up `/opt/mizanmods/.env`, the new Mizan signing key and runtime using an encrypted off-server backup. Never put these into the source ZIP or webroot.
2. Extract only the full-platform archive into a **new** directory, e.g. `/opt/mizanmod-full`. Do not copy the parent reference checkout or its Git history.
3. Use a new Linux service account/data ownership boundary where practical. Grant read access to the existing Mizan key through a narrowly scoped permission/ACL or an explicitly verified private copy; preserve key bytes and passwords. Do not grant access to another client's keys.
4. Install dependencies and run the supplied tests as the non-root staging user.
5. Create a fresh `.env` based on this project's example. The minimal studio's `ADMIN_TOKEN` is not an admin password and is not compatible with the new bcrypt admin login. Create new session/content/admin secrets. Keep the Mizan signing credentials unchanged.
6. Create a new client-owned Firebase project/database/service account. Set only the new project's values. Deploy deny-by-default rules and verify server-account access, including read/write/cleanup of a dedicated healthcheck node. Do not import another client's database dump.
7. Start on loopback port 3100 with polling disabled. Authenticate the admin, upload one newly owned design and media, check settings and order flows. Do not expose the staging port publicly.
8. Verify Telegram signatures with real initData, approved/denied accounts, stale data, desktop/mobile WebViews and session cookies. There must be exactly one bot poller.
9. Build the **full Android template** with the preserved Mizan key, verify the certificate and package, install it, test its own design/runtime controls and then rebuild/update-install it. Test all required assets and network-failure behavior. The minimal 17 KB APK is not this template.
10. Test credits, coupons, announcements, file ownership, queue failure/refund handling and downloads on staging. Existing audit tests do not cover all inherited routes.
11. Configure a separate systemd unit and explicit write paths for this platform. Keep TLS and existing Nginx backups. Cut over admin/client proxy routes only after approval; runtime `/api/app-content` and `/api/rtdb` paths must remain reachable from the new Android apps without granting admin access.
12. If verification fails, restore Nginx to the old port; keep the old service/data intact. Delete old test builds only after a separate cleanup confirmation. Retain source/tests as release checks rather than deleting test code.

## Known release gates

Browser visual regression, live Telegram API methods, Firebase cloud connection/rules behavior, the full-template Android compile/sign/install cycle, data migrations and concurrency/restart behavior are not certified. No live server settings were changed by creation of this source archive.
