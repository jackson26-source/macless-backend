# Store metadata automation (optional)

Push your App Store / Play Store listing text and screenshots from files
in your repo instead of clicking through App Store Connect or Play
Console by hand every time you update your description or swap a
screenshot. This is entirely separate from your build/sign/upload
pipeline (`ios-testflight*.yml`, `android-build.yml`) — those are
untouched, and this doesn't submit anything for review or touch any
release track.

Skip this whole feature if you're happy updating your store listings
manually — it's optional, and there's no cost to ignoring it.

## What you need

Both platforms use [fastlane](https://fastlane.tools) under the hood, run
as a GitHub Actions workflow (fastlane itself, and the credentials it
needs, live only in CI — you don't need Ruby or fastlane installed
locally unless you want to test from your own machine).

1. Copy `fastlane/Fastfile`, `fastlane/Appfile`, and `fastlane/Gemfile`
   from this template into your repo's `fastlane/` folder.
2. Copy whichever of `.github/workflows/appstore-metadata.yml` /
   `.github/workflows/playstore-metadata.yml` matches what you're
   shipping to into your own `.github/workflows/`.
3. Create your real metadata content (next section) — **nothing runs
   successfully until this exists**; both workflows fail fast with a
   clear message if the folder is missing, rather than doing nothing
   silently.
4. Push, then run the workflow by hand from the Actions tab
   (`workflow_dispatch` — these don't run on every push, since a listing
   update is something you do occasionally, not every commit).

## iOS: fastlane/metadata/ and fastlane/screenshots/

```
fastlane/metadata/en-US/
  name.txt
  subtitle.txt
  description.txt
  keywords.txt
  release_notes.txt
  privacy_url.txt
  support_url.txt
  marketing_url.txt

fastlane/screenshots/en-US/
  iPhone 6.9 Display/
    01_home.png
    02_feature.png
  iPad 13 Display/
    01_home.png
```

Use the folder/device names fastlane expects for the screenshot sizes
Apple currently requires — the same two sizes `screenshots.yml`'s
Simulator workflow already produces for you (see
APP_STORE_SUBMISSION.md), so you can feed that workflow's own output
straight into this one. One `.txt` file per field, plain text, no
quotes/formatting needed. Uses the same `APPSTORE_API_KEY_ID` /
`APPSTORE_API_ISSUER_ID` / `APPSTORE_API_PRIVATE_KEY_BASE64` secrets and
`IOS_BUNDLE_ID` / `APPLE_TEAM_ID` you already set up in SIGNING.md for
the TestFlight upload — nothing new to generate in App Store Connect.

`fastlane ios push_metadata` (what the workflow runs) uses
`skip_binary_upload: true` and `submit_for_review: false` — it only ever
touches text and images, never your build, and never submits anything.

## Android: fastlane/metadata/android/

```
fastlane/metadata/android/en-US/
  title.txt
  short_description.txt
  full_description.txt
  changelogs/
    default.txt
  images/
    icon.png
    featureGraphic.png
    phoneScreenshots/
      01_home.png
      02_feature.png
```

Uses the same `ANDROID_PLAY_SERVICE_ACCOUNT_JSON` secret and
`ANDROID_PACKAGE_NAME` variable you already set up in ANDROID.md for the
Play Store upload step. The service-account permissions ANDROID.md
already asks you to grant cover this too — nothing extra to configure in
Play Console.

`fastlane android push_metadata` uses `skip_upload_apk: true` and
`skip_upload_aab: true` — it never touches your binary or any release
track. Tick "Dry run" when triggering the workflow (`validate_only`) to
check everything without actually publishing a change, useful the first
time you run this against a real listing.

## Status

Built and reviewed against fastlane's current (August 2026) `deliver` and
`supply` documentation — both actions' non-interactive/CI setup, the
metadata folder conventions, and the metadata-only-upload flags used here
match what fastlane's own docs currently specify. **Not yet live-tested
against a real App Store Connect / Play Console listing** — doing so
safely would mean running it against Citolex's actual live listing, which
isn't something to test casually the way the disposable-scaffold-repo
pattern works for the build workflows elsewhere in this template. Treat
this as audited, not proven, until you've run it once yourself (ideally
with `validate_only` on the Android side first) against your own listing.
