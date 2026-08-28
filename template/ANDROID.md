# Android / Google Play setup (optional)

This is the Android equivalent of SIGNING.md — one-time setup so
`.github/workflows/android-build.yml` can build a signed `.aab` and
upload it to Google Play automatically. Skip this file entirely if
you're only shipping to the App Store.

Runs on a standard Ubuntu GitHub Actions runner (not macOS) — faster and
well within GitHub's free minutes even on a private repo, since Android
builds don't need the 10x macOS-runner multiplier iOS builds do.

**Run the `keytool` command below from a scratch folder outside your
project repo** — e.g. your Desktop — not from inside it. It generates a
real signing keystore, and a `.gitignore` covering keystore/key files
ships with this template as a backstop, but the safest habit is to never
let them exist inside a git working directory in the first place.

**Quick definitions, so the steps below make sense the first time through:**
a **keystore** is a file holding your app's Android signing key — the
Android equivalent of the certificate/provisioning-profile pair from
SIGNING.md; a **service account** is a machine-only Google account this
workflow uses to upload builds to Play Console on your behalf, instead of
you clicking through it by hand; your **package name** is your app's
unique name, like a domain name (e.g. `com.yourname.yourapp`) — Android's
equivalent of iOS's bundle ID. You'll create one of each below — exactly
once, ever, per app.

## 1. Create a signing keystore

**Prefer not to run these by hand?** `scripts/generate_signing_secrets.sh`
(SIGNING.md's setup wizard) covers this whole step interactively — pick
"Android only" or "Both" when it asks — including the base64-encoding
below and, if you have the GitHub CLI installed, pushing the resulting
secrets straight into your repo. The manual steps below still apply if
you'd rather do it by hand.

```
keytool -genkey -v -keystore release.keystore -alias upload -keyalg RSA -keysize 2048 -validity 10000
```

Keep `release.keystore` somewhere safe — if you lose it, you lose the
ability to publish updates to your app under the same Play Store listing.
`keytool` ships with any JDK. If you don't have one installed locally,
this can also be generated once on a GitHub-hosted runner and downloaded
as a build artifact instead — ask if you'd rather do it that way.

Base64-encode it the same way SIGNING.md does for iOS certificates:

```
openssl base64 -in release.keystore -out release_keystore_base64.txt -A
```

**Want a second opinion before you find out from a failed build?**
[Signing Doctor](https://github.com/jackson26-source/macless-signing-doctor)
(the same free tool SIGNING.md points to for iOS) now checks Android
keystores too — whether it opens with your password/alias, and whether
the signing key inside is expiring. Run it with
`--android-keystore release.keystore --android-keystore-password "..."`,
or let `.github/workflows/check-expiry.yml` run it for you automatically
every week.

## 2. Register the app in Google Play Console

Go to [Google Play Console](https://play.google.com/console) → Create app
→ fill in the basics → pick your package name (e.g.
`com.yourname.yourapp`, matching what's in `capacitor.config.json`).
Google Play requires at least one manual release through the console for
a brand-new app before it accepts API uploads — do that first release by
hand, then this workflow takes over for every one after.

## 3. Create a Play Console service account

1. Play Console → **Setup → API access** → link (or create) a Google
   Cloud project if you don't already have one → **Create new service
   account**
2. Follow the link into Google Cloud Console, create the service
   account, generate a JSON key, download it
3. Back in Play Console, grant that service account **Release manager**
   permission (or a custom role with release + app-info access) for your
   specific app

## 4. Add secrets and variables to your GitHub repo

**Settings → Secrets and variables → Actions.**

Repository secrets:

| Secret name | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | base64 of `release.keystore` |
| `ANDROID_KEYSTORE_PASSWORD` | the password you set with `keytool` |
| `ANDROID_KEY_ALIAS` | the `-alias` value you used (e.g. `upload`) |
| `ANDROID_KEY_PASSWORD` | usually the same as the keystore password unless you set a separate one |
| `ANDROID_PLAY_SERVICE_ACCOUNT_JSON` | the full contents of the service account JSON file from step 3 |

Repository variables:

| Variable name | Value |
|---|---|
| `ANDROID_PACKAGE_NAME` | your package name, e.g. `com.yourname.yourapp` |
| `ANDROID_PLAY_TRACK` | `internal`, `alpha`, `beta`, or `production` — defaults to `internal` if you leave this unset, which is where you should start anyway |

## How this differs structurally from the iOS pipeline

The iOS workflow signs by passing flags straight to `xcodebuild`. This
one works the same way in spirit but at a different layer: the build
produces an **unsigned** `.aab` via `./gradlew bundleRelease`, then a
separate step signs that file directly with `jarsigner`. Nothing about
signing is ever written into the Capacitor-generated `android/` project
itself — same reasoning as the iOS side, since `npx cap add android`
regenerates that project from scratch on every run.

## Status

This workflow has been live-tested end-to-end on a disposable throwaway
repo, using a self-signed test keystore (no real Play Console account
involved). That test caught and fixed one real bug: `npx cap add
android` fails with "Could not find the android platform" unless
`@capacitor/android` is already installed — most projects only have
`@capacitor/ios` if they set up iOS first per SIGNING.md, since
Capacitor 5+ ships each platform as its own npm package rather than
bundling it into `@capacitor/cli`. Installing the wrong version also
fails (a peer-dependency mismatch against whatever `@capacitor/core`
major version your project is already on), so the workflow now detects
your installed core version and installs the matching
`@capacitor/android` major automatically — nothing you need to do.

That same test also caught a JDK mismatch: Capacitor 7's Android
template compiles against Java 21, so the workflow sets up JDK 21 (not
17) — otherwise `gradlew bundleRelease` fails partway through with
"invalid source release: 21".

The `npx cap add`/sync and Gradle build steps are now confirmed working
end-to-end on the throwaway test repo. The `jarsigner` signing step and
the final **Upload to Google Play** step still haven't been exercised
against a real Play Console app/service account, since that needs
credentials this template can't generate on its own. If either step
doesn't line up with Play Console's current flow, email
localinfine@gmail.com and it'll get fixed for everyone.

## Still stuck

Email localinfine@gmail.com — same as the iOS side. See also SUPPORT.md.
