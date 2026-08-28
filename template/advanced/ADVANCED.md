# Advanced: adding a Share Extension or custom native plugin

Skip this folder unless you already know you need it. The base template
(the workflow file + SIGNING.md) ships a plain Capacitor app with no
custom native code just fine on its own — `npx cap add ios` generates a
single buildable, signable App target, and the base pipeline handles that
with no extra scripting.

This folder is for the case where you're adding something Capacitor's
default template doesn't generate on its own — a Share Extension (an
entry in iOS's share sheet, like "Read in [Your App]"), a custom native
Swift plugin, an App Group so two targets can share data, or a
Background Modes capability like background audio.

`configure_ios_project.rb` is the actual script used to wire Citolex's
Share Extension and native text-to-speech plugin into its Xcode project
in CI, with the Citolex-specific names swapped for placeholders. It runs
after `npx cap add ios` and does programmatically what you'd otherwise
click through by hand in Xcode:

1. Copies your native Swift plugin file(s) into the main App target.
2. Creates a new Share Extension target, if you have one.
3. Turns on an App Group entitlement across both targets.
4. Turns on a Background Modes capability, if you need one.
5. Sets manual code-signing settings on every target it touches, so the
   workflow's signing step covers them too.

## Using it

1. Replace the placeholder values at the top of the script — look for the
   `# ---- Fill these in for your app ----` block. Every one of
   `APP_GROUP_ID`, `BUNDLE_ID_APP`, `BUNDLE_ID_SHARE`, and
   `SHARE_TARGET_NAME` currently holds a `YOUR_BUNDLE_ID`-based
   placeholder (e.g. `BUNDLE_ID_SHARE = 'YOUR_BUNDLE_ID.share'`) — swap
   each one for your own values, following the inline `# e.g.` comment
   next to it.
2. Put your native Swift file(s) somewhere in your repo (Citolex uses an
   `ios-plugin/` folder) and update the file list near the top of the
   script to match.
3. If you have a Share Extension, put its `ShareViewController.swift` and
   `Info.plist` somewhere in your repo too, and update those paths.
4. Add a step to your workflow, right after `npx cap sync ios` and before
   the signing step, that runs this script:
   ```yaml
   - name: Install Ruby gems for project scripting
     run: gem install xcodeproj --no-document

   - name: Wire in native plugin / share extension
     env:
       APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
       BUILD_NUMBER: ${{ github.run_number }}
     run: ruby advanced/configure_ios_project.rb
   ```
5. If you add a second target (like a Share Extension), you'll need a
   second provisioning profile and profile-name variable for it, and your
   `ExportOptions.plist` step in the workflow needs a second entry mapping
   that target's bundle ID to its profile name. SIGNING.md's steps 4-5
   cover creating an extra App ID and profile — just repeat them for the
   second bundle ID.

This is genuinely the fiddliest part of the whole setup, because
`xcodeproj` gem calls are working against Capacitor's generated project
structure, which can shift slightly between Capacitor versions. If a
specific call errors out, the error is usually specific enough to patch
directly — it's not a sign the approach is broken.
