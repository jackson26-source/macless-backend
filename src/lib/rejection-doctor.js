// rejection-doctor.js — server-side port of macless.dev's client-side
// Rejection Doctor (site/assets/rejection-doctor.js in the macless-site
// repo). CATEGORIES is copied verbatim from the live tool so the wizard's
// inline diagnosis never drifts from what the free web tool says — same
// source of truth, just callable from the wizard flow instead of requiring
// a buyer to copy-paste into a separate page.
//
// NOTE for whoever maintains this: if macless-site's rejection-doctor.js
// gets new categories, copy the updated CATEGORIES array back in here too.
// This duplication (rather than requiring the wizard to fetch the live
// site) is deliberate — the wizard has to work offline / without hitting
// any Macless-hosted endpoint, per the zero-hosting-cost architecture.

const CATEGORIES = [
  {
    guideline: "2.1",
    aliases: ["2\\.1\\s*\\(a\\)", "2\\.1a", "app completeness"],
    title: "App Completeness — crashes, bugs, or an incomplete build",
    keywords: ["crash", "crashed", "unresponsive", "freeze", "froze", "bug", "unable to complete your review", "incomplete", "placeholder"],
    explain: "Apple's reviewer hit a crash, a frozen screen, or something that just didn't work while testing your build, or the submission itself was incomplete (missing metadata, a broken URL, placeholder text still in it).",
    fix: "Install the exact build Apple reviewed on a real device (not just the Simulator) and walk every screen yourself. If your app needs a login, include a working demo account in the App Review Information notes, reviewers can't test what they can't get into. If a backend/API is involved, make sure it's actually live and reachable, a dev server that's down at review time reads as \"crashes.\""
  },
  {
    guideline: "2.1",
    aliases: ["demo account", "reviewer.*(log ?in|access)", "unable to (sign ?in|log ?in)"],
    title: "App Completeness — reviewer couldn't get into the app",
    keywords: ["demo account", "sign in", "log in", "login credentials", "test account", "reviewer notes"],
    explain: "The reviewer couldn't access a part of your app that needs an account, a subscription, or some other gate, and you didn't give them a way in.",
    fix: "Add working demo credentials (or a review-mode toggle) in App Store Connect's App Review Information notes, not just in the app itself. If the account needs specific data to show real functionality (an active subscription, sample content), make sure the demo account actually has it."
  },
  {
    guideline: "2.1(b)",
    aliases: ["2\\.1\\s*\\(b\\)", "in-app purchase.*(not|isn't).*(functio|visible|work)"],
    title: "App Completeness — in-app purchases not working or not visible",
    keywords: ["in-app purchase", "iap", "purchase could not be completed", "unable to locate", "products not loading"],
    explain: "Apple couldn't find, load, or complete one of your listed in-app purchases during review. This usually means the products aren't approved/ready in App Store Connect yet, or the app can't actually reach StoreKit correctly at review time.",
    fix: "Confirm every IAP product is in \"Ready to Submit\" status in App Store Connect (not just created), submitted alongside the build, and tested end-to-end against the sandbox environment before resubmitting. If an IAP is mentioned in your review notes but doesn't exist yet, remove the mention or finish setting it up first."
  },
  {
    guideline: "2.3.1",
    aliases: ["2\\.3\\.1", "hidden.*(feature|functionality)", "undocumented"],
    title: "Accurate Metadata — hidden or undocumented features",
    keywords: ["hidden feature", "undisclosed", "undocumented", "not described in your review notes"],
    explain: "Your app does something Apple's reviewer found that wasn't described anywhere in your app's metadata or review notes, this is treated as a transparency problem even if the feature itself is harmless.",
    fix: "List every non-obvious feature explicitly in the App Store Connect \"Notes for Review\" box, generic descriptions get rejected too, be specific about what it does and how to reach it. If a feature is genuinely dormant/unfinished, remove it from this build rather than leaving it half-wired."
  },
  {
    guideline: "2.3.3",
    aliases: ["2\\.3\\.3", "screenshot"],
    title: "Accurate Metadata — screenshots don't show the app in use",
    keywords: ["screenshot", "splash screen", "login screen only", "title screen"],
    explain: "Your App Store screenshots show a splash, login, or title screen instead of the actual app being used, Apple wants screenshots to reflect the real in-use experience.",
    fix: "Replace at least most screenshots with real captures of core screens in use, not just the entry point. Text/image overlays and callouts are fine as long as the underlying screenshot is a real screen from the app."
  },
  {
    guideline: "2.3.7",
    aliases: ["2\\.3\\.7", "app name", "keyword.*(stuff|spam)"],
    title: "Accurate Metadata — app name or keywords",
    keywords: ["app name", "subtitle", "keyword", "trademarked", "30-character"],
    explain: "Your app's name, subtitle, or keyword list is packed with trademarked terms, other apps' names, pricing info, or irrelevant phrases meant to game search.",
    fix: "Keep the app name to a real, distinct name (30-character limit), move any descriptive phrase into the subtitle, and remove any competitor names, price mentions, or unrelated popular search terms from the keyword field."
  },
  {
    guideline: "3.1.1",
    aliases: ["3\\.1\\.1", "external.*(payment|purchase) link", "bypass.*(in-app|iap)"],
    title: "Payments — must use In-App Purchase, not an external link",
    keywords: ["in-app purchase", "external payment", "pay outside the app", "stripe", "paypal link"],
    explain: "Your app unlocks digital content, features, or a subscription through something other than Apple's own In-App Purchase system, a website checkout link, an external payment flow, a promo code redemption for digital goods, etc.",
    fix: "Route any purchase that unlocks in-app digital content or functionality through StoreKit / In-App Purchase. Selling physical goods or services delivered outside the app (this generally doesn't apply to Macless, which is sold entirely off-app on your own website, not through an iOS app listing) is a separate, allowed case, if your rejection is about something like that specifically, the fix is different, read Guideline 3.1.3 directly rather than assuming this applies."
  },
  {
    guideline: "3.1.2",
    aliases: ["3\\.1\\.2", "subscription.*(unclear|value|term)"],
    title: "Payments — subscription terms or value unclear",
    keywords: ["subscription", "auto-renew", "free trial", "recurring"],
    explain: "Apple wants clearer disclosure of what a subscription actually includes, its price, length, and renewal terms, before the user taps to buy, or thinks the subscription doesn't provide enough ongoing value to justify being a subscription rather than a one-time purchase.",
    fix: "Show subscription length, price, and what's included clearly before the purchase screen, App Store Connect's own subscription description field should also spell this out plainly. If your product is really a one-time unlock, consider whether it should be a non-consumable IAP instead of a subscription."
  },
  {
    guideline: "4.1",
    aliases: ["4\\.1\\s*\\(a\\)", "4\\.1a", "copycat", "spam.*(app|category)"],
    title: "Design — too similar to an existing app (copycat)",
    keywords: ["copycat", "clone", "similar to an existing", "repackaged", "minor changes"],
    explain: "Apple's reviewer thinks your app is a close copy of a popular app, or a repackaged version of a common app type with only cosmetic differences.",
    fix: "Point to specific, concrete features that make your app meaningfully different in the App Review notes, generic descriptions like \"it's better designed\" won't help. If the app really is a common category (flashlight, timer, wallpaper, etc.), Apple explicitly wants a real functional improvement, not just a different look, before it'll approve a new entry."
  },
  {
    guideline: "4.2",
    aliases: ["4\\.2(?!\\.\\d)\\b", "minimum functionality", "website wrapper", "webview"],
    title: "Design — minimum functionality (feels like a wrapped website)",
    keywords: ["minimum functionality", "website wrapper", "webview", "not app-like"],
    explain: "Apple thinks your app doesn't do enough beyond loading a website in a WebView, it wants something that feels native and \"app-like,\" with real UI, not just a browser wrapper.",
    fix: "Add native functionality that wouldn't work as well as a plain website: push notifications, offline support, native navigation/gestures, device integrations (camera, share sheet, widgets). The more of your UI that's actual native code rather than an embedded web page, the stronger this argument gets."
  },
  {
    guideline: "4.2.3",
    aliases: ["4\\.2\\.3", "requires.*(another app|companion app)", "app independence"],
    title: "Design — app requires another app or account to function",
    keywords: ["requires another app", "companion app", "doesn't work standalone", "install another app"],
    explain: "Your app doesn't do anything useful on its own, it needs a separate app, hardware pairing, or an account created somewhere else before a reviewer can test any real functionality.",
    fix: "Make sure the reviewer can get to genuine functionality without a separate app install. If hardware pairing is genuinely required (a companion app for a physical device), say so explicitly in the review notes and, if possible, provide a way to demo the experience without the physical hardware present."
  },
  {
    guideline: "4.3",
    aliases: ["4\\.3\\s*\\(b\\)", "4\\.3b", "spam"],
    title: "Design — Spam (too similar to your own or others' existing apps)",
    keywords: ["spam", "multiple bundle ids", "indistinguishable from", "low effort"],
    explain: "Either you've submitted near-duplicate apps under different bundle IDs (separate apps per city or team instead of one app with variations inside it), or your app falls into a category Apple treats as low-effort by default (flashlight, wallpaper, fortune-telling, etc.) without enough differentiation.",
    fix: "If it's the multiple-bundle-IDs case: consolidate into one app and use in-app purchase or content variations instead of separate App Store listings. If it's the low-effort-category case: this is the same fix as Guideline 4.1 above, add specific, real functionality and describe it plainly in the review notes."
  },
  {
    guideline: "5.1.1",
    aliases: ["5\\.1\\.1(?!\\s*\\()", "privacy policy"],
    title: "Privacy — missing or broken privacy policy link",
    keywords: ["privacy policy", "privacy policy link", "privacy policy url"],
    explain: "Your privacy policy link is missing, broken, or doesn't actually describe what data your app collects. Apple checks the App Store Connect metadata link and the in-app link separately, both have to work.",
    fix: "Host a real, specific privacy policy (not a generic template) that states what data you collect, why, and how a user can request deletion. Link it in both App Store Connect's App Privacy section and somewhere reachable inside the app itself (usually Settings), and click the link yourself before resubmitting, a 404 here is a very common, easy-to-miss cause."
  },
  {
    guideline: "5.1.1(v)",
    aliases: ["5\\.1\\.1\\s*\\(v\\)", "account deletion", "delete.*account"],
    title: "Privacy — no way to delete your account in the app",
    keywords: ["account deletion", "delete account", "delete my account"],
    explain: "Your app lets someone create an account but doesn't offer a way to delete it from inside the app. Apple explicitly does not accept an email-support-request workaround for this.",
    fix: "Add a real, functional \"Delete Account\" control somewhere reachable in the app (typically Settings), it needs to actually remove the account and associated data, not just log the user out or open an email draft."
  },
  {
    guideline: "5.1.2",
    aliases: ["5\\.1\\.2", "tracking", "app tracking transparency", "\\batt\\b"],
    title: "Privacy — tracking or third-party data sharing without proper consent",
    keywords: ["app tracking transparency", "att prompt", "idfa", "third-party sdk", "undisclosed sharing"],
    explain: "Your app (or an SDK inside it) shares data with a third party for tracking or advertising purposes without the required App Tracking Transparency prompt, or without disclosing it accurately in your App Privacy nutrition label.",
    fix: "Audit every third-party SDK for what it actually collects (ad networks and analytics SDKs are the usual culprits), make sure your App Privacy answers in App Store Connect match reality, and show Apple's ATT permission prompt before any cross-app/cross-site tracking happens, not after."
  },
  {
    guideline: "5.1.4",
    aliases: ["5\\.1\\.4", "kids category", "children.*(privacy|data)"],
    title: "Privacy — Kids category or child-data compliance",
    keywords: ["kids category", "coppa", "children's privacy", "parental gate"],
    explain: "Your app is in, or reads as intended for, the Kids category, and either includes third-party analytics/advertising it shouldn't, is missing a parental gate around something that needs one, or doesn't fully comply with children's privacy law (COPPA and similar).",
    fix: "Remove third-party analytics/advertising SDKs from anything a child could reach without a parental gate, add a real parental gate (usually a simple math problem, not just a button) in front of any external link, purchase, or data collection, and make sure your privacy policy specifically addresses children's data."
  },
  {
    guideline: "5.1.5",
    aliases: ["5\\.1\\.5", "location services"],
    title: "Privacy — location services used without a clear enough purpose",
    keywords: ["location services", "location data", "background location"],
    explain: "Your app requests location access but Apple's reviewer couldn't tell why it needs it, especially background location, which gets extra scrutiny.",
    fix: "Write a specific, plain-English purpose string for each location permission (Xcode's `NSLocationWhenInUseUsageDescription` / `NSLocationAlwaysAndWhenInUseUsageDescription`), explaining exactly what feature needs it. If you're requesting \"Always\" access, be ready to justify why \"When In Use\" isn't enough, that's usually the real question being asked."
  },

  // ---- Expanded 2026-08-25: broadened from ~19 categories toward full
  // guideline coverage (Apple's own subsection index has ~130 entries;
  // the ones below are the realistic set an indie iOS/Android shipper
  // actually hits — Mac App Store sandboxing internals, ARKit specifics,
  // and cryptocurrency-exchange-licensing edge cases are deliberately
  // left out as near-zero-probability for this audience). ----

  // Section 1 — Safety
  {
    guideline: "1.1.1",
    aliases: ["1\\.1\\.1", "defamatory", "discriminat", "mean.?spirited", "hate speech"],
    title: "Objectionable Content — defamatory, discriminatory, or mean-spirited",
    keywords: ["defamatory", "discriminatory", "mean-spirited", "hate speech", "bullying", "harassment"],
    explain: "Apple found content in your app (user-submitted or your own) that targets a specific individual or group, or that a reviewer read as demeaning based on a protected characteristic.",
    fix: "Remove or moderate the specific content the rejection points to. If it's user-generated, this usually means your moderation/reporting tools weren't enough, see the User-Generated Content fix below, not just deleting the one flagged item."
  },
  {
    guideline: "1.1.4",
    aliases: ["1\\.1\\.4", "pornographic", "overtly sexual", "explicit sexual"],
    title: "Objectionable Content — overtly sexual or pornographic material",
    keywords: ["pornographic", "explicit content", "sexual content", "nudity"],
    explain: "Apple's reviewer found sexually explicit content in your app, screenshots, or preview media. This applies even if the content is opt-in or age-gated elsewhere on the internet.",
    fix: "Remove the flagged content entirely, App Review does not accept age-gating as a workaround for pornographic material, that's a hard line regardless of your app's overall rating."
  },
  {
    guideline: "1.1.6",
    aliases: ["1\\.1\\.6", "trick.?(functionality|app)", "joke functionality", "false information"],
    title: "Objectionable Content — misleading or joke functionality",
    keywords: ["prank", "joke app", "fake functionality", "misleading feature"],
    explain: "Your app claims to do something it doesn't actually do, or is presented as a joke/prank in a way Apple considers deceptive rather than clearly-labeled entertainment.",
    fix: "Either make the feature real, or make the joke framing unmistakable in both the app itself and its App Store description, no functionality should be implied that doesn't exist."
  },
  {
    guideline: "1.2",
    aliases: ["1\\.2(?!\\.\\d)\\b", "user.?generated content", "content moderation", "report.*(user|content)"],
    title: "User-Generated Content — missing moderation tools",
    keywords: ["user-generated content", "ugc", "content moderation", "report abuse", "block user"],
    explain: "Your app lets users post, share, or message freely, and Apple didn't find the moderation infrastructure it now requires for that: filtering, reporting, blocking, and a way to remove abusive users.",
    fix: "Add, at minimum: a method for users to flag objectionable content, a way to block abusive users, published content standards, and a mechanism for you to act on reports and remove violating content/users promptly. Describe all of this explicitly in your App Review notes since reviewers can't always find it by exploring the UI alone."
  },
  {
    guideline: "1.4.1",
    aliases: ["1\\.4\\.1", "medical.*(inaccura|unsupported|claim)", "health claim"],
    title: "Physical Harm — medical app with unsupported claims or inaccurate data",
    keywords: ["medical claim", "diagnosis", "treatment recommendation", "unsupported health"],
    explain: "Your app makes a medical or health claim, or presents calculated health data (dosages, diagnoses, risk scores), that Apple couldn't verify as accurate or properly sourced.",
    fix: "Cite the clinical source or regulatory body behind any medical claim directly in your App Review notes, and make sure any calculator/diagnostic feature has a visible disclaimer that it doesn't replace professional medical advice. Apps offering drug dosage calculations specifically need to come from a recognized medical institution, pharmaceutical company, or a legitimate medical app developer."
  },
  {
    guideline: "1.5",
    aliases: ["1\\.5(?!\\.\\d)\\b", "developer.*(contact|information)", "support (url|link) (broken|missing|invalid)"],
    title: "Developer Information — missing or broken contact details",
    keywords: ["support url", "developer contact", "functional email", "support link broken"],
    explain: "App Store Connect's support URL, marketing URL, or contact email either doesn't work or doesn't lead somewhere a user (or Apple) can actually reach you.",
    fix: "Test every URL in App Store Connect's App Information section by clicking it yourself, and make sure the support contact is a real, monitored email or working contact form, not a placeholder."
  },

  // Section 2 — Performance
  {
    guideline: "2.2",
    aliases: ["2\\.2(?!\\.\\d)\\b", "beta version", "beta.*(feature|marked)", "testflight only"],
    title: "Beta Testing — beta/trial functionality submitted outside TestFlight",
    keywords: ["beta version", "beta feature", "trial version", "demo mode only"],
    explain: "Your submission includes beta-labeled functionality, or is itself a beta/trial build, on the regular App Store. Apple requires all beta testing to go through TestFlight, not a live App Store listing.",
    fix: "Remove any \"beta\" labeling and half-finished features from the production build, or move that testing to TestFlight and resubmit the App Store listing as the finished version."
  },
  {
    guideline: "2.3.1(b)",
    aliases: ["2\\.3\\.1\\s*\\(b\\)", "dishonest marketing", "false claim", "misleading (description|marketing)"],
    title: "Accurate Metadata — dishonest marketing or false claims",
    keywords: ["dishonest marketing", "false claims", "misleading description", "exaggerated claim"],
    explain: "Your App Store description, screenshots, or preview video make a claim about the app (features, results, awards, rankings) that Apple couldn't substantiate.",
    fix: "Remove or soften any claim you can't back up with evidence, and be ready to provide substantiation for anything you keep (press mentions, award names, measured results) directly in your App Review notes."
  },
  {
    guideline: "2.3.2",
    aliases: ["2\\.3\\.2", "in-app purchase.*(not disclosed|missing from|metadata)"],
    title: "Accurate Metadata — in-app purchase not disclosed in the listing",
    keywords: ["iap not disclosed", "purchase not listed", "missing iap description"],
    explain: "Your app has in-app purchases that aren't described anywhere in the App Store listing itself, users shouldn't discover a paywall as a surprise.",
    fix: "Add a plain description of what each IAP unlocks to your app description or the dedicated In-App Purchases metadata field in App Store Connect."
  },
  {
    guideline: "2.3.5",
    aliases: ["2\\.3\\.5", "wrong category", "inappropriate category", "category.*(mismatch|inaccurate)"],
    title: "Accurate Metadata — inaccurate App Store category",
    keywords: ["wrong category", "inappropriate category", "category selection"],
    explain: "Apple thinks the primary category you selected doesn't match what your app actually does, sometimes used to game category-specific charts.",
    fix: "Pick the category that most accurately reflects the app's core function, not the one with the least competition, this is usually a quick fix in App Store Connect with no rebuild required."
  },
  {
    guideline: "2.3.6",
    aliases: ["2\\.3\\.6", "age rating.*(inaccura|wrong|inconsistent)"],
    title: "Accurate Metadata — age rating doesn't match actual content",
    keywords: ["age rating", "content rating mismatch", "age rating inaccurate"],
    explain: "The age rating questionnaire answers in App Store Connect don't match what the app actually contains or does (this is common when user-generated content or web content isn't accounted for).",
    fix: "Redo the age rating questionnaire honestly, factoring in anything users can post or access (including web views and third-party content), then resubmit, no rebuild needed for this one either, it's metadata-only."
  },
  {
    guideline: "2.3.9",
    aliases: ["2\\.3\\.9", "rights to (use|the) material", "unauthorized.*(icon|screenshot|image)"],
    title: "Accurate Metadata — no rights to icon/screenshot material",
    keywords: ["rights to materials", "unauthorized image", "copyrighted screenshot"],
    explain: "Apple believes your app icon, screenshots, or preview video use images or content you don't have the rights to.",
    fix: "Replace any third-party or stock imagery you can't prove licensing for with original assets or content you can substantiate rights to, and keep the license/receipt handy in case Apple asks."
  },
  {
    guideline: "2.3.12",
    aliases: ["2\\.3\\.12", "what'?s new.*(unclear|generic|vague)"],
    title: "Accurate Metadata — vague or unhelpful \"What's New\" text",
    keywords: ["what's new", "release notes unclear", "generic release notes"],
    explain: "Your version release notes are too generic (\"bug fixes and improvements\" with nothing specific) for Apple to understand what actually changed, occasionally flagged on its own.",
    fix: "Write specific, real release notes for what changed in this version, even a short factual list is enough, generic boilerplate is what gets flagged."
  },
  {
    guideline: "2.4.1",
    aliases: ["2\\.4\\.1", "doesn'?t (run|work) on ipad", "ipad compat"],
    title: "Hardware Compatibility — iPhone app doesn't run properly on iPad",
    keywords: ["run on ipad", "ipad compatibility", "ipad layout broken"],
    explain: "Your app is set to run on iPad (even at iPhone size, scaled up) but breaks, crashes, or is unusable there.",
    fix: "Either test and fix the iPad experience at whatever size it's set to run, or, if it's genuinely iPhone-only functionality, restrict the target device family to iPhone only in your build settings so it's never offered on iPad in the first place."
  },
  {
    guideline: "2.4.2",
    aliases: ["2\\.4\\.2", "excessive (battery|power|device) (drain|usage|strain)"],
    title: "Hardware Compatibility — excessive battery drain or device strain",
    keywords: ["battery drain", "excessive cpu", "overheating", "power usage"],
    explain: "Apple's reviewer measured your app using noticeably more battery, CPU, or memory than its functionality justifies, often from a background task, polling loop, or unoptimized rendering left running.",
    fix: "Profile the app with Instruments (Energy Log and Time Profiler) around whatever screen or background task seems likely, look specifically for network polling, location updates, or animations that don't stop when the app is backgrounded or idle."
  },
  {
    guideline: "2.4.4",
    aliases: ["2\\.4\\.4", "restart.*(device|phone)", "system setting.*(without|unrelated)"],
    title: "Hardware Compatibility — changes device settings without permission",
    keywords: ["restart device", "system settings changed", "unrelated setting"],
    explain: "Your app modifies a system setting or prompts a device restart for something unrelated to its core function, without the user clearly asking for it.",
    fix: "Only touch system settings the user explicitly triggers for a feature they understand, and never force a restart, if a setting change is genuinely required, explain why in-context before requesting it."
  },
  {
    guideline: "2.5.1",
    aliases: ["2\\.5\\.1", "non.?public api", "private api"],
    title: "Software Requirements — uses non-public/private APIs",
    keywords: ["private api", "non-public api", "undocumented api"],
    explain: "Apple's static analysis flagged a call to a private or non-public API, this is a common false-positive source from third-party SDKs bundled into your app, not always your own code.",
    fix: "Check every third-party SDK/dependency for known private-API usage (search the rejection's specific symbol name plus your SDK list), update to a version that's been fixed, or remove the offending dependency. Apple's rejection email usually names the specific symbol, start there."
  },
  {
    guideline: "2.5.2",
    aliases: ["2\\.5\\.2", "download.*(execute|executable) code", "interpreted code", "downloadable code"],
    title: "Software Requirements — downloads or executes code at runtime",
    keywords: ["executable code", "downloaded code", "interpreted code", "remote code execution"],
    explain: "Apple thinks your app downloads and runs code after installation in a way that changes its core features or functionality outside of Apple's review, JavaScript inside a WebView displaying your own content is fine; downloading and executing new native logic is not.",
    fix: "If this is a WebView showing content you control, make that clear in App Review notes since it's an explicit, documented exception. If it's genuinely dynamic native code loading, that has to be removed, there's no workaround, it's a hard policy line."
  },
  {
    guideline: "2.5.4",
    aliases: ["2\\.5\\.4", "background (audio|location|task).*(misuse|not.*intended)", "multitasking"],
    title: "Software Requirements — background mode used for something it isn't for",
    keywords: ["background audio", "background location misuse", "background task"],
    explain: "Your app declares a background capability (audio, location, VoIP, etc.) but Apple's reviewer found it being used for a purpose that background mode isn't intended for, often just to keep the app alive.",
    fix: "Only request the specific background mode your feature genuinely needs, and make sure that capability is doing exactly what it says (background audio should be playing audio, not silently keeping the process alive for something else)."
  },
  {
    guideline: "2.5.6",
    aliases: ["2\\.5\\.6", "webkit", "third.?party (browser|rendering) engine"],
    title: "Software Requirements — web browsing doesn't use WebKit",
    keywords: ["webkit required", "custom browser engine", "third-party rendering engine"],
    explain: "Your app implements general web browsing using something other than WebKit (WKWebView), which Apple requires for any app that renders arbitrary web content.",
    fix: "Switch any general-purpose web browsing to WKWebView. Note this rule has real, documented carve-outs (the EU under the DMA, and JavaScript engines used for non-browsing purposes like a game scripting layer), if either applies, say so explicitly in your review notes rather than assuming the rejection is final."
  },

  // Section 3 — Business
  {
    guideline: "3.1.1(a)",
    aliases: ["3\\.1\\.1\\s*\\(a\\)", "external purchase link", "storekit external purchase"],
    title: "Payments — External Purchase Link entitlement misuse",
    keywords: ["external purchase link", "storekit external purchase entitlement"],
    explain: "Your app uses (or appears to use) Apple's External Purchase Link entitlement incorrectly, wrong region, missing disclosure sheet, or the entitlement wasn't actually approved for your app yet.",
    fix: "Confirm the entitlement is approved for your specific app and region in your developer account, and make sure the required disclosure sheet displays exactly as Apple's documentation specifies before the external link is followed."
  },
  {
    guideline: "3.1.2(a)",
    aliases: ["3\\.1\\.2\\s*\\(a\\)", "impermissible subscription", "subscription.*not (allowed|permitted)"],
    title: "Payments — subscription used for something Apple doesn't allow",
    keywords: ["impermissible subscription", "subscription not permitted"],
    explain: "Apple restricts auto-renewable subscriptions to specific permitted use cases (ongoing services, content libraries, etc.) and thinks yours doesn't qualify, a one-time-use feature sold as a recurring charge is the classic version of this.",
    fix: "If the underlying product is really a single unlock rather than an ongoing service, switch it to a non-consumable or consumable IAP instead of a subscription. If it genuinely is an ongoing service, make that value clearer in both the app and the subscription's App Store Connect description."
  },
  {
    guideline: "3.1.3(e)",
    aliases: ["3\\.1\\.3\\s*\\(e\\)", "goods and services outside the app", "physical goods"],
    title: "Payments — goods/services outside the app misclassified",
    keywords: ["goods and services outside the app", "physical good purchase"],
    explain: "Apple thinks something you're selling through an external checkout (like Macless's own off-app purchase flow) should actually be routed through In-App Purchase because it unlocks in-app digital functionality rather than a real external good or service.",
    fix: "Be explicit in App Review notes about exactly what's being purchased and where, physical goods, services consumed outside the app, and one-time software licenses purchased on your own website before install are the well-established exception this guideline carves out, cite it by name (3.1.3(e)) in your reply."
  },
  {
    guideline: "3.2.2",
    aliases: ["3\\.2\\.2", "manipulat.*(review|rating)", "incentiviz.*(review|rating)", "fake review"],
    title: "Other Business Model Issues — manipulating reviews or ratings",
    keywords: ["incentivized review", "fake review", "manipulate rating", "review gating"],
    explain: "Apple found your app offering a reward for a positive review/rating, filtering who sees the native review prompt based on their in-app sentiment, or otherwise gaming App Store ratings.",
    fix: "Use Apple's native `SKStoreReviewController` exactly as documented, no reward, no pre-filtering based on a user's answer to an in-app satisfaction question, and remove any \"rate us and get X\" mechanic."
  },

  // Section 4 — Design
  {
    guideline: "4.1(b)",
    aliases: ["4\\.1\\s*\\(b\\)", "impersonat"],
    title: "Design — impersonating another app or service",
    keywords: ["impersonating", "impersonation", "pretends to be"],
    explain: "Apple thinks your app's name, icon, or UI is close enough to an existing app or company that it could confuse a user into thinking it's official or affiliated.",
    fix: "Change whatever specific element (name, icon, color scheme, UI pattern) is causing the confusion, and make sure your app description doesn't imply an affiliation you don't have."
  },
  {
    guideline: "4.1(c)",
    aliases: ["4\\.1\\s*\\(c\\)", "unauthorized use of.*(icon|brand|name)"],
    title: "Design — unauthorized use of another developer's icon, brand, or name",
    keywords: ["unauthorized brand use", "trademark icon", "another developer's name"],
    explain: "Your app uses a name, icon, or branding that belongs to another developer or company without permission, a common trap when building an unofficial companion/fan app.",
    fix: "Rename and rebrand with something clearly your own, or if you genuinely have permission/a license, attach that documentation to your App Review notes."
  },
  {
    guideline: "4.2.2",
    aliases: ["4\\.2\\.2", "marketing material", "product catalog", "brochure app"],
    title: "Design — app is primarily a marketing catalog, not a real app",
    keywords: ["marketing material", "product catalog", "brochure"],
    explain: "Apple thinks your app is mostly a static product catalog or marketing brochure with little real interactive functionality, this overlaps with 4.2 (minimum functionality) but is specifically about catalog-style apps.",
    fix: "Add genuine interactive functionality beyond browsing a list of products/services, saved favorites, real search/filtering, account features, something a plain web catalog page wouldn't offer."
  },
  {
    guideline: "4.2.6",
    aliases: ["4\\.2\\.6", "template.*(app|generat)", "app generation service"],
    title: "Design — template-generated app not sufficiently customized",
    keywords: ["template app", "app builder generated", "insufficiently customized"],
    explain: "Your app was built from a template/app-generation service and Apple thinks it isn't customized enough to be a distinct product, this rule exists specifically to stop identical template output from flooding the App Store under different names.",
    fix: "Add real, app-specific functionality and content beyond what the template provides by default, generic template apps increasingly need the submitting developer to be the template provider itself, not an end customer of one, worth checking which category your setup falls into."
  },
  {
    guideline: "4.5.4",
    aliases: ["4\\.5\\.4", "push notification.*(opt.?in|marketing|spam)", "notification.*(ads|advertising)"],
    title: "Apple Sites and Services — push notifications used for ads without opt-in",
    keywords: ["push notification ads", "notification marketing", "unsolicited push"],
    explain: "Your app sends promotional/marketing push notifications without a clear opt-in, or uses push notifications to collect personal data in a way Apple doesn't allow.",
    fix: "Gate any promotional (non-transactional) push notifications behind an explicit, separate opt-in from your core notification permission, and never use a push payload to harvest personal data."
  },
  {
    guideline: "4.8",
    aliases: ["4\\.8(?!\\.\\d)\\b", "sign in with apple", "login service.*(limited|alternative)"],
    title: "Login Services — missing an equivalent limited-data-sharing option",
    keywords: ["sign in with apple", "third-party login", "social login"],
    explain: "Your app offers a third-party login option (Google, Facebook, etc.) but not Sign in with Apple, which Apple requires as an equivalent option whenever another third-party login exists.",
    fix: "Add Sign in with Apple alongside your existing login options, it needs to be offered with equal prominence, not buried below the others."
  },
  {
    guideline: "4.10",
    aliases: ["4\\.10", "monetiz.*(hardware|built.?in|os capability)"],
    title: "Design — charging for a capability the OS/hardware provides free",
    keywords: ["charging for flashlight", "monetizing built-in", "paywall for os feature"],
    explain: "Your app charges money to unlock something the device or iOS already provides for free (a flashlight toggle, screen recording, basic accessibility features).",
    fix: "Remove the charge for the built-in capability itself, if your app adds genuine extra value around it (a flashlight with programmable patterns, say), the paid version needs to be selling that specific extra functionality, not the underlying free capability."
  },

  // Section 5 — Legal
  {
    guideline: "5.1.1(ii)",
    aliases: ["5\\.1\\.1\\s*\\(ii\\)", "revoke.*(permission|consent)", "can'?t (turn off|withdraw) permission"],
    title: "Privacy — no way to revoke a previously granted permission",
    keywords: ["revoke permission", "withdraw consent", "turn off permission"],
    explain: "Your app requests a permission (contacts, health data, tracking) but doesn't give the user an in-app way to later turn that access back off or delete what was collected.",
    fix: "Add a settings screen where each granted permission's related data can be reviewed and deleted, and point users to iOS's own Settings > Privacy toggles for revoking the OS-level permission itself."
  },
  {
    guideline: "5.1.1(viii)",
    aliases: ["5\\.1\\.1\\s*\\(viii\\)", "compil(e|ing) personal (data|information)", "data broker"],
    title: "Privacy — compiling personal data from outside sources",
    keywords: ["data compilation", "personal data from external sources", "background check"],
    explain: "Your app builds profiles about people using data pulled from sources other than the user themselves (public records aggregation, social media scraping, background-check-style lookups) without those individuals' consent.",
    fix: "This is a hard policy line for apps built specifically to profile third parties without their consent, if your app has a legitimate, narrower use case (e.g. a business directory built from data the businesses themselves submitted), spell that distinction out explicitly in App Review notes."
  },
  {
    guideline: "5.1.2(iv)",
    aliases: ["5\\.1\\.2\\s*\\(iv\\)", "contacts.*(database|sell|resell)", "photos.*(database|sell)"],
    title: "Privacy — building a contacts/photos database for resale",
    keywords: ["sell contacts data", "contacts database", "resell photo data"],
    explain: "Your app collects Contacts or Photos data and Apple believes it's being aggregated into a database rather than used transiently for the feature the user asked for.",
    fix: "Use Contacts/Photos data only for the specific in-app feature the user invoked it for (e.g. \"find friends\"), don't retain or transmit it beyond that purpose, and say so explicitly in your privacy policy."
  },
  {
    guideline: "5.2",
    aliases: ["5\\.2(?!\\.\\d)\\b", "intellectual property", "copyright infringement", "trademark infringement"],
    title: "Legal — intellectual property infringement",
    keywords: ["intellectual property", "copyright infringement", "trademark infringement", "unauthorized content"],
    explain: "Apple received a complaint, or a reviewer noticed, that your app uses copyrighted or trademarked material (music, images, brand names, an Apple trademark like the word \"iPhone\" in your icon) without a license.",
    fix: "Remove the specific flagged material, or if you have a license/permission, attach that proof directly to your App Review notes or Resolution Center reply. For Apple's own trademarks specifically, follow Apple's Trademark List guidelines rather than using product names/logos directly in your icon or marketing."
  },
  {
    guideline: "5.3",
    aliases: ["5\\.3(?!\\.\\d)\\b", "gambling", "lottery", "real.?money gaming"],
    title: "Legal — gaming, gambling, or lottery without proper licensing",
    keywords: ["gambling app", "real money", "lottery", "sweepstakes"],
    explain: "Your app involves real-money gaming, a lottery, or a sweepstakes, and Apple couldn't verify you hold the licensing required in every region the app is available.",
    fix: "Restrict availability to only the specific regions/states you're licensed in (App Store Connect supports per-territory availability), and be ready to provide proof of licensing in App Review notes, this is one of the most heavily scrutinized categories and rarely gets approved without documentation upfront."
  },
  {
    guideline: "5.4",
    aliases: ["5\\.4(?!\\.\\d)\\b", "vpn app", "network extension"],
    title: "Legal — VPN app missing required disclosures",
    keywords: ["vpn app", "network extension entitlement"],
    explain: "VPN apps get extra scrutiny on exactly what traffic they see and what they do with it, Apple wants this disclosed clearly, not just buried in a generic privacy policy.",
    fix: "State plainly, both in the app and your privacy policy, which data passes through the VPN, whether any of it is logged or shared with third parties, and confirm your entitlement request matches what the app actually does."
  },
  {
    guideline: "5.6",
    aliases: ["5\\.6(?!\\.\\d)\\b", "developer code of conduct", "abusive.*(app review|reviewer)"],
    title: "Legal — Developer Code of Conduct",
    keywords: ["developer code of conduct", "abusive toward app review"],
    explain: "This one isn't about your app's content, it's about conduct toward Apple or App Review staff (abusive Resolution Center messages, retaliatory reviews, gaming the review process itself).",
    fix: "There's no code fix here, if this was triggered by frustrated back-and-forth in the Resolution Center, a calm, specific, professional message addressing the actual technical rejection is the way through, not disputing the conduct flag itself."
  },
  {
    guideline: "—",
    aliases: ["xcode 26", "ios 26 sdk", "outdated sdk", "built with an older"],
    title: "Build requirement — app wasn't built with the current Xcode/SDK",
    keywords: ["xcode 26", "ios 26 sdk", "current xcode", "build with the latest"],
    explain: "Apple periodically requires new submissions to be built with a specific minimum Xcode and SDK version, independent of what iOS version your app actually supports at runtime.",
    fix: "Update the Xcode version your CI pipeline builds with (your app's deployment target/minimum supported iOS version can stay exactly the same, this is about the SDK used to build, not the OS versions you support), then rebuild and resubmit."
  },
  {
    guideline: "—",
    aliases: ["other app store review guideline issue", "binary rejected"],
    title: "Generic \"other guideline issue\" with no clear specifics",
    keywords: ["other app store review guideline", "we found the following issues"],
    explain: "This is Apple's most frustrating rejection type, a generic notice with little or no specific explanation attached.",
    fix: "Reply directly inside the Resolution Center thread in App Store Connect (not just email) asking the reviewer to clarify specifically what triggered it, this often gets a real answer within a day or two. You can also request a phone call with App Review from the same Resolution Center thread if the back-and-forth stalls."
  }
];

function scoreCategory(cat, textLower) {
  let score = 0;
  let aliasHit = false;
  for (const a of cat.aliases || []) {
    try {
      const re = new RegExp(a, "i");
      if (re.test(textLower)) {
        score += 10;
        aliasHit = true;
      }
    } catch (e) {
      // skip malformed pattern
    }
  }
  for (const k of cat.keywords || []) {
    if (textLower.indexOf(k.toLowerCase()) !== -1) score += 2;
  }
  return { score, aliasHit };
}

/** Returns the top 3 matching categories (score > 0), most likely first. */
function diagnoseRejection(text) {
  const input = text || "";
  const textLower = input.toLowerCase();

  if (!input.trim()) {
    return { matches: [], message: "Paste the rejection message first." };
  }

  const scored = CATEGORIES.map((cat) => {
    const s = scoreCategory(cat, textLower);
    return { cat, score: s.score, aliasHit: s.aliasHit };
  }).filter((r) => r.score > 0);

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 3);

  return {
    matches: top.map((r) => ({
      guideline: r.cat.guideline,
      title: r.cat.title,
      explain: r.cat.explain,
      fix: r.cat.fix,
    })),
    message:
      top.length === 0
        ? "No confident match — this may be a rare or newly-worded rejection type. Reply in the Resolution Center thread asking App Review to clarify."
        : top.length === 1
        ? "1 likely match:"
        : `${top.length} possible matches, most likely first:`,
  };
}

/**
 * Deterministic appeal / Resolution Center reply draft, keyed off a matched
 * category from diagnoseRejection(). This is intentionally template-based,
 * not generated text — every sentence traces back to a specific guideline
 * and the fix already shown to the buyer, so there's nothing here that
 * could be factually wrong in a way an LLM call could introduce, and it
 * costs nothing to run (no model call, no hosting, fits the same
 * zero-ongoing-cost architecture as the rest of Rejection Doctor).
 *
 * appName/bundleId/buildNumber are optional buyer-supplied fields to
 * personalize the draft; all fall back to a bracketed placeholder the
 * buyer fills in themselves if omitted.
 */
function generateAppealLetter(match, opts) {
  if (!match || !match.guideline || !match.title) {
    return { ok: false, error: "No matched category supplied." };
  }
  const o = opts || {};
  const appName = o.appName || "[app name]";
  const buildNumber = o.buildNumber || "[build number]";
  const fixSummary = o.fixSummary || match.fix;

  const isGeneric = match.guideline === "—";

  const body = isGeneric
    ? `Hello,\n\nThank you for reviewing ${appName}. The rejection notice for this submission (build ${buildNumber}) didn't include enough detail for us to identify the specific issue. Could you clarify exactly which screen, feature, or piece of metadata triggered this so we can address it directly? We're glad to provide any additional information or a demo walkthrough if that would help.\n\nThank you for your time.`
    : `Hello,\n\nThank you for reviewing ${appName}. We understand build ${buildNumber} was rejected under Guideline ${match.guideline} (${match.title}).\n\nHere's what we've done to address this: ${fixSummary}\n\nWe've made this change and resubmitted. Please let us know if any additional information would help with re-review, or if we've misunderstood the specific concern, we're glad to clarify further.\n\nThank you for your time.`;

  return {
    ok: true,
    guideline: match.guideline,
    subject: isGeneric
      ? `Re: App Review feedback for ${appName} (build ${buildNumber})`
      : `Re: Guideline ${match.guideline} feedback for ${appName} (build ${buildNumber})`,
    body,
    note: "Drafted for App Store Connect's Resolution Center — edit the specifics before sending, especially the fix summary, this only writes what's true if what you tell it is true."
  };
}

export { diagnoseRejection, generateAppealLetter, CATEGORIES };
