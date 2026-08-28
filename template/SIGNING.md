# Signing setup — done entirely from a web browser, no Xcode

This replaces what Xcode's "Automatic Signing" checkbox normally does for
you. It's a one-time setup (20-30 minutes), done through openssl (works
fine on Windows via Git Bash) and the Apple Developer / App Store Connect
websites. Every future GitHub Actions build reuses it automatically.

**Quick definitions, so the steps below make sense the first time through:**
a **certificate** is Apple's proof that you are who you say you are; a
**provisioning profile** ties that certificate to one specific app and
lets it run on real devices or go to the App Store; your **bundle ID** is
your app's unique name, like a domain name (e.g. `com.yourname.yourapp`);
your **Team ID** is a 10-character code identifying your Apple Developer
account. You'll create one of each below — exactly once, ever, per app.

Pick a bundle ID for your app before you start — for example
`com.yourname.yourapp`. You'll use it repeatedly below.

**If you're following the manual steps below (not the script mentioned
next), run the `openssl` commands from a scratch folder outside your
project repo** — e.g. your Desktop — not from inside it. They generate
real private-key material, and a `.gitignore` covering these file types
ships with this template as a backstop, but the safest habit is to never
let them exist inside a git working directory in the first place. (The
helper script below already writes its output to a self-gitignored
`secrets_output/` folder, so this only matters if you're typing the
commands yourself.)

**Prefer not to copy-paste each `openssl` command by hand?**
`scripts/generate_signing_secrets.sh` is a guided setup wizard that walks
through steps 1, 3, 5, and 7 below interactively and writes the base64
values straight to files — it still pauses for you to do the
Apple-website parts yourself (there's no way around those), it just
handles the command-line half. It covers the Android keystore setup from
ANDROID.md too, in the same run if you want both. Two more conveniences
past just writing the files: if you have the [GitHub CLI](https://cli.github.com)
(`gh`) installed and logged in, it can push every value straight into
your repo's Settings > Secrets and variables for you instead of you
pasting each one by hand; and at the end it offers to run
[Signing Doctor](https://github.com/jackson26-source/macless-signing-doctor)
against exactly what it just generated, so you find out immediately if
something's off rather than only discovering it when a real build fails.
The manual steps below still apply if you'd rather do it by hand, or want
to understand exactly what the script is doing.

## 1. Generate a Certificate Signing Request (CSR)

```
openssl genrsa -out dist.key 2048
openssl req -new -key dist.key -out dist.csr -subj "/emailAddress=you@example.com, CN=Your Name, C=US"
```

Keep `dist.key` — you'll need it in step 3.

## 2. Create a Distribution Certificate

1. Go to [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates/list)
2. Click **+**, choose **Apple Distribution**, upload `dist.csr`
3. Download the resulting `.cer` file

## 3. Convert to a .p12 (what GitHub Actions actually needs)

```
openssl x509 -in distribution.cer -inform DER -out distribution.pem -outform PEM
openssl pkcs12 -export -inkey dist.key -in distribution.pem -out dist.p12 -passout pass:SOME_PASSWORD_YOU_PICK
```

Then base64-encode it for GitHub:

```
openssl base64 -in dist.p12 -out dist_base64.txt -A
```

(`-A` keeps it on one line, which pastes into a GitHub secret cleanly. On
Windows, `certutil -encode` works too — just strip the `-----BEGIN
CERTIFICATE-----` / `-----END-----` lines it adds.)

## 4. Register your App ID

Go to [Identifiers](https://developer.apple.com/account/resources/identifiers/list):

1. Create your bundle ID (e.g. `com.yourname.yourapp`)
2. If your app uses an App Group, a Share Extension, or push notifications,
   check the relevant capability here too — see `advanced/` if so

## 5. Create a Provisioning Profile

Go to [Profiles](https://developer.apple.com/account/resources/profiles/list):

1. **App Store** distribution profile for your bundle ID → select your
   distribution certificate → give it a clear name, e.g. **YourApp App
   Store**

Download the `.mobileprovision` file, then base64-encode it the same way
as step 3.

## 6. Register the app in App Store Connect

Go to [App Store Connect](https://appstoreconnect.apple.com) → My Apps →
**+** → New App. Platform iOS, pick your bundle ID from the dropdown
(it'll be there from step 4), any SKU. This creates the app record the
upload step needs to find.

## 7. Create an App Store Connect API key (for the automated upload)

Go to [Users and Access > Integrations > App Store Connect API](https://appstoreconnect.apple.com/access/api)

1. Click **+** to generate a key, role **App Manager**
2. Download the `.p8` file **immediately** — Apple only lets you download
   it once
3. Note the **Key ID** and **Issuer ID** shown on that page
4. Base64-encode the `.p8` file the same way as step 3

## 8. Find your Team ID

[developer.apple.com/account](https://developer.apple.com/account) →
scroll to **Membership details** → **Team ID** (a 10-character code).

## 9. Add secrets and variables to your GitHub repo

**Settings → Secrets and variables → Actions.**

Add these as **repository secrets** (New repository secret):

| Secret name | Value |
|---|---|
| `IOS_DIST_CERT_P12_BASE64` | base64 of `dist.p12` |
| `IOS_DIST_CERT_PASSWORD` | the password you picked in step 3 |
| `IOS_APP_PROVISION_PROFILE_BASE64` | base64 of your `.mobileprovision` |
| `APPSTORE_API_KEY_ID` | Key ID from step 7 |
| `APPSTORE_API_ISSUER_ID` | Issuer ID from step 7 |
| `APPSTORE_API_PRIVATE_KEY_BASE64` | base64 of the `.p8` file |
| `APPLE_TEAM_ID` | Team ID from step 8 |

Add these as **repository variables** (switch to the Variables tab, New
repository variable) — not secret, just config the workflow file reads:

| Variable name | Value |
|---|---|
| `IOS_BUNDLE_ID` | your bundle ID, e.g. `com.yourname.yourapp` |
| `IOS_PROVISIONING_PROFILE_NAME` | the exact profile name from step 5 |

That's it — push to `main` and `ios-testflight.yml` builds, signs, and
uploads a build to TestFlight automatically, entirely on GitHub's free
macOS runners.

## If a build fails

Open the failed run in the **Actions** tab and read the step that went
red — these builds fail loudly and specifically (wrong bundle ID, expired
profile, missing secret, profile name that doesn't match exactly), it
won't be a silent mystery. See TROUBLESHOOTING.md for the ones this
pipeline has actually hit.

If it's specifically a signing mismatch (Team ID, bundle ID, an expired
profile, or a certificate/profile that don't actually pair together),
[Macless Signing Doctor](https://github.com/jackson26-source/macless-signing-doctor)
is a free standalone script that decodes your `.mobileprovision` (and
optionally your `.p12`) and gives you a plain-English diagnosis instead of
xcodebuild's generic error — it's the same check this template's own
"Validate signing setup" step runs, pulled out so you can run it on its
own, point it at any file, or drop it into your own workflow as a
composite Action.

**Don't want to find out about an expiring cert the hard way, mid-release?**
`.github/workflows/check-expiry.yml` runs Signing Doctor's expiry checks
automatically every week (and on demand from the Actions tab) against
whichever of your iOS/Android signing secrets are set, and only pings your
`NOTIFY_WEBHOOK_URL` webhook when something's actually expiring or expired
— quiet the rest of the time, so it doesn't turn into noise. A full report
is always in that run's Summary tab either way.

## Private repos

The free-minutes trick above is specifically a public-repo perk. If your
repo has to be private: GitHub's Free plan includes 2,000 Actions minutes
a month, but macOS runners cost roughly 10x a normal minute against that
allowance, and once you're past it, macOS overage runs about $0.06/minute.
A typical build in this pipeline takes somewhere around 8-15 minutes, so a
private repo can still work fine at low-to-moderate push frequency — it
just isn't unlimited-free the way a public repo is.
