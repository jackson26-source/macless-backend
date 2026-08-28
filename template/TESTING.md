# Testing a workflow change before you trust it

Static review — reading the YAML carefully — is not the same as knowing
a workflow actually works. A real example from this template's own
history: `simulator-preview.yml` and `screenshots.yml` both passed
careful, line-by-line review and *still* shipped with a bug — the `.app`
product lookup searched the wrong directory depth and could report "No
.app product found" on a perfectly successful build. Only an actual run
on a real GitHub Actions macOS runner caught it (see CHANGELOG.md,
2026-08-17).

This is that process, worth repeating any time you change one of the
workflow files — not just before trusting a change in your own project,
but especially before telling anyone else it works.

## 1. Spin up a throwaway scaffold

You don't need your real app for this — a minimal Capacitor project is
enough: a `package.json` with the Capacitor deps, a
`capacitor.config.json` with any `appId`/`appName`, and a placeholder
`www/index.html`.

Push it to a new repo — public is simplest (free unlimited macOS
minutes) and it doesn't need to go anywhere near your real app or its
signing secrets.

## 2. Copy in the workflow file(s) you changed

Same paths as your real project: `.github/workflows/...`.

## 3. Trigger a run

- `simulator-preview.yml` and `screenshots.yml` need **zero secrets** —
  trigger them from the Actions tab (`Run workflow` — note this is a
  two-step dropdown-then-confirm interaction, not a single click) and
  just watch them run.
- `ios-testflight.yml` and `android-build.yml` need real signing secrets
  to run all the way through. If you don't have a throwaway set of
  those, the next best option is running everything up through the step
  before signing (temporarily comment out or `if: false` the
  signing-dependent steps) to at least prove the build/sync steps still
  work, then review the signing-specific steps extra carefully since you
  can't run them for real.

## 4. Check the actual artifact, not just the green checkmark

A workflow can show green and still have produced nothing useful — the
`.app`-path bug above is exactly this: the step that "succeeded" printed
nothing wrong, the actual bug was in a later step's `find` command.
Download the artifact and open it. For a screenshot, does it show your
app's real UI, not a blank or crashed screen?

## 5. Clean up

Delete the throwaway repo when you're done, or make it private if
GitHub won't let you delete it right away (deleting a repo can require
an email-confirmation step). Don't leave real signing secrets sitting in
a throwaway repo any longer than the test takes.
