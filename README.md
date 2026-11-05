# Slate

Android chat app (Java, no Gradle) plus the Node backend it talks to.

```
app/      Android source (AndroidManifest.xml, res/, src/) and build.sh
server/   Slate backend — accounts, messages, presence, groups, moderation (Render-ready)
.github/  CI: builds the APK on every push to main
render.yaml  one-click Render Blueprint for the server
```

## What works end to end

- **Accounts** — usernames + passwords are created on the server, so an account
  works on any device. Sign in from the auth screen.
- **Messaging** — direct and group messages are delivered through the server,
  including photos and voice notes (uploaded, then streamed to recipients).
- **Online elements** — presence/online dots, last seen, typing indicators,
  delivered ticks and read receipts all come from `/api/sync`.
- **Bans & moderation** — reports go to the server inbox; moderators ban/unban
  from the Moderation screen. Bans are enforced server-side (sign-in and sending
  are blocked; the app shows the banned screen).
- **Groups** — create from Contacts, members and group info sync across devices.
  Roles/permissions stay a local moderation tool for now.

Set the backend URL in **Settings → Server**. Default is
`https://slate-server.onrender.com`.

## Build the APK locally
```
cd app && ./build.sh            # writes app/Slate.apk
```
Needs a JDK 17+, the Android SDK build-tools (`aapt`, `dx`, `zipalign`,
`apksigner`) and a platform `android.jar`. Override the defaults with
`ANDROID_JAR`, `ANDROID_BUILD_TOOLS`, `SLATE_KS`.

## CI
`.github/workflows/android.yml` builds on push and uploads `Slate.apk` as an
artifact. `render.yaml` deploys `server/` to Render.
To keep updates installable over previous builds, sign every build with the same key:
add repository secrets `SLATE_KEYSTORE_B64` (base64 of your .keystore), `SLATE_KS_PASS`, `SLATE_KS_ALIAS`.
Without them CI signs with a throwaway key, so each CI APK must be installed fresh.

## Deploy the server
See [server/README.md](server/README.md). Short version: push to GitHub, then
Render → New → Blueprint → apply `render.yaml`.
