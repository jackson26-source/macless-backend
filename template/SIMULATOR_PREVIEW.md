# Simulator preview — see your app without owning an iPhone

`.github/workflows/simulator-preview.yml` is a second, optional workflow
that runs your app in the iOS Simulator and saves a screenshot — entirely
on the same free GitHub Actions macOS runner as the TestFlight workflow.
It needs no signing certificate, no provisioning profile, and no Apple
Developer account, because Simulator builds don't get signed at all.

This exists for one specific gap in the rest of this pipeline: everything
else here gets your app *built and shipped* without a Mac, but until now
there was no way to actually *see* it running without either opening
Xcode locally or installing a TestFlight build on a real device. This
closes that gap — you still won't want to ship to the App Store having
only ever seen the Simulator, but you no longer need an iPhone just to
check that a build actually launches and the UI looks right.

## What it does

1. Checks out your repo on a free macOS runner, same as the main workflow.
2. Adds the iOS platform and does an **unsigned Debug build** — no signing
   step at all, which is the whole reason this one needs zero setup.
3. Boots an iOS Simulator on the runner (a real iOS runtime, not a mockup
   or emulator of the OS — this is the same Simulator Xcode uses locally).
4. Installs and launches your app on it.
5. Takes a screenshot and uploads it as a workflow artifact you can
   download from the Actions tab.

## Using it

1. Copy `.github/workflows/simulator-preview.yml` into your repo alongside
   `ios-testflight.yml` — they're independent, you can have both.
2. Push, or trigger it by hand from the **Actions** tab
   (`workflow_dispatch`).
3. When the run finishes, open it in the Actions tab and scroll to
   **Artifacts** at the bottom — `simulator-preview` contains `preview.png`.

Artifacts are kept for 14 days by default; change `retention-days` in the
workflow file if you want longer.

## What this is not

The Simulator is genuinely the iOS runtime — not an approximation — so
layout, most UI behavior, and JavaScript/web-view content behave the same
as on a device. It does **not** cover: camera or other hardware sensors,
push notifications, in-app purchases, exact on-device performance, or
anything that depends on a real Apple ID being signed in. For those, and
before you actually submit, you still want at least one real-device pass
— but for day-to-day "does this look right" checks, this replaces needing
to own an iPhone at all.

## Need App-Store-ready screenshots instead of a quick preview?

This workflow is built for a fast "does it look right" check — one
device, one screenshot. If you need screenshots sized for actual App
Store submission, use `.github/workflows/screenshots.yml` instead — same
zero-signing approach, but it boots the two specific device sizes Apple
requires (a 6.9" iPhone and a 13" iPad) and saves both as separate
artifacts. See APP_STORE_SUBMISSION.md.

## Extending it

Want more than one screenshot — say, one per major screen of your app? Add
UI automation (XCUITest, or driving the app via `xcrun simctl` with
scripted taps) between the "Install + launch" and "Screenshot" steps, and
repeat the screenshot step for each state you want captured. That's
beyond what this template ships out of the box, but the workflow above is
the scaffolding to build it on.
