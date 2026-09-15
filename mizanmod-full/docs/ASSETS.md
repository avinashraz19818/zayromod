# Included media pack

Both template and Android asset directories are included: 37 original PNG/font/audio files plus one rebranded MizanMod default icon, recorded in `assets-manifest.json`. Launcher resources also retain MizanMod branding. Original audio is unchanged, not transcribed; listen/review media before client release.

All 69 HTML template files are now included with new text branding, superseding the earlier HTML-exclusion scope. Existing image data embedded in templates remain, except remotely hosted default logos are replaced by the MizanMod icon. Old Firebase account fields are blank; old default registration destinations are placeholders. Public font, image and result-feed dependencies are retained where applicable.

Never copy the existing encrypted loading blob: new builds regenerate encrypted HTML using the new content secret. Database schema and Firebase integration code remain, but populated databases, account credentials, keystores and build artifacts are not bundled.
