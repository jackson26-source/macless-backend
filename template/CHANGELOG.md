# Changelog

What's changed in the template since you bought it. There's no
automated update notification yet (see the note at the bottom) — the
most reliable way to check is comparing this file's dates against when
you last downloaded, and re-grabbing `macless-template-v1.zip` from the
same link in your original purchase confirmation if anything below looks
relevant to you.

## 2026-08-19 (1)

- **New: automated certificate/keystore expiry monitoring** —
  `.github/workflows/check-expiry.yml`, a weekly scheduled workflow (also
  runnable on demand) that checks whichever of your iOS profile/cert and
  Android keystore secrets are set, and pings your existing
  `NOTIFY_WEBHOOK_URL` webhook only when something's actually expiring or
  expired — silent the rest of the time. A full report always lands in
  that run's Summary tab regardless. Does nothing for a platform you
  haven't set secrets for (e.g. Android-only buyers see the iOS half
  silently skipped).
- **Signing Doctor now checks Android keystores, not just iOS.** New
  `--android-keystore`/`--android-keystore-password`/`--android-key-alias`/
  `--android-key-password` flags check whether a keystore opens with the
  given password/alias, whether the signing key inside has expired or is
  expiring soon, and flag an older SHA1-based signature algorithm. These
  checks only need `keytool` (any JDK) — no macOS requirement, unlike the
  iOS checks. Vendored into this product as `scripts/signing-doctor.sh`
  (used by `check-expiry.yml` above) and also updated in the free
  standalone [macless-signing-doctor](https://github.com/jackson26-source/macless-signing-doctor)
  repo. Also now writes a formatted report to the GitHub Actions Summary
  tab when run as a workflow step, not just the raw log.
- **The setup wizard (`scripts/generate_signing_secrets.sh`) now covers
  Android too, and can push secrets straight to GitHub for you.** It
  asks up front whether you're setting up iOS, Android, or both, walks
  through Android keystore generation (or lets you point it at an
  existing keystore) the same way it already did for iOS certs/profiles,
  and — if you have the [GitHub CLI](https://cli.github.com) (`gh`)
  installed and logged in — offers to push every secret and variable it
  just generated directly into your repo's Settings, instead of you
  copy-pasting each one into the GitHub web UI by hand. Falls back
  cleanly to the old copy-paste summary if `gh` isn't available. Ends by
  offering to run Signing Doctor against exactly what it just generated,
  so you find out immediately if something's off.

## 2026-08-18 (6)

- **Legibility pass on the docs.** README.md and SIGNING.md now define
  their core jargon in plain language the first time it's used (GitHub
  Actions, Xcode, App Store Connect, TestFlight, certificate, provisioning
  profile, bundle ID, Team ID) instead of assuming you already know it.
  ANDROID.md got a matching "quick definitions" block for keystore,
  service account, and package name. No instructions changed — same
  steps, same order, just easier to follow the first time through if
  you're newer to this. TROUBLESHOOTING.md, TESTING.md, ADVANCED.md, and
  STORE_METADATA.md were left as-is since they're already written for
  someone actively debugging or editing a workflow file, where precise
  technical terms matter more than a plain-language gloss.

## 2026-08-18 (5)

- **New: store metadata automation** — `STORE_METADATA.md` +
  `.github/workflows/appstore-metadata.yml` +
  `.github/workflows/playstore-metadata.yml` + a `fastlane/` folder
  (Fastfile, Appfile, Gemfile). Pushes your listing text and screenshots
  to App Store Connect / Play Console via fastlane's `deliver`/`supply`,
  reusing the exact same credentials you already set up for TestFlight/
  Play Store uploads — never touches your build, never submits for
  review, never changes a release track. Optional; skip it if you're
  happy updating listings by hand. Reviewed against fastlane's current
  docs, not yet live-tested against a real store listing — see
  STORE_METADATA.md's Status section.

## 2026-08-18 (4)

- **React Native and Flutter workflow variants are now live-tested and
  proven**, not just audited. React Native's live-test found and fixed two
  real bugs along the way (a `package.json` pin for `@react-native/jest-preset`
  that doesn't exist before RN 0.85, and a trimmed test scaffold missing
  `app.json`, which Metro's bundler needs at archive time) before a clean
  run succeeded end to end. Flutter's live-test succeeded on its first
  run. See README.md's new "Last verified working" table for the current
  proven/audited status of every workflow file in this template.
- **New: [Macless Signing Doctor](https://github.com/jackson26-source/macless-signing-doctor)**,
  a free standalone script (and optional GitHub Action) that generalizes
  this template's own "Validate signing setup" step so you can run it
  against any provisioning profile/certificate pair, in or out of this
  pipeline — linked from SIGNING.md and README.md.
- **New: a "Last verified working" table in README.md** — every workflow
  file's most recent live-test date and proven/audited status, updated
  each time a real run (not just a review) confirms one still works.

## 2026-08-18 (3)

- **New: bare React Native and Flutter workflow variants**, alongside the
  existing Capacitor one — `.github/workflows/ios-testflight-react-native.yml`
  and `.github/workflows/ios-testflight-flutter.yml`. Same signing setup,
  same secrets/variables from SIGNING.md; only the build steps before
  signing differ. See README.md's "Which workflow file do I use?" table.
  Statically reviewed against each framework's current CI documentation
  and community-reported gotchas (see TROUBLESHOOTING.md for both) — not
  yet live-tested end-to-end the way the Capacitor workflow has been;
  treat as "audited," not yet "proven," until a real run confirms it.

## 2026-08-18 (2)

- **Security hardening pass**, prompted by an outside review: added a
  `.gitignore` covering signing material (`*.p12`, `*.key`, `*.cer`,
  `*.pem`, `*.mobileprovision`, `*.keystore`, `*.jks`, `*_base64.txt`) so
  a copy-pasted `openssl`/`keytool` command run inside your project folder
  can't accidentally get committed. Added an explicit `permissions:
  contents: read` block to all four workflows — none of them need to
  write back to the repo, so `GITHUB_TOKEN` no longer inherits a broader
  default than it needs. SIGNING.md and ANDROID.md both now say plainly
  to generate key material from a scratch folder outside your repo.
  Audited the full commit history of both this template's source and
  Citolex's own repo for any previously-committed cert/key/keystore
  file — none found, both were already clean; secrets were always passed
  as GitHub Actions secrets via `env:` (not interpolated into shell
  commands), never `set -x`'d into logs, and never triggered by
  fork pull requests.

## 2026-08-18

- **Fixed `android-build.yml`** — live-tested end-to-end on a disposable
  throwaway repo, which caught and fixed three real bugs anyone following
  ANDROID.md would have hit: (1) `npx cap add android` failed with
  "Could not find the android platform" because `@capacitor/android`
  wasn't an installed dependency (Capacitor 5+ ships each platform as
  its own npm package); (2) installing it at the wrong version threw an
  `ERESOLVE` peer-dependency error, so the workflow now detects your
  installed `@capacitor/core` major version and installs the matching
  `@capacitor/android` major automatically; (3) the build failed at
  `compileReleaseJavaWithJavac` with "invalid source release: 21" — JDK
  was set to 17, but Capacitor 7's Android Gradle template needs JDK 21.
  The build + signing steps are now confirmed working end-to-end; only
  the final Google Play upload step remains untested against a real Play
  Console account (needs credentials this template can't generate on its
  own). See the Status section in ANDROID.md.

## 2026-08-17

- Added `.github/workflows/screenshots.yml` — generates the two
  screenshot sizes Apple actually requires at submission time (6.9"
  iPhone, 13" iPad), by running the Simulator at those exact device
  classes.
- **Fixed a real bug** in `simulator-preview.yml` and `screenshots.yml`:
  the `.app` product lookup used the wrong search depth and could report
  "No .app product found" even after a fully successful build. Both
  workflows are now live-tested end to end, not just reviewed — see
  TESTING.md for how.
- Added `ANDROID.md` + `.github/workflows/android-build.yml` — a signed
  Android App Bundle build and Google Play upload, structured the same
  way as the iOS pipeline. (Reviewed carefully, not yet live-tested —
  see the Status section in ANDROID.md.)
- Added optional build caching (`actions/cache`) to all the workflows —
  faster repeat runs, no behavior change if a cache key ever misses.
- Added an optional webhook notification step to `ios-testflight.yml` —
  posts build success/failure to a Discord- or Slack-compatible webhook
  if you set a `NOTIFY_WEBHOOK_URL` secret; does nothing if you don't.
- Added `scripts/generate_signing_secrets.sh` — an interactive script
  that walks through SIGNING.md's certificate/profile generation and
  writes the base64 values straight to files, instead of copy-pasting
  each `openssl` command by hand.
- Added `TESTING.md` — how to live-test a workflow change in a
  throwaway repo before trusting it, using the exact process that caught
  the bug above.
- Added `SUPPORT.md` — where to ask if you get stuck, including a new
  GitHub Discussions space.

## 2026-08-16

- **Fixed a critical packaging bug:** the product zip was missing
  `.github/workflows/ios-testflight.yml` — the actual pipeline — even
  though SETUP.md told you to copy it in. If you bought before this date
  and hit a dead end at that step, re-download the zip from your
  original purchase confirmation link; it's fixed now.
- Added `.github/workflows/simulator-preview.yml` — build and
  screenshot your app in the iOS Simulator, no signing setup or Apple
  hardware required.
- Added a "Validate signing setup" step to `ios-testflight.yml` — checks
  your provisioning profile's Team ID and bundle ID against your GitHub
  secrets/variables before the archive step, so a mismatch fails with a
  specific reason instead of a generic Xcode error buried in the log.
- Fixed an `ADVANCED.md` doc bug (referenced placeholder names that
  didn't match the actual script's constants).

## Earlier

- Initial release: `ios-testflight.yml`, `SIGNING.md`, `SETUP.md`,
  `APP_STORE_SUBMISSION.md`, `TROUBLESHOOTING.md`, `advanced/` (Share
  Extension / native plugin support).

---

**On update notifications:** there's no mailing list today — Stripe's
post-payment page hands you a direct download link with no follow-up
email. Stripe does record every buyer's email on the payment itself, so
a manual one-off "here's what's new" email to past buyers (exported from
the Stripe dashboard's customer list) is possible any time it's worth
doing — that's a decision/action for Jackson to make from Stripe
directly, not something this file automates.
