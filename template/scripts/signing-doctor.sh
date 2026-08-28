#!/bin/bash
# signing-doctor.sh — plain-English diagnosis of common iOS and Android
# code-signing failures, extracted and generalized from the "Validate
# signing setup" step used in Macless's own ios-testflight*.yml and
# android-build.yml workflows.
#
# Free, standalone tool: works on ANY Xcode/iOS or Android project, not
# just ones using Macless.
#
#   iOS checks need macOS (uses the `security`, `PlistBuddy`, `plutil`,
#   and `openssl` command-line tools that ship with Xcode's Command Line
#   Tools) — run locally on a Mac, or as a step on a macOS GitHub Actions
#   runner (`runs-on: macos-*`).
#
#   Android checks only need `keytool` (ships with any JDK) and `openssl`
#   — these work on macOS, Linux, or Windows (via Git Bash), including
#   Ubuntu GitHub Actions runners, so you don't need a macOS runner just
#   to check an Android keystore.
#
# You can check iOS only, Android only, or both in one run — whichever
# flags you pass.
#
# What it checks, and why each one matters:
#  iOS (--profile):
#   1. Can the provisioning profile be decoded at all? (a "not a valid
#      base64" or corrupted-file mistake is the #1 first-time signing
#      error, and produces a useless generic error from Xcode/xcodebuild)
#   2. Has the profile expired, or is it expiring soon?
#   3. Does the profile's Team ID match what you expect?
#   4. Does the profile's bundle ID match what you expect (including
#      wildcard "*" App ID profiles)?
#   5. If a distribution certificate (.p12) is also supplied (--cert): has
#      IT expired, and — the single hardest-to-diagnose signing failure —
#      does its certificate actually appear inside the profile's embedded
#      DeveloperCertificates list? (A profile generated for a DIFFERENT
#      certificate is a very common "why won't this codesign" cause, and
#      xcodebuild's own error for this is famously unhelpful.)
#  Android (--android-keystore):
#   6. Can the keystore be opened with the given password and alias at all?
#   7. Has the signing key inside it expired, or is it expiring soon? (a
#      keystore itself doesn't "expire," but the certificate inside it
#      does — Google Play will reject an update signed with an expired key)
#   8. Does the key algorithm/size look sane for Play Store signing?
#
# Usage:
#   ./signing-doctor.sh --profile path/to/App.mobileprovision \
#     [--expected-team-id ABCDE12345] \
#     [--expected-bundle-id com.example.app] \
#     [--cert path/to/cert.p12] [--cert-password "..."]
#
#   ./signing-doctor.sh --android-keystore path/to/release.keystore \
#     --android-keystore-password "..." \
#     [--android-key-alias upload] [--android-key-password "..."]
#
#   (Both blocks of flags can be combined in a single run — useful for
#   Macless buyers checking both SKUs' secrets at once.)
#
# Any combination of the optional flags is fine — the script always
# decodes and prints what it can, and only compares against an expected
# value if you gave it one. Exit code is 0 if everything checked passed
# (or wasn't checked), 1 if something concrete failed. At least one of
# --profile or --android-keystore is required.
#
# If $GITHUB_STEP_SUMMARY is set (true when running as a GitHub Actions
# step), the same report is also appended there so results show up
# nicely formatted in the Actions run UI, not just in the raw log.

set -u

PROFILE_PATH=""
CERT_PATH=""
CERT_PASSWORD=""
EXPECTED_TEAM_ID=""
EXPECTED_BUNDLE_ID=""
ANDROID_KEYSTORE_PATH=""
ANDROID_KEYSTORE_PASSWORD=""
ANDROID_KEY_ALIAS="upload"
ANDROID_KEY_PASSWORD=""

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE_PATH="$2"; shift 2 ;;
    --cert) CERT_PATH="$2"; shift 2 ;;
    --cert-password) CERT_PASSWORD="$2"; shift 2 ;;
    --expected-team-id) EXPECTED_TEAM_ID="$2"; shift 2 ;;
    --expected-bundle-id) EXPECTED_BUNDLE_ID="$2"; shift 2 ;;
    --android-keystore) ANDROID_KEYSTORE_PATH="$2"; shift 2 ;;
    --android-keystore-password) ANDROID_KEYSTORE_PASSWORD="$2"; shift 2 ;;
    --android-key-alias) ANDROID_KEY_ALIAS="$2"; shift 2 ;;
    --android-key-password) ANDROID_KEY_PASSWORD="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--profile <path.mobileprovision> [--expected-team-id ID] [--expected-bundle-id ID] [--cert path.p12] [--cert-password PASS]] [--android-keystore <path> --android-keystore-password PASS [--android-key-alias upload] [--android-key-password PASS]]"
      echo "At least one of --profile or --android-keystore is required."
      exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2 ;;
  esac
done

if [ -z "$PROFILE_PATH" ] && [ -z "$ANDROID_KEYSTORE_PATH" ]; then
  echo "Error: pass --profile (iOS), --android-keystore (Android), or both. See --help." >&2
  exit 2
fi

# If the Android key password wasn't given separately, most keystores use
# the same password for the store and the key inside it — fall back to
# that rather than forcing buyers to type it twice.
if [ -z "$ANDROID_KEY_PASSWORD" ]; then
  ANDROID_KEY_PASSWORD="$ANDROID_KEYSTORE_PASSWORD"
fi

FAILED=0
WARNED=0
SUMMARY_LINES=()

# Appends a line to both stdout and, if GITHUB_STEP_SUMMARY is set, to the
# Actions run summary (in addition to the normal echo already on stdout).
note() {
  SUMMARY_LINES+=("$1")
}

echo "=================================================================="
echo " signing-doctor"
echo "=================================================================="
echo

# ======================================================================
# iOS: provisioning profile + optional certificate
# ======================================================================
if [ -n "$PROFILE_PATH" ]; then
  echo "------------------------------------------------------------------"
  echo " iOS — $PROFILE_PATH"
  echo "------------------------------------------------------------------"
  note "### iOS — \`$PROFILE_PATH\`"

  if [ ! -f "$PROFILE_PATH" ]; then
    echo "Error: no file found at $PROFILE_PATH" >&2
    FAILED=1
  elif ! command -v security >/dev/null 2>&1; then
    echo "FAIL  The 'security' command isn't available — iOS profile/cert checks"
    echo "      need to run on macOS with Xcode's Command Line Tools installed"
    echo "      (locally, or on a GitHub Actions macos-* runner)."
    note "FAIL — needs to run on macOS (the \`security\` command isn't available here)."
    FAILED=1
  else
    PLIST_PATH="$(mktemp -t signing-doctor-profile).plist"
    security cms -D -i "$PROFILE_PATH" > "$PLIST_PATH" 2>/dev/null

    if [ ! -s "$PLIST_PATH" ]; then
      echo "FAIL  Couldn't decode this file as a provisioning profile at all."
      echo "      Most common cause: this isn't actually a .mobileprovision file —"
      echo "      double check you didn't accidentally point this at a .cer, .p12,"
      echo "      or a base64-encoded copy of one of those instead. If you base64'd"
      echo "      this file for storage (e.g. as a CI secret), make sure you decoded"
      echo "      it back to the original binary .mobileprovision before running this."
      note "FAIL — couldn't decode as a provisioning profile (wrong file, or still base64-encoded)."
      FAILED=1
      rm -f "$PLIST_PATH"
    else
      PROFILE_NAME=$(/usr/libexec/PlistBuddy -c "Print :Name" "$PLIST_PATH" 2>/dev/null || echo "")
      PROFILE_UUID=$(/usr/libexec/PlistBuddy -c "Print :UUID" "$PLIST_PATH" 2>/dev/null || echo "")
      PROFILE_TEAM_ID=$(/usr/libexec/PlistBuddy -c "Print :TeamIdentifier:0" "$PLIST_PATH" 2>/dev/null || echo "")
      PROFILE_APP_ID=$(/usr/libexec/PlistBuddy -c "Print :Entitlements:application-identifier" "$PLIST_PATH" 2>/dev/null || echo "")
      PROFILE_BUNDLE_ID="${PROFILE_APP_ID#*.}"
      PROFILE_EXPIRY_RAW=$(/usr/libexec/PlistBuddy -c "Print :ExpirationDate" "$PLIST_PATH" 2>/dev/null || echo "")
      PROFILE_TYPE="Development"
      GETTASKALLOW=$(/usr/libexec/PlistBuddy -c "Print :Entitlements:get-task-allow" "$PLIST_PATH" 2>/dev/null || echo "")
      if [ "$GETTASKALLOW" = "false" ]; then
        PROFILE_TYPE="Distribution (App Store / Ad Hoc / Enterprise)"
      fi

      echo "Name:              ${PROFILE_NAME:-(not present)}"
      echo "UUID:               ${PROFILE_UUID:-(not present)}"
      echo "Team ID:            ${PROFILE_TEAM_ID:-(not present)}"
      echo "Bundle ID:          ${PROFILE_BUNDLE_ID:-(not present)}"
      echo "Type (inferred):    $PROFILE_TYPE"
      echo "Expires:             ${PROFILE_EXPIRY_RAW:-not present}"
      echo
      note "- Name: \`${PROFILE_NAME:-not present}\`, Type: $PROFILE_TYPE, Team: \`${PROFILE_TEAM_ID:-not present}\`, Bundle: \`${PROFILE_BUNDLE_ID:-not present}\`"

      # ---- Expiry check ----
      if [ -n "$PROFILE_EXPIRY_RAW" ]; then
        EXPIRY_EPOCH=$(date -j -f "%a %b %d %T %Z %Y" "$PROFILE_EXPIRY_RAW" "+%s" 2>/dev/null || echo "")
        NOW_EPOCH=$(date "+%s")
        if [ -n "$EXPIRY_EPOCH" ]; then
          DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))
          if [ "$DAYS_LEFT" -lt 0 ]; then
            echo "FAIL  This profile expired $(( -DAYS_LEFT )) day(s) ago. Generate a new one"
            echo "      from developer.apple.com/account > Profiles, download it, and"
            echo "      re-run this check (or re-encode it for your CI secret)."
            note "FAIL — profile expired $(( -DAYS_LEFT )) day(s) ago."
            FAILED=1
          elif [ "$DAYS_LEFT" -lt 30 ]; then
            echo "WARN  This profile expires in $DAYS_LEFT day(s) — worth renewing soon"
            echo "      so a build doesn't unexpectedly fail later."
            note "WARN — profile expires in $DAYS_LEFT day(s)."
            WARNED=1
          else
            echo "OK    Profile is valid for another $DAYS_LEFT day(s)."
            note "OK — profile valid for $DAYS_LEFT more day(s)."
          fi
        fi
      fi
      echo

      # ---- Team ID check ----
      if [ -n "$EXPECTED_TEAM_ID" ]; then
        if [ -z "$PROFILE_TEAM_ID" ]; then
          echo "WARN  Couldn't read a Team ID from the profile to compare against"
          echo "      --expected-team-id $EXPECTED_TEAM_ID."
          WARNED=1
        elif [ "$PROFILE_TEAM_ID" != "$EXPECTED_TEAM_ID" ]; then
          echo "FAIL  Profile's Team ID ($PROFILE_TEAM_ID) doesn't match the"
          echo "      Team ID you expected ($EXPECTED_TEAM_ID)."
          echo "      This usually means the profile was generated under a different"
          echo "      Apple Developer team than the one you think you're signing"
          echo "      with — find your real Team ID at developer.apple.com/account"
          echo "      under Membership, and make sure it's the profile's own team."
          note "FAIL — Team ID mismatch ($PROFILE_TEAM_ID vs expected $EXPECTED_TEAM_ID)."
          FAILED=1
        else
          echo "OK    Profile's Team ID matches the expected Team ID."
        fi
        echo
      fi

      # ---- Bundle ID check ----
      if [ -n "$EXPECTED_BUNDLE_ID" ]; then
        if [ -z "$PROFILE_BUNDLE_ID" ]; then
          echo "WARN  Couldn't read a bundle ID from the profile to compare against"
          echo "      --expected-bundle-id $EXPECTED_BUNDLE_ID."
          WARNED=1
        elif [ "$PROFILE_BUNDLE_ID" != "$EXPECTED_BUNDLE_ID" ] && [ "$PROFILE_BUNDLE_ID" != "*" ]; then
          echo "FAIL  Profile's bundle ID ($PROFILE_BUNDLE_ID) doesn't match the"
          echo "      bundle ID you expected ($EXPECTED_BUNDLE_ID)."
          echo "      Double-check the App ID you registered at developer.apple.com"
          echo "      uses the exact same bundle ID as your Xcode project, and that"
          echo "      this is actually the profile meant for that App ID."
          note "FAIL — bundle ID mismatch ($PROFILE_BUNDLE_ID vs expected $EXPECTED_BUNDLE_ID)."
          FAILED=1
        else
          echo "OK    Profile's bundle ID matches (or the profile is a wildcard '*'"
          echo "      App ID, which covers any bundle ID)."
        fi
        echo
      fi

      # ---- Certificate cross-check (the hard one) ----
      if [ -n "$CERT_PATH" ]; then
        if [ ! -f "$CERT_PATH" ]; then
          echo "FAIL  --cert was given ($CERT_PATH) but that file doesn't exist."
          note "FAIL — --cert path doesn't exist."
          FAILED=1
        else
          CERT_PEM="$(mktemp -t signing-doctor-cert).pem"
          if openssl pkcs12 -in "$CERT_PATH" -clcerts -nokeys -passin "pass:${CERT_PASSWORD}" -out "$CERT_PEM" -legacy 2>/dev/null \
            || openssl pkcs12 -in "$CERT_PATH" -clcerts -nokeys -passin "pass:${CERT_PASSWORD}" -out "$CERT_PEM" 2>/dev/null; then

            CERT_SUBJECT=$(openssl x509 -in "$CERT_PEM" -noout -subject 2>/dev/null || echo "")
            CERT_EXPIRY=$(openssl x509 -in "$CERT_PEM" -noout -enddate 2>/dev/null | sed 's/notAfter=//')
            CERT_FINGERPRINT=$(openssl x509 -in "$CERT_PEM" -noout -fingerprint -sha1 2>/dev/null | sed 's/^.*=//')

            echo "Certificate subject: ${CERT_SUBJECT:-not present}"
            echo "Certificate expires:  ${CERT_EXPIRY:-not present}"
            echo

            case "$CERT_SUBJECT" in
              *"Apple Distribution"*|*"iPhone Distribution"*)
                echo "OK    This looks like a distribution certificate (App Store / Ad Hoc)." ;;
              *"Apple Development"*|*"iPhone Developer"*)
                echo "WARN  This looks like a DEVELOPMENT certificate, not a distribution"
                echo "      one — fine for local device testing, but TestFlight/App Store"
                echo "      uploads need an Apple Distribution certificate instead."
                WARNED=1 ;;
              *)
                echo "WARN  Couldn't tell from the subject whether this is a development"
                echo "      or distribution certificate." ;;
            esac
            echo

            # Does this cert's fingerprint appear among the profile's embedded certs?
            FOUND_MATCH=0
            DEVCERT_COUNT=$(security cms -D -i "$PROFILE_PATH" 2>/dev/null | plutil -extract DeveloperCertificates raw - 2>/dev/null || echo "0")
            if [ "$DEVCERT_COUNT" -gt 0 ] 2>/dev/null; then
              i=0
              while [ "$i" -lt "$DEVCERT_COUNT" ]; do
                DER_TMP="$(mktemp -t signing-doctor-embedded-cert).der"
                plutil -extract "DeveloperCertificates.$i" raw -o "$DER_TMP" "$PLIST_PATH" >/dev/null 2>&1
                EMBEDDED_FP=$(openssl x509 -inform DER -in "$DER_TMP" -noout -fingerprint -sha1 2>/dev/null | sed 's/^.*=//')
                rm -f "$DER_TMP"
                if [ -n "$EMBEDDED_FP" ] && [ "$EMBEDDED_FP" = "$CERT_FINGERPRINT" ]; then
                  FOUND_MATCH=1
                fi
                i=$((i + 1))
              done
            fi

            if [ "$FOUND_MATCH" = "1" ]; then
              echo "OK    Your certificate's fingerprint matches one of the certificates"
              echo "      embedded in this provisioning profile — they're a real pair."
              note "OK — certificate/profile pairing confirmed."
            else
              echo "FAIL  Your certificate's fingerprint does NOT match any certificate"
              echo "      embedded in this provisioning profile. A profile only trusts"
              echo "      the specific certificate(s) it was generated against — this is"
              echo "      almost always caused by regenerating one of the two (a new"
              echo "      cert after the old one expired, or vice versa) without"
              echo "      regenerating the other to match. Re-download BOTH the"
              echo "      certificate and the provisioning profile fresh from"
              echo "      developer.apple.com/account at the same time and re-check."
              note "FAIL — certificate does not match any certificate embedded in the profile."
              FAILED=1
            fi
            rm -f "$CERT_PEM"
          else
            echo "FAIL  Couldn't unlock $CERT_PATH with the password given via"
            echo "      --cert-password. Either the password is wrong, or this isn't a"
            echo "      valid .p12 file."
            note "FAIL — couldn't unlock the .p12 with the given password."
            FAILED=1
          fi
        fi
        echo
      fi

      rm -f "$PLIST_PATH"
    fi
  fi
  echo
fi

# ======================================================================
# Android: release keystore
# ======================================================================
if [ -n "$ANDROID_KEYSTORE_PATH" ]; then
  echo "------------------------------------------------------------------"
  echo " Android — $ANDROID_KEYSTORE_PATH (alias: $ANDROID_KEY_ALIAS)"
  echo "------------------------------------------------------------------"
  note "### Android — \`$ANDROID_KEYSTORE_PATH\` (alias: \`$ANDROID_KEY_ALIAS\`)"

  if [ ! -f "$ANDROID_KEYSTORE_PATH" ]; then
    echo "Error: no file found at $ANDROID_KEYSTORE_PATH" >&2
    note "FAIL — keystore file not found."
    FAILED=1
  elif ! command -v keytool >/dev/null 2>&1; then
    echo "FAIL  The 'keytool' command isn't available — it ships with any JDK."
    echo "      Install a JDK (e.g. via your OS package manager, or use a"
    echo "      GitHub Actions runner with actions/setup-java already run)."
    note "FAIL — \`keytool\` isn't available (needs a JDK)."
    FAILED=1
  else
    KEYTOOL_OUT="$(keytool -list -v -keystore "$ANDROID_KEYSTORE_PATH" \
      -storepass "$ANDROID_KEYSTORE_PASSWORD" -alias "$ANDROID_KEY_ALIAS" 2>&1)"
    KEYTOOL_STATUS=$?

    if [ "$KEYTOOL_STATUS" -ne 0 ]; then
      echo "FAIL  Couldn't open this keystore with the given password/alias."
      echo "      Either --android-keystore-password is wrong, or --android-key-alias"
      echo "      ($ANDROID_KEY_ALIAS) doesn't match the alias this keystore was"
      echo "      created with — the default from ANDROID.md's setup command is"
      echo "      \"upload\", but you may have chosen a different one with -alias"
      echo "      when you ran keytool -genkeypair originally."
      echo
      echo "      keytool's own error:"
      echo "$KEYTOOL_OUT" | sed 's/^/      /'
      note "FAIL — couldn't open the keystore (wrong password, or wrong alias)."
      FAILED=1
    else
      KEY_ALGORITHM=$(echo "$KEYTOOL_OUT" | grep -m1 -i "Signature algorithm name" | sed 's/^.*: *//')
      KEY_SIZE=$(echo "$KEYTOOL_OUT" | grep -m1 -Eo '\b[0-9]{3,5}-bit\b' | head -1)
      VALID_LINE=$(echo "$KEYTOOL_OUT" | grep -m1 "Valid from:")

      echo "Alias:              $ANDROID_KEY_ALIAS"
      echo "Signature algorithm: ${KEY_ALGORITHM:-not present}"
      echo "Key size:            ${KEY_SIZE:-not reported by this keytool version}"
      echo
      note "- Alias: \`$ANDROID_KEY_ALIAS\`, Algorithm: ${KEY_ALGORITHM:-not present}"

      case "$KEY_ALGORITHM" in
        *SHA1*)
          echo "WARN  This key uses a SHA1-based signature algorithm — Google Play"
          echo "      has been moving away from SHA1 for new app signing keys."
          echo "      Not necessarily broken for an existing app, but worth knowing"
          echo "      if you're about to generate a brand-new keystore instead."
          WARNED=1 ;;
      esac

      # ---- Expiry check (parse "Valid from: <date> until: <date>") ----
      if [ -n "$VALID_LINE" ]; then
        UNTIL_RAW=$(echo "$VALID_LINE" | sed -n 's/.*until: //p')
        echo "Valid until:         ${UNTIL_RAW:-not present}"
        echo
        if [ -n "$UNTIL_RAW" ]; then
          EXPIRY_EPOCH=$(date -d "$UNTIL_RAW" "+%s" 2>/dev/null \
            || date -j -f "%a %b %d %T %Z %Y" "$UNTIL_RAW" "+%s" 2>/dev/null \
            || echo "")
          NOW_EPOCH=$(date "+%s")
          if [ -n "$EXPIRY_EPOCH" ]; then
            DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))
            if [ "$DAYS_LEFT" -lt 0 ]; then
              echo "FAIL  This signing key expired $(( -DAYS_LEFT )) day(s) ago. Google Play"
              echo "      will reject any update signed with an expired key — see"
              echo "      Google's key-upgrade process (Play Console > App integrity)"
              echo "      if this is a live app, since you generally can't just"
              echo "      generate a fresh keystore for an app already on Play."
              note "FAIL — signing key expired $(( -DAYS_LEFT )) day(s) ago."
              FAILED=1
            elif [ "$DAYS_LEFT" -lt 365 ]; then
              echo "WARN  This signing key expires in $DAYS_LEFT day(s). Google Play"
              echo "      recommends keys valid for 25+ years precisely so this never"
              echo "      comes up in practice — if you're this close, plan ahead with"
              echo "      Google Play's key-upgrade process well before it lapses."
              note "WARN — signing key expires in $DAYS_LEFT day(s)."
              WARNED=1
            else
              echo "OK    Signing key is valid for another $DAYS_LEFT day(s)."
              note "OK — signing key valid for $DAYS_LEFT more day(s)."
            fi
          else
            echo "WARN  Couldn't parse an expiry date from keytool's output to check it."
            WARNED=1
          fi
        fi
      fi
    fi
  fi
  echo
fi

echo "=================================================================="
if [ "$FAILED" = "1" ]; then
  RESULT_LINE=" Result: FAILED — see the FAIL lines above for what to fix."
  echo "$RESULT_LINE"
  RESULT_MD="**Result: FAILED** — see the FAIL lines above for what to fix."
  RESULT_CODE=1
elif [ "$WARNED" = "1" ]; then
  RESULT_LINE=" Result: PASSED WITH WARNINGS — see the WARN lines above."
  echo "$RESULT_LINE"
  RESULT_MD="**Result: passed with warnings** — see the WARN lines above."
  RESULT_CODE=0
else
  RESULT_LINE=" Result: Everything checked looks consistent."
  echo "$RESULT_LINE"
  RESULT_MD="**Result: everything checked looks consistent.**"
  RESULT_CODE=0
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## signing-doctor report"
    echo
    for line in "${SUMMARY_LINES[@]}"; do
      echo "$line"
      echo
    done
    echo "$RESULT_MD"
  } >> "$GITHUB_STEP_SUMMARY"
fi

exit "$RESULT_CODE"
