# Troubleshooting

Real problems this pipeline has actually hit, and how to fix each one.
Almost everything at this stage is a signing mismatch — a name or ID that
doesn't line up exactly between Apple's side and GitHub's secrets — rather
than a real code problem.

## Upload "succeeds" but the build never shows up in TestFlight

This is the most confusing failure because the Actions log shows green.
App Store Connect silently rejects re-uploads that reuse the same
marketing version + build number pair — `xcrun altool` reports a
successful *file transfer* either way, so the CI log looks fine while the
build quietly never appears.

Fix: make sure `CURRENT_PROJECT_VERSION` is set to something that changes
every run — the template does this with `${{ github.run_number }}`,
GitHub's own per-workflow run counter. If you've customized the archive
step and dropped this, every push after the first will silently vanish.

## "No signing certificate matching team ID" / codesign errors

Almost always one of:
- The provisioning profile name in your `IOS_PROVISIONING_PROFILE_NAME`
  variable doesn't **exactly** match the name you gave the profile in
  Apple's portal (case-sensitive, whitespace-sensitive).
- The bundle ID in `IOS_BUNDLE_ID` doesn't match the App ID the profile
  was generated for.
- The certificate in `IOS_DIST_CERT_P12_BASE64` has expired, or was
  regenerated in Apple's portal without regenerating the profile that
  references it (profiles pin to a specific certificate).

Check the "Import signing certificate" step's log — it prints the
identities actually found in the keychain, which tells you whether the
cert imported at all before blaming the profile.

**The "Validate signing setup" step (runs right after that one) catches
the Team ID and bundle ID mismatches from the list above automatically**
and fails with the specific mismatch spelled out, before you ever get to
a raw xcodebuild error. If you land here anyway, it's most likely the
third bullet (an expired or regenerated certificate) — that one can't be
checked from the profile alone.

## `npx cap add ios` fails or the App target isn't found

Capacitor's generated project layout occasionally shifts between major
versions. If you're using the `advanced/configure_ios_project.rb` script
and it can't find the `App` target, that's this — paste the exact error
and it's a quick patch against your Capacitor version, not a sign
anything is fundamentally broken.

## (React Native variant) `pod install` fails or can't find the workspace

Most often one of:
- `IOS_PROJECT_NAME` doesn't exactly match your `.xcworkspace`/scheme
  name — check `ios/` in your repo for the real name if you've ever
  renamed the Xcode project since `react-native init`.
- No `Gemfile` pinning CocoaPods yet, so `bundle exec pod install` fails
  before falling back to a bare `pod install` — either add a Gemfile
  (`bundle init && bundle add cocoapods`) or ignore the fallback warning,
  it's non-fatal.
- You've turned on React Native's New Architecture but didn't set the
  `IOS_NEW_ARCHITECTURE` repo variable to `1` — the codegen artifacts pods
  need won't be generated without it.

Also worth checking if you're on a very recent React Native version: 0.81+
raised the minimum Xcode version to 16.1, and there's a known
compatibility gap between RN 0.83.x and Xcode 26.0 — pin an exact
`IOS_XCODE_VERSION` repo variable rather than relying on "latest-stable"
if you hit a build error that doesn't reproduce locally.

## (Flutter variant) Archive succeeds locally but fails in CI over an entitlement

If your app uses Push Notifications, Sign in with Apple, or another
capability that needs an explicit entitlement, and you've customized this
workflow to use `flutter build ipa` directly instead of the split
build/archive/export steps it ships with — that's this. Flutter's own
export step has a known bug
([flutter/flutter#177853](https://github.com/flutter/flutter/issues/177853))
where its auto-generated ExportOptions.plist drops those entitlement
keys. The shipped workflow avoids it by doing its own `xcodebuild archive`
+ `xcodebuild -exportArchive` with a hand-authored ExportOptions.plist —
don't switch to `flutter build ipa`'s single-command path unless you're
sure your app doesn't need any extra entitlements.

## Export Compliance blocks TestFlight install

Covered in SETUP.md and APP_STORE_SUBMISSION.md — this is a per-build
question in App Store Connect, not a one-time setting. A build sits
un-installable until someone answers it for that specific build.

## GitHub Actions minutes running out on a private repo

Confirms you're on a private repo — the free-unlimited-macOS-minutes perk
is public-repos-only. See the "Private repos" section at the bottom of
SIGNING.md for the actual numbers and what it costs past the free tier.

## Faster Mac builds (optional — you don't need this to ship)

By default every iOS workflow here runs on GitHub's standard hosted macOS
runner (`macos-15`), which is what's included in your GitHub Actions
minutes (free-unlimited on public repos, metered on private ones — see
above). That's the whole reason this pipeline costs $0 to run: no
third-party build-infra vendor, no monthly bill beyond whatever GitHub
itself already charges you.

If build speed specifically becomes a real bottleneck — you're shipping
several times a day, or Xcode compile time is the thing slowing you
down — GitHub sells faster Apple Silicon runners directly, no
third-party vendor needed: `macos-15-xlarge`/`macos-26-xlarge` runners
(M-series chips, more cores) at a higher per-minute rate than the
standard runner. This requires your GitHub organization to be on the
**Team** plan or above (larger runners aren't available on Free), and
you enable them once under your org's Actions settings.

Once enabled, turn it on here with **zero workflow edits**: set a repo
or org **variable** (Settings → Secrets and variables → Actions →
Variables, not Secrets — this isn't sensitive) named `IOS_RUNNER_LABEL`
to the runner label you enabled, e.g. `macos-26-xlarge`. Every iOS build
workflow in this template already reads that variable with a safe
fallback to the standard free runner if it's unset, so this is entirely
opt-in and reversible — delete the variable and you're back to the
default with no other change.

**Before turning this on for real**, benchmark it yourself against a
couple of real runs on your actual project — GitHub's own published
numbers put the larger macOS runners meaningfully faster than the
standard one, but "meaningfully faster" for your specific build depends
on how much of your build time is spent compiling vs. installing
dependencies vs. waiting on the simulator/device, and this template
can't know that in advance. Compare the per-minute cost against what
you're actually spending in wasted developer time waiting on builds —
for most solo/small-team shipping cadences, the standard free runner is
still the right default, which is why it stays the default here.

## Still stuck

Email localinfine@gmail.com with the failed run's log (the Actions tab
has a "Download log" option) — these builds fail specifically enough that
most issues are diagnosable from the log alone.
