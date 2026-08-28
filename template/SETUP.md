# Setup

The short version: push your project (Capacitor, bare React Native, or
Flutter) to a public GitHub repo, set up signing once (SIGNING.md), drop
in the workflow file that matches your framework, and every future push
builds and ships a TestFlight build automatically.

## 1. Make the repo public

Standard GitHub-hosted runners, including macOS, are unlimited-free for
public repositories. No signing secrets ever live in the repo itself —
they go into GitHub's encrypted Actions secrets (covered in SIGNING.md),
which aren't visible even to people who can read the code.

If you need the repo private instead, it still works — you just get a
limited number of free macOS-runner minutes per month before small
per-minute charges kick in. SIGNING.md has the numbers.

## 2. Push your project

```
git init
git add .
git commit -m "initial commit"
git remote add origin <your-repo-url>
git push -u origin main
```

## 3. Add the workflow file

Copy exactly one of these three from `.github/workflows/` in this
template into the same path in your project — see README.md's "Which
workflow file do I use?" table if you're not sure:

- **`ios-testflight.yml`** — Capacitor. Expects a `package.json` at the
  root (`npx cap add ios` / `npx cap sync ios` need to succeed on a clean
  checkout).
- **`ios-testflight-react-native.yml`** — bare React Native. Expects a
  real, checked-in `ios/` folder from `npx @react-native-community/cli
  init`, plus an `IOS_PROJECT_NAME` repo variable set to your Xcode
  project's name.
- **`ios-testflight-flutter.yml`** — Flutter. Expects a standard Flutter
  project layout (`ios/Runner.xcworkspace`); set `IOS_FLUTTER_VERSION` to
  pin an SDK version (recommended).

All three read the same signing secrets and two repo variables from
SIGNING.md — that part doesn't change based on framework.

## 4. Follow SIGNING.md

This generates your distribution certificate, App ID, provisioning
profile, and App Store Connect API key — all through openssl and Apple's
websites, no Xcode required. Takes about 20-30 minutes the first time,
never again after that.

## 5. Push again

Or re-run the workflow by hand from the repo's **Actions** tab. It adds
the iOS platform, signs, archives, and uploads to TestFlight. Open the
Actions tab to watch it happen — these builds fail loudly and specifically
if something's wrong with signing, so you'll know exactly what to fix
(see TROUBLESHOOTING.md).

## 6. Answer the Export Compliance question

The first time (and after some later builds) App Store Connect asks an
encryption/export-compliance question before a TestFlight build becomes
installable. If your app only talks to servers over standard HTTPS and
doesn't implement any custom encryption, the answer is **"None of the
algorithms mentioned above."** This has to be answered per-build, not
just once.

From here on: edit your code, `git push`, and the workflow builds and
ships a new TestFlight build automatically. No Mac touched at any point.

## Cost summary

| Item | Cost |
|---|---|
| Apple Developer Program | $99/year (required either way) |
| GitHub Actions builds, public repo | $0, unlimited |
| **Total to get a build into TestFlight** | **$99/year — nothing else** |
