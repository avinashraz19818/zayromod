# Classic bot and custom emoji

This bot-only update restores the boxed MizanMod welcome and familiar builder/orders/coins buttons. The display name, description and menu configuration change from Studio to MizanMod Builder. It reuses the original public custom emoji IDs via Telegram HTML `<tg-emoji>` entities; ordinary emoji remain inside each entity as fallback. It does not restore designs, change panels, import old account data, or modify env/signing/access policy.

Telegram decides whether a bot may send custom emoji. The official Bot API documents eligibility for bots with qualifying Fragment usernames, or direct private/group/supergroup messages when the bot owner has Telegram Premium. Source: https://core.telegram.org/bots/api (Formatting options). These IDs are not credentials and do not grant eligibility. Client support also affects rendering. Premium rendering has not been verified against this user's bot.

Explicit custom-emoji rejection (HTTP 400 with a custom-emoji-specific API description) triggers one retry with plain emoji. Network timeouts are not retried by this fallback, preventing duplicate messages from ambiguous delivery. Other Telegram errors remain failures. Optionally set TELEGRAM_CUSTOM_EMOJI_ENABLED=false to use only plain emoji without changing layouts.

Use the dedicated MizanMod-Bot-Classic-Premium.zip update and its apply-bot.py on the existing VPS. It verifies the three-file manifest, refuses pending builds, backs up bot code privately, restarts only mizanmod-full and checks local health. On failure it restores the previous bot code. Then run scripts/configure-bot.js as mizanmods to update the Telegram profile/menu. Old chat messages do not automatically change; send a new /start.

Executed locally: syntax checks and five isolated/mock tests for welcome escaping/custom tags, polling subscriptions, custom-emoji fallback, timeout non-retry and successful markup preservation. Live premium rendering/profile changes and actual updater systemd execution remain pending. No database/content deletion or full source-fixture test run is required on the live VPS.
