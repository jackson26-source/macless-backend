# Ship an iOS app without a Mac

A working automated build pipeline — built on GitHub Actions, GitHub's own
free build servers — that builds, signs, and uploads an iOS app to
TestFlight (Apple's beta-testing tool). No Mac, no rented cloud Mac, no
monthly CI bill. Works with a Capacitor project, a bare React Native
project, or a Flutter project — pick the workflow file that matches yours.

This is the real setup used to ship [Citolex](https://citolex.com) to the
App Store. It's been cleaned up and genericized so you can drop it into
your own project.

## Start here

1. Read **SETUP.md** — the overall path, start to finish.
2. Follow **SIGNING.md** — one-time signing setup, no Xcode required. This
   part is identical no matter which framework you're using.
3. Copy the one workflow file that matches your project into your own
   repo — see "Which workflow file do I use?" below.
4. Push. Watch the Actions tab.
5. When you're ready to actually submit, **APP_STORE_SUBMISSION.md** covers
   the App Store Connect fields that trip people up the first time.
6. If a build fails, check **TROUBLESHOOTING.md** before anything else —
   it covers the actual errors this pipeline hits.

The `advanced/` folder covers adding a Share Extension or custom native
Swift plugin (the way Citolex adds native text-to-speech and a share
sheet). Most apps don't need this — skip it unless you know you do.

**Don't own an iPhone?** `SIMULATOR_PREVIEW.md` covers a second, optional
workflow that builds an unsigned Simulator version of your app and saves a
screenshot as a build artifact — no signing setup, no Apple hardware, no
extra cost. It's not a replacement for a real-device check before you
submit, but it means you're not flying blind before then. Related:
`.github/workflows/screenshots.yml` does the same thing but at the exact
sizes Apple requires for submission — see APP_STORE_SUBMISSION.md.

The main workflow also includes a **signing validation step** that checks
your provisioning profile's Team ID and bundle ID against your GitHub
secrets/variables before the archive step runs, so a mismatch fails with
a specific, readable reason instead of a generic xcodebuild error buried
in the log. That same check is also available as a free standalone tool —
[Macless Signing Doctor](https://github.com/jackson26-source/macless-signing-doctor) —
now covering Android keystores too, not just iOS profiles/certs, if you
want to run it against your signing files outside this pipeline. A
scheduled `.github/workflows/check-expiry.yml` runs it automatically every
week and only pings you if something's actually expiring — see SIGNING.md.

**Setting up signing for the first time?** `scripts/generate_signing_secrets.sh`
is a guided wizard for the whole one-time signing setup (iOS, Android, or
both) — it walks you through the CSR/certificate/profile/keystore steps,
and if you have the GitHub CLI installed, offers to push every secret
straight into your repo instead of you copy-pasting each one into the
GitHub web UI. See SIGNING.md and ANDROID.md for the details it's
automating.

**Also shipping to Google Play?** `ANDROID.md` +
`.github/workflows/android-build.yml` cover a signed Android App Bundle
build and Play Store upload, structured the same way as the iOS
pipeline. Optional — skip it if you're iOS-only.

**Tired of updating your store listing by hand?** `STORE_METADATA.md`
covers two more optional workflows — `appstore-metadata.yml` and
`playstore-metadata.yml` — that push your description, keywords,
release notes, and screenshots straight from files in your repo using
fastlane, reusing the same credentials you already set up above. They
never touch your build or submit anything for review; they just save you
clicking through App Store Connect / Play Console by hand.

Every TestFlight-upload workflow (all three framework variants) caches
`node_modules`/CocoaPods where relevant between runs, so repeat builds
are a bit faster than the first one, and has an optional
webhook-notification step — set a `NOTIFY_WEBHOOK_URL` secret to get a
Discord/Slack-style ping on build success or failure; leave it unset and
it's simply skipped.

**Changed something in one of the workflow files?** See TESTING.md for
how to actually run it in a throwaway repo before trusting it, rather
than just reading the YAML and hoping.

Check **CHANGELOG.md** for what's changed since you downloaded this.
Stuck on something not covered above? **SUPPORT.md** has the fastest
paths — including a GitHub Discussions space for this template.

## Which workflow file do I use?

All three share the exact same signing setup (SIGNING.md, one time, same
secrets) — they only differ in how the app itself gets built before
signing. Copy exactly one into `.github/workflows/` in your repo:

| Your project is... | Use | Extra repo variable(s) needed |
|---|---|---|
| [Capacitor](https://capacitorjs.com) (a website wrapped as a native shell) | `ios-testflight.yml` | none beyond SIGNING.md's table |
| Bare React Native (`npx @react-native-community/cli init`, real `ios/` folder checked in) | `ios-testflight-react-native.yml` | `IOS_PROJECT_NAME` — the name the RN CLI gave your `.xcworkspace`/scheme, e.g. `MyApp` |
| Flutter | `ios-testflight-flutter.yml` | `IOS_FLUTTER_VERSION` (optional but recommended — pins an exact SDK version instead of drifting with the `stable` channel) |

Something else entirely (a hand-rolled native Xcode project with no
framework)? Start from `ios-testflight-react-native.yml` — everything
past "Install JS dependencies" is generic xcodebuild, so drop that step
and point `IOS_PROJECT_NAME` at your own workspace/scheme name.

The React Native variant assumes `bundle exec pod install` works against
your `ios/Podfile` — if your project doesn't have a Gemfile pinning
CocoaPods yet, see TROUBLESHOOTING.md. If you've turned on React
Native's New Architecture, set `IOS_NEW_ARCHITECTURE` to `1`.

The Flutter variant deliberately does its own `xcodebuild archive` /
`xcodebuild -exportArchive` rather than using `flutter build ipa`'s
single-command path — that command has a known bug
([flutter/flutter#177853](https://github.com/flutter/flutter/issues/177853))
where manually-signed builds with entitlements like Push Notifications or
Sign in with Apple can fail at export. Splitting it out avoids that.

## Last verified working

Every workflow file in this template gets run for real — on a real GitHub
Actions macOS runner, against a real (if disposable) project — before
being marked "proven" here, not just reviewed as YAML. Toolchains drift
(Apple/Google/Gradle/Node versions move over time), so a file that worked
six months ago isn't guaranteed to still work today; this table gets
updated each time a workflow is actually re-run, not just when it's
edited.

| Workflow file | Last live-tested | Status |
|---|---|---|
| `ios-testflight.yml` (Capacitor + signing pipeline) | 2026-08-18 | Proven — full pipeline including a real TestFlight upload |
| `ios-testflight-react-native.yml` | 2026-08-18 | Proven — framework build steps (signing block shared/proven above) |
| `ios-testflight-flutter.yml` | 2026-08-18 | Proven — framework build steps (signing block shared/proven above) |
| `simulator-preview.yml` | 2026-08-17 | Proven |
| `screenshots.yml` | 2026-08-17 | Proven — both required device sizes |
| `android-build.yml` | 2026-08-18 | Proven for build + sign; the final Google Play upload step is still audited only, pending a live-tested Play Console service account |
| `appstore-metadata.yml` / `playstore-metadata.yml` (STORE_METADATA.md) | — | Audited against fastlane's current docs, not yet live-tested — see STORE_METADATA.md |
| `check-expiry.yml` (SIGNING.md) | 2026-08-19 | Proven — the underlying `scripts/signing-doctor.sh` Android checks are live-tested against a real generated keystore (correct/wrong password, wrong alias); the iOS certificate-pairing check is audited, not yet run against a real Apple cert in this exact form; the workflow's own decode/invoke/notify logic is live-tested locally |
| `scripts/generate_signing_secrets.sh` (SIGNING.md/ANDROID.md wizard) | 2026-08-19 | Proven — Android keystore generation (new/existing), the `gh`-missing and `gh`-not-authenticated fallback paths, and the Signing Doctor self-verify handoff are all live-tested; the iOS half is unchanged from the already-proven original script |

"Proven" means an actual run succeeded and its real step logs were
checked, not just a green checkmark. See TESTING.md if you want to verify
a workflow yourself before trusting it with your own project.

## What this assumes

- You have (or are getting) an Apple Developer Program membership
  ($99/year, unavoidable — this doesn't replace it, it just removes the
  need for a Mac to sign and ship).
- Your repo is public, or you understand the private-repo tradeoff
  covered in SIGNING.md.

## License

Personal-use license — for the person or team who purchased it, on your
own projects. Not for resale or redistribution. If someone you know wants
it, send them to the place you got it rather than forwarding your copy.

Questions before or after buying: localinfine@gmail.com
