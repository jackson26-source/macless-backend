# App Store Connect — the fields that block submission the first time

This pipeline gets a signed build into TestFlight. Actually submitting for
review is a separate step in App Store Connect, with its own list of
required fields. None of these are hard, but App Store Connect doesn't
always make it obvious which ones are still blocking you — this is the
checklist that got a real app past "Unable to Add for Review."

## Screenshots

You need screenshots sized for at least one 6.9" iPhone display, and
Apple also asks for iPad screenshots even if your app doesn't
specifically target iPad — if your app runs on iPad at all (most
Capacitor apps do by default), you'll need at least one 13" iPad
screenshot too, or you'll get blocked at submission with no obvious
explanation why. Apple auto-scales down to the other size classes in each
family from these, so providing just these two covers the requirement
without shooting every size in the chart.

`.github/workflows/screenshots.yml` (included in this template) generates
both automatically — run it by hand from the Actions tab, no signing
setup needed, and download `screenshot-iphone-6.9in.png` /
`screenshot-ipad-13in.png` from the run's Artifacts once it finishes.
That's the exact same unsigned-Simulator approach as
`simulator-preview.yml`, just aimed at the specific device classes Apple
requires instead of a single quick preview.

## Content Rights

App Store Connect asks you to confirm you have the rights to everything in
your app (text, images, third-party content). If your app is entirely
your own content and code, this is a quick "Yes, I own or have licensed
all rights" — but it's a real checkbox you have to actively answer, not
something that defaults for you.

## Contact Information

Apple requires a working phone number and email on the account-level
contact info, not just the app listing — this is easy to miss since it's
buried in account settings rather than the app's own page, and the
submission flow just says "Unable to Add for Review" without pointing at
it directly.

## App Privacy

The "App Privacy" section (what data your app collects) has to be
explicitly **published**, not just filled in — filling out the
questionnaire and leaving it in draft state still blocks submission. Look
for a separate "Publish" action once you've answered the questionnaire.

## Pricing

Even a free app needs an explicit pricing tier selected (Free is one of
the options, but it has to be chosen) before submission is allowed.

## Export Compliance

Covered in SETUP.md, but worth repeating here: this is a per-build
question, not a one-time account setting. If your app only talks to
servers over standard HTTPS (`URLSession`, no custom cryptography), the
answer is **"None of the algorithms mentioned above"** — picking the
wrong answer can trigger an additional French-distribution compliance
document you don't need.

## Age Rating

If your app has no user-generated content, no unrestricted web browsing,
no ads, and no account system, most of Apple's age-rating questionnaire
answers are "No" / "None," landing you at 4+. Answer honestly for your
actual app — this is just what "mostly No" looks like for a simple
content/utility app.

## App Privacy questionnaire, specifically

If your app genuinely doesn't send anything off-device — no analytics,
no crash reporting SDK, no ad network — the correct answer in the App
Privacy section is "No, we do not collect data from this app," not a
data-collection category you then have to justify.

---

None of these individually take long, but App Store Connect surfaces them
one at a time rather than as a single checklist, so it's easy to fix one
blocker, resubmit, and immediately hit the next one. Go through this list
top to bottom once and you should clear all of them in a single pass.
