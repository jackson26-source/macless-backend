#!/usr/bin/env bash
#
# Guided setup wizard for Macless. Walks through the copy-paste-heavy
# parts of SIGNING.md (iOS) and ANDROID.md (Android) interactively,
# generates the exact base64 values you need as GitHub Secrets, and —
# if you have the GitHub CLI (`gh`) installed and logged in — can push
# them straight into your repo's Settings > Secrets/Variables for you,
# instead of you copy-pasting each one by hand.
#
# It doesn't touch your Apple or Google account beyond what you do
# yourself in a browser at their prompting (creating the certificate,
# profile, App ID, API key, or Play Console app) — this script handles
# the command-line half (openssl/keytool/base64) before and after each
# of those, and optionally the "paste into GitHub" half too.
#
# Ends by offering to run Signing Doctor (macless-signing-doctor,
# free/standalone: https://github.com/jackson26-source/macless-signing-doctor)
# against exactly what was just generated, so you find out immediately
# if something's wrong — instead of only discovering it when a real
# build fails later.
#
# Works on macOS and Linux out of the box. On Windows, run it through
# Git Bash (same as the manual openssl/keytool commands in SIGNING.md
# and ANDROID.md).
#
set -euo pipefail

OUT_DIR="secrets_output"
mkdir -p "$OUT_DIR"
if [ ! -f "$OUT_DIR/.gitignore" ]; then
  echo "*" > "$OUT_DIR/.gitignore"
fi

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
pause() { read -r -p "Press Enter once that's done... " _; }

# Collected along the way; used by the optional gh-push and
# self-verify steps at the end. Left blank if that platform is skipped.
IOS_DIST_CERT_P12_BASE64_VAL=""
IOS_DIST_CERT_PASSWORD_VAL=""
IOS_APP_PROVISION_PROFILE_BASE64_VAL=""
APPSTORE_API_KEY_ID_VAL=""
APPSTORE_API_ISSUER_ID_VAL=""
APPSTORE_API_PRIVATE_KEY_BASE64_VAL=""
APPLE_TEAM_ID_VAL=""
IOS_BUNDLE_ID_VAL=""
IOS_PROVISIONING_PROFILE_NAME_VAL=""

ANDROID_KEYSTORE_BASE64_VAL=""
ANDROID_KEYSTORE_PASSWORD_VAL=""
ANDROID_KEY_ALIAS_VAL=""
ANDROID_KEY_PASSWORD_VAL=""

DO_IOS=0
DO_ANDROID=0

say "== Macless setup wizard =="
echo "This writes files into ./$OUT_DIR/ — it's already gitignored, but"
echo "don't commit or share that folder anyway; it will contain real"
echo "signing secrets in base64 form."
echo
echo "What are you setting up?"
echo "  1) iOS only"
echo "  2) Android only"
echo "  3) Both"
read -r -p "Choice [1/2/3]: " SETUP_CHOICE
case "$SETUP_CHOICE" in
  1) DO_IOS=1 ;;
  2) DO_ANDROID=1 ;;
  3) DO_IOS=1; DO_ANDROID=1 ;;
  *) echo "Unrecognized choice, defaulting to both."; DO_IOS=1; DO_ANDROID=1 ;;
esac

# =======================================================================
# iOS
# =======================================================================
if [ "$DO_IOS" = "1" ]; then

say "1/5 — Certificate Signing Request (SIGNING.md step 1)"
read -r -p "Your name (for the CSR): " CSR_NAME
read -r -p "Your email: " CSR_EMAIL

openssl genrsa -out "$OUT_DIR/dist.key" 2048
openssl req -new -key "$OUT_DIR/dist.key" -out "$OUT_DIR/dist.csr" \
  -subj "/emailAddress=$CSR_EMAIL, CN=$CSR_NAME, C=US"

echo "Wrote $OUT_DIR/dist.csr"
echo "Now: go to developer.apple.com/account/resources/certificates/list"
echo "-> + -> Apple Distribution -> upload $OUT_DIR/dist.csr -> download the .cer"
pause

say "2/5 — Convert the downloaded certificate to a .p12 (SIGNING.md step 3)"
read -r -p "Path to the .cer file you just downloaded: " CER_PATH
read -r -s -p "Pick a password for the .p12 (you'll need this again as IOS_DIST_CERT_PASSWORD): " P12_PASSWORD
echo

openssl x509 -in "$CER_PATH" -inform DER -out "$OUT_DIR/distribution.pem" -outform PEM
openssl pkcs12 -export -inkey "$OUT_DIR/dist.key" -in "$OUT_DIR/distribution.pem" \
  -out "$OUT_DIR/dist.p12" -passout "pass:$P12_PASSWORD"
openssl base64 -in "$OUT_DIR/dist.p12" -out "$OUT_DIR/IOS_DIST_CERT_P12_BASE64.txt" -A

echo "Wrote $OUT_DIR/IOS_DIST_CERT_P12_BASE64.txt -> paste as secret IOS_DIST_CERT_P12_BASE64"
echo "(Password you picked -> paste as secret IOS_DIST_CERT_PASSWORD — not saved to a file, it's yours to remember/store.)"
IOS_DIST_CERT_P12_BASE64_VAL="$OUT_DIR/IOS_DIST_CERT_P12_BASE64.txt"
IOS_DIST_CERT_PASSWORD_VAL="$P12_PASSWORD"

say "3/5 — Provisioning profile (SIGNING.md steps 4-5)"
echo "Now: register your App ID, then create an App Store distribution"
echo "profile for it at developer.apple.com/account/resources/profiles/list"
echo "-> download the .mobileprovision file."
pause

read -r -p "Path to the .mobileprovision file you just downloaded: " PROFILE_PATH
openssl base64 -in "$PROFILE_PATH" -out "$OUT_DIR/IOS_APP_PROVISION_PROFILE_BASE64.txt" -A
echo "Wrote $OUT_DIR/IOS_APP_PROVISION_PROFILE_BASE64.txt -> paste as secret IOS_APP_PROVISION_PROFILE_BASE64"
IOS_APP_PROVISION_PROFILE_BASE64_VAL="$OUT_DIR/IOS_APP_PROVISION_PROFILE_BASE64.txt"
# Kept as a real file path (not just the base64) so the end-of-run
# Signing Doctor self-check can decode it directly.
IOS_PROFILE_RAW_PATH="$PROFILE_PATH"

say "4/5 — App Store Connect API key (SIGNING.md step 7)"
echo "Now: appstoreconnect.apple.com/access/api -> + -> role App Manager"
echo "-> download the .p8 file immediately (Apple only lets you once)"
echo "-> note the Key ID and Issuer ID shown on that page."
pause

read -r -p "Path to the downloaded .p8 file: " P8_PATH
openssl base64 -in "$P8_PATH" -out "$OUT_DIR/APPSTORE_API_PRIVATE_KEY_BASE64.txt" -A
echo "Wrote $OUT_DIR/APPSTORE_API_PRIVATE_KEY_BASE64.txt -> paste as secret APPSTORE_API_PRIVATE_KEY_BASE64"
APPSTORE_API_PRIVATE_KEY_BASE64_VAL="$OUT_DIR/APPSTORE_API_PRIVATE_KEY_BASE64.txt"

read -r -p "Key ID shown on that page (paste as secret APPSTORE_API_KEY_ID): " KEY_ID
read -r -p "Issuer ID shown on that page (paste as secret APPSTORE_API_ISSUER_ID): " ISSUER_ID
APPSTORE_API_KEY_ID_VAL="$KEY_ID"
APPSTORE_API_ISSUER_ID_VAL="$ISSUER_ID"

say "5/5 — Team ID, bundle ID, and profile name (SIGNING.md steps 8-9)"
read -r -p "Your Team ID from developer.apple.com/account -> Membership details (paste as secret APPLE_TEAM_ID): " TEAM_ID
read -r -p "Your app's bundle ID, e.g. com.example.app (repo VARIABLE IOS_BUNDLE_ID): " BUNDLE_ID
read -r -p "The exact Name you gave the provisioning profile in step 3 (repo VARIABLE IOS_PROVISIONING_PROFILE_NAME): " PROFILE_NAME
APPLE_TEAM_ID_VAL="$TEAM_ID"
IOS_BUNDLE_ID_VAL="$BUNDLE_ID"
IOS_PROVISIONING_PROFILE_NAME_VAL="$PROFILE_NAME"

fi # DO_IOS

# =======================================================================
# Android
# =======================================================================
if [ "$DO_ANDROID" = "1" ]; then

say "Android — release keystore (ANDROID.md step 1)"
if ! command -v keytool >/dev/null 2>&1; then
  echo "keytool isn't available here (it ships with any JDK). Install a JDK,"
  echo "or generate the keystore on another machine/a GitHub Actions runner"
  echo "and come back to this script with the file path — skipping keystore"
  echo "generation for now."
  read -r -p "Path to an existing release.keystore, if you already have one (blank to skip): " EXISTING_KEYSTORE
  if [ -n "$EXISTING_KEYSTORE" ]; then
    read -r -s -p "Keystore password: " ANDROID_KS_PASSWORD; echo
    read -r -p "Key alias [upload]: " ANDROID_ALIAS
    ANDROID_ALIAS="${ANDROID_ALIAS:-upload}"
    openssl base64 -in "$EXISTING_KEYSTORE" -out "$OUT_DIR/ANDROID_KEYSTORE_BASE64.txt" -A
    ANDROID_KEYSTORE_BASE64_VAL="$OUT_DIR/ANDROID_KEYSTORE_BASE64.txt"
    ANDROID_KEYSTORE_PASSWORD_VAL="$ANDROID_KS_PASSWORD"
    ANDROID_KEY_ALIAS_VAL="$ANDROID_ALIAS"
    ANDROID_KEY_PASSWORD_VAL="$ANDROID_KS_PASSWORD"
    ANDROID_KEYSTORE_RAW_PATH="$EXISTING_KEYSTORE"
    echo "Wrote $OUT_DIR/ANDROID_KEYSTORE_BASE64.txt -> paste as secret ANDROID_KEYSTORE_BASE64"
  fi
else
  echo "Already have a release.keystore from a previous setup? [y/N]"
  read -r -p "> " HAVE_EXISTING
  if [[ "$HAVE_EXISTING" =~ ^[Yy] ]]; then
    read -r -p "Path to it: " ANDROID_KEYSTORE_PATH
    read -r -s -p "Keystore password: " ANDROID_KS_PASSWORD; echo
    read -r -p "Key alias [upload]: " ANDROID_ALIAS
    ANDROID_ALIAS="${ANDROID_ALIAS:-upload}"
  else
    echo "Generating a new one — keep the resulting file safe: if you lose it,"
    echo "you lose the ability to publish updates to this app on Google Play."
    read -r -p "Key alias [upload]: " ANDROID_ALIAS
    ANDROID_ALIAS="${ANDROID_ALIAS:-upload}"
    read -r -p "Your name or company (goes on the keystore's self-signed certificate, Play doesn't show this to users): " ANDROID_DN_NAME
    ANDROID_DN_NAME="${ANDROID_DN_NAME:-Unknown}"
    read -r -s -p "Pick a keystore password (you'll need this again as ANDROID_KEYSTORE_PASSWORD): " ANDROID_KS_PASSWORD; echo
    ANDROID_KEYSTORE_PATH="$OUT_DIR/release.keystore"
    # -dname avoids keytool's own separate interactive name/org/city/etc.
    # prompt sequence, which would otherwise nest inside this script's
    # prompts and can loop/fail under piped or scripted input.
    keytool -genkeypair -v -keystore "$ANDROID_KEYSTORE_PATH" -alias "$ANDROID_ALIAS" \
      -keyalg RSA -keysize 2048 -validity 10000 \
      -dname "CN=$ANDROID_DN_NAME, OU=Unknown, O=Unknown, L=Unknown, ST=Unknown, C=US" \
      -storepass "$ANDROID_KS_PASSWORD" -keypass "$ANDROID_KS_PASSWORD"
    echo "Wrote $ANDROID_KEYSTORE_PATH"
  fi

  openssl base64 -in "$ANDROID_KEYSTORE_PATH" -out "$OUT_DIR/ANDROID_KEYSTORE_BASE64.txt" -A
  echo "Wrote $OUT_DIR/ANDROID_KEYSTORE_BASE64.txt -> paste as secret ANDROID_KEYSTORE_BASE64"
  ANDROID_KEYSTORE_BASE64_VAL="$OUT_DIR/ANDROID_KEYSTORE_BASE64.txt"
  ANDROID_KEYSTORE_PASSWORD_VAL="$ANDROID_KS_PASSWORD"
  ANDROID_KEY_ALIAS_VAL="$ANDROID_ALIAS"
  ANDROID_KEY_PASSWORD_VAL="$ANDROID_KS_PASSWORD"
  ANDROID_KEYSTORE_RAW_PATH="$ANDROID_KEYSTORE_PATH"
fi

echo
echo "(ANDROID_KEY_PASSWORD -> same as ANDROID_KEYSTORE_PASSWORD unless you"
echo "used a different key password when originally generating this keystore."
echo "ANDROID_PLAY_SERVICE_ACCOUNT_JSON is a separate step — see ANDROID.md"
echo "section 2, it's a file you download from Google Play Console, this"
echo "script doesn't touch Google Play.)"

fi # DO_ANDROID

# =======================================================================
# Summary
# =======================================================================
say "Done. Summary of what to paste into GitHub -> Settings -> Secrets and variables -> Actions:"

if [ "$DO_IOS" = "1" ]; then
cat <<SUMMARY

iOS repository secrets:
  IOS_DIST_CERT_P12_BASE64        -> contents of $IOS_DIST_CERT_P12_BASE64_VAL
  IOS_DIST_CERT_PASSWORD          -> the password you picked in step 2 (not saved to a file)
  IOS_APP_PROVISION_PROFILE_BASE64 -> contents of $IOS_APP_PROVISION_PROFILE_BASE64_VAL
  APPSTORE_API_KEY_ID             -> $APPSTORE_API_KEY_ID_VAL
  APPSTORE_API_ISSUER_ID          -> $APPSTORE_API_ISSUER_ID_VAL
  APPSTORE_API_PRIVATE_KEY_BASE64 -> contents of $APPSTORE_API_PRIVATE_KEY_BASE64_VAL
  APPLE_TEAM_ID                   -> $APPLE_TEAM_ID_VAL

iOS repository variables:
  IOS_BUNDLE_ID                   -> $IOS_BUNDLE_ID_VAL
  IOS_PROVISIONING_PROFILE_NAME   -> $IOS_PROVISIONING_PROFILE_NAME_VAL
SUMMARY
fi

if [ "$DO_ANDROID" = "1" ]; then
cat <<SUMMARY

Android repository secrets:
  ANDROID_KEYSTORE_BASE64         -> contents of $ANDROID_KEYSTORE_BASE64_VAL
  ANDROID_KEYSTORE_PASSWORD       -> the password you set above (not saved to a file)
  ANDROID_KEY_ALIAS               -> $ANDROID_KEY_ALIAS_VAL
  ANDROID_KEY_PASSWORD            -> same as above unless you used a different one
  ANDROID_PLAY_SERVICE_ACCOUNT_JSON -> separate step, see ANDROID.md section 2
SUMMARY
fi

echo
echo "Everything under $OUT_DIR/ is gitignored. Delete that folder once"
echo "you've pasted these into GitHub (or had this script push them for you"
echo "below) — there's no reason to keep plaintext copies of your signing"
echo "secrets sitting on disk longer than that."

# =======================================================================
# Optional: push straight to GitHub via the gh CLI
# =======================================================================
say "Push these directly to your GitHub repo now?"
if ! command -v gh >/dev/null 2>&1; then
  echo "The GitHub CLI ('gh') isn't installed here, so this step is skipped —"
  echo "install it from cli.github.com if you'd rather not paste each value"
  echo "into the GitHub web UI by hand next time. For now, paste the values"
  echo "above into your repo's Settings -> Secrets and variables -> Actions."
elif ! gh auth status >/dev/null 2>&1; then
  echo "'gh' is installed but not logged in ('gh auth login' first) — skipping."
  echo "Paste the values above into Settings -> Secrets and variables -> Actions"
  echo "for now."
else
  DETECTED_REPO=""
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    DETECTED_REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "")
  fi
  if [ -n "$DETECTED_REPO" ]; then
    read -r -p "Push to $DETECTED_REPO? [Y/n]: " CONFIRM_REPO
    if [[ "$CONFIRM_REPO" =~ ^[Nn] ]]; then
      read -r -p "Repo to push to instead (owner/repo): " TARGET_REPO
    else
      TARGET_REPO="$DETECTED_REPO"
    fi
  else
    read -r -p "Repo to push to (owner/repo): " TARGET_REPO
  fi

  if [ -n "$TARGET_REPO" ]; then
    echo "Pushing to $TARGET_REPO ..."
    if [ "$DO_IOS" = "1" ]; then
      gh secret set IOS_DIST_CERT_P12_BASE64 --repo "$TARGET_REPO" < "$IOS_DIST_CERT_P12_BASE64_VAL"
      printf '%s' "$IOS_DIST_CERT_PASSWORD_VAL" | gh secret set IOS_DIST_CERT_PASSWORD --repo "$TARGET_REPO"
      gh secret set IOS_APP_PROVISION_PROFILE_BASE64 --repo "$TARGET_REPO" < "$IOS_APP_PROVISION_PROFILE_BASE64_VAL"
      printf '%s' "$APPSTORE_API_KEY_ID_VAL" | gh secret set APPSTORE_API_KEY_ID --repo "$TARGET_REPO"
      printf '%s' "$APPSTORE_API_ISSUER_ID_VAL" | gh secret set APPSTORE_API_ISSUER_ID --repo "$TARGET_REPO"
      gh secret set APPSTORE_API_PRIVATE_KEY_BASE64 --repo "$TARGET_REPO" < "$APPSTORE_API_PRIVATE_KEY_BASE64_VAL"
      printf '%s' "$APPLE_TEAM_ID_VAL" | gh secret set APPLE_TEAM_ID --repo "$TARGET_REPO"
      gh variable set IOS_BUNDLE_ID --repo "$TARGET_REPO" --body "$IOS_BUNDLE_ID_VAL"
      gh variable set IOS_PROVISIONING_PROFILE_NAME --repo "$TARGET_REPO" --body "$IOS_PROVISIONING_PROFILE_NAME_VAL"
      echo "iOS secrets/variables pushed."
    fi
    if [ "$DO_ANDROID" = "1" ]; then
      gh secret set ANDROID_KEYSTORE_BASE64 --repo "$TARGET_REPO" < "$ANDROID_KEYSTORE_BASE64_VAL"
      printf '%s' "$ANDROID_KEYSTORE_PASSWORD_VAL" | gh secret set ANDROID_KEYSTORE_PASSWORD --repo "$TARGET_REPO"
      printf '%s' "$ANDROID_KEY_ALIAS_VAL" | gh secret set ANDROID_KEY_ALIAS --repo "$TARGET_REPO"
      printf '%s' "$ANDROID_KEY_PASSWORD_VAL" | gh secret set ANDROID_KEY_PASSWORD --repo "$TARGET_REPO"
      echo "Android secrets pushed. (ANDROID_PLAY_SERVICE_ACCOUNT_JSON is still a"
      echo "manual step — see ANDROID.md section 2.)"
    fi
    echo "Done — check $TARGET_REPO's Settings > Secrets and variables > Actions to confirm."
  else
    echo "No repo given, skipping the push."
  fi
fi

# =======================================================================
# Optional: self-verify with Signing Doctor
# =======================================================================
say "Verify what was just generated with Signing Doctor?"
echo "Signing Doctor (free, standalone: github.com/jackson26-source/macless-signing-doctor)"
echo "decodes exactly what you just made and tells you in plain English if"
echo "anything's off, before you find out the hard way in a real build."
read -r -p "Run it now? [Y/n]: " RUN_DOCTOR
if ! [[ "$RUN_DOCTOR" =~ ^[Nn] ]]; then
  DOCTOR_SCRIPT="$OUT_DIR/signing-doctor.sh"
  if command -v curl >/dev/null 2>&1 && curl -fsSL \
      "https://raw.githubusercontent.com/jackson26-source/macless-signing-doctor/main/signing-doctor.sh" \
      -o "$DOCTOR_SCRIPT" 2>/dev/null; then
    chmod +x "$DOCTOR_SCRIPT"
    DOCTOR_ARGS=()
    if [ "$DO_IOS" = "1" ] && [ -n "${IOS_PROFILE_RAW_PATH:-}" ]; then
      DOCTOR_ARGS+=(--profile "$IOS_PROFILE_RAW_PATH" --cert "$OUT_DIR/dist.p12" --cert-password "$IOS_DIST_CERT_PASSWORD_VAL")
      [ -n "$APPLE_TEAM_ID_VAL" ] && DOCTOR_ARGS+=(--expected-team-id "$APPLE_TEAM_ID_VAL")
      [ -n "$IOS_BUNDLE_ID_VAL" ] && DOCTOR_ARGS+=(--expected-bundle-id "$IOS_BUNDLE_ID_VAL")
    fi
    if [ "$DO_ANDROID" = "1" ] && [ -n "${ANDROID_KEYSTORE_RAW_PATH:-}" ]; then
      DOCTOR_ARGS+=(--android-keystore "$ANDROID_KEYSTORE_RAW_PATH" --android-keystore-password "$ANDROID_KEYSTORE_PASSWORD_VAL" --android-key-alias "$ANDROID_KEY_ALIAS_VAL")
    fi
    if [ "${#DOCTOR_ARGS[@]}" -gt 0 ]; then
      echo
      "$DOCTOR_SCRIPT" "${DOCTOR_ARGS[@]}" || echo "(Signing Doctor found something to fix above — everything it printed still applies even though this wizard already finished.)"
    else
      echo "Nothing to verify (this platform's files weren't generated this run)."
    fi
  else
    echo "Couldn't download Signing Doctor (no internet access from here, or"
    echo "github.com is unreachable) — you can run it yourself later:"
    echo "  curl -fsSL https://raw.githubusercontent.com/jackson26-source/macless-signing-doctor/main/signing-doctor.sh -o signing-doctor.sh"
  fi
fi

say "All done."
