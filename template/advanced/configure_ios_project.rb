#!/usr/bin/env ruby
# frozen_string_literal: true
#
# Runs in CI, after `npx cap add ios` has generated ios/App/App.xcodeproj
# from Capacitor's own template. Does everything you'd otherwise click
# through in Xcode by hand:
#
#   1. Adds your custom native Swift file(s) to the main App target.
#   2. Creates a Share Extension target (if you have one), adds its
#      files, and embeds it into the main app.
#   3. Turns on an App Group entitlement on both targets, so they can
#      hand data to each other.
#   4. Turns on a Background Modes capability on the main app, if needed.
#
# Requires the `xcodeproj` gem, which you install with a `gem install
# xcodeproj --no-document` step right before this one — see ADVANCED.md.
#
# This is scripted best-effort against Capacitor's documented project
# layout. If a specific `xcodeproj` gem call errors out in your CI run
# (project structure can shift between Capacitor versions), the error is
# usually specific enough to patch directly.

require 'xcodeproj'
require 'fileutils'

ROOT = File.expand_path('..', __dir__)
PROJECT_PATH = File.join(ROOT, 'ios/App/App.xcodeproj')

# ---- Fill these in for your app ----
APP_GROUP_ID = 'group.YOUR_BUNDLE_ID'          # e.g. group.com.yourname.yourapp
BUNDLE_ID_APP = 'YOUR_BUNDLE_ID'               # e.g. com.yourname.yourapp
BUNDLE_ID_SHARE = 'YOUR_BUNDLE_ID.share'       # only used if you have a Share Extension
SHARE_TARGET_NAME = 'YourAppShare'             # only used if you have a Share Extension
NATIVE_PLUGIN_FILES = %w[]                     # e.g. %w[YourNativePlugin.swift]
NATIVE_PLUGIN_SOURCE_DIR = File.join(ROOT, 'ios-plugin')
HAS_SHARE_EXTENSION = false                    # set true if you're adding one
ENABLE_BACKGROUND_AUDIO = false                # set true if your app needs background audio
# -------------------------------------

APPLE_TEAM_ID = ENV.fetch('APPLE_TEAM_ID', '')
PROVISIONING_PROFILE_NAME_APP = ENV.fetch('IOS_PROVISIONING_PROFILE_NAME', 'YourApp App Store')
PROVISIONING_PROFILE_NAME_SHARE = ENV.fetch('IOS_SHARE_PROVISIONING_PROFILE_NAME', 'YourApp Share App Store')
# App Store Connect silently rejects re-uploads that reuse the same
# marketing version + build number pair (the upload step still reports
# success either way, which is why this can look fine in the CI log while
# the build never actually shows up in TestFlight). Using the CI run
# number here guarantees every push produces an installable build.
BUILD_NUMBER = ENV.fetch('BUILD_NUMBER', '1')

abort "Xcode project not found at #{PROJECT_PATH} — run `npx cap add ios` first." unless File.exist?(PROJECT_PATH)

project = Xcodeproj::Project.open(PROJECT_PATH)
app_target = project.targets.find { |t| t.name == 'App' }
abort 'Could not find the "App" target — Capacitor template may have changed.' unless app_target

app_src_dir = File.join(ROOT, 'ios/App/App')
FileUtils.mkdir_p(app_src_dir)

# ---------------------------------------------------------------------------
# 1. Copy in + reference your native Swift file(s) on the main target
# ---------------------------------------------------------------------------
NATIVE_PLUGIN_FILES.each do |fname|
  src = File.join(NATIVE_PLUGIN_SOURCE_DIR, fname)
  dst = File.join(app_src_dir, fname)
  FileUtils.cp(src, dst)
  file_ref = project.main_group.new_file(dst)
  app_target.add_file_references([file_ref])
  puts "Added #{fname} to App target"
end

# ---------------------------------------------------------------------------
# 2. App Group entitlement + optional Background Audio mode on the main app
# ---------------------------------------------------------------------------
app_entitlements_path = File.join(app_src_dir, 'App.entitlements')
File.write(app_entitlements_path, <<~PLIST)
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0">
  <dict>
      <key>com.apple.security.application-groups</key>
      <array>
          <string>#{APP_GROUP_ID}</string>
      </array>
  </dict>
  </plist>
PLIST

app_target.build_configurations.each do |config|
  config.build_settings['CODE_SIGN_ENTITLEMENTS'] = 'App/App.entitlements'
  config.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = BUNDLE_ID_APP
  config.build_settings['CODE_SIGN_STYLE'] = 'Manual'
  config.build_settings['CODE_SIGN_IDENTITY'] = 'Apple Distribution'
  config.build_settings['DEVELOPMENT_TEAM'] = APPLE_TEAM_ID
  config.build_settings['PROVISIONING_PROFILE_SPECIFIER'] = PROVISIONING_PROFILE_NAME_APP
  config.build_settings['CURRENT_PROJECT_VERSION'] = BUILD_NUMBER
end

if ENABLE_BACKGROUND_AUDIO
  info_plist_path = File.join(app_src_dir, 'Info.plist')
  if File.exist?(info_plist_path)
    plist = Xcodeproj::Plist.read_from_path(info_plist_path)
    plist['UIBackgroundModes'] = ['audio']
    Xcodeproj::Plist.write_to_path(plist, info_plist_path)
    puts 'Enabled Background Audio mode on Info.plist'
  else
    warn "Warning: #{info_plist_path} not found — set UIBackgroundModes manually if this script's Info.plist path guess was wrong."
  end
end

# ---------------------------------------------------------------------------
# 3. Create the Share Extension target, if you have one
# ---------------------------------------------------------------------------
if HAS_SHARE_EXTENSION
  share_dir = File.join(ROOT, "ios/App/#{SHARE_TARGET_NAME}")
  FileUtils.mkdir_p(share_dir)
  FileUtils.cp(File.join(ROOT, 'ios-share-extension/ShareViewController.swift'), File.join(share_dir, 'ShareViewController.swift'))
  FileUtils.cp(File.join(ROOT, 'ios-share-extension/Info.plist'), File.join(share_dir, 'Info.plist'))

  share_entitlements_path = File.join(share_dir, "#{SHARE_TARGET_NAME}.entitlements")
  File.write(share_entitlements_path, <<~PLIST)
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
        <key>com.apple.security.application-groups</key>
        <array>
            <string>#{APP_GROUP_ID}</string>
        </array>
    </dict>
    </plist>
  PLIST

  share_target = project.new_target(:app_extension, SHARE_TARGET_NAME, :ios, '14.0')

  share_file_refs = project.main_group.new_file(File.join(share_dir, 'ShareViewController.swift'))
  share_target.add_file_references([share_file_refs])

  share_target.build_configurations.each do |config|
    config.build_settings['PRODUCT_NAME'] = SHARE_TARGET_NAME
    config.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] = BUNDLE_ID_SHARE
    config.build_settings['INFOPLIST_FILE'] = "#{SHARE_TARGET_NAME}/Info.plist"
    config.build_settings['CODE_SIGN_ENTITLEMENTS'] = "#{SHARE_TARGET_NAME}/#{SHARE_TARGET_NAME}.entitlements"
    config.build_settings['SWIFT_VERSION'] = '5.0'
    config.build_settings['TARGETED_DEVICE_FAMILY'] = '1,2'
    config.build_settings['CODE_SIGN_STYLE'] = 'Manual'
    config.build_settings['CODE_SIGN_IDENTITY'] = 'Apple Distribution'
    config.build_settings['DEVELOPMENT_TEAM'] = APPLE_TEAM_ID
    config.build_settings['PROVISIONING_PROFILE_SPECIFIER'] = PROVISIONING_PROFILE_NAME_SHARE
    config.build_settings['CURRENT_PROJECT_VERSION'] = BUILD_NUMBER
  end

  # Also record manual signing + team in the project's TargetAttributes,
  # which is where Xcode itself (and some xcodebuild paths) look for
  # provisioning style — belt and suspenders alongside the build settings.
  project.root_object.attributes['TargetAttributes'] ||= {}
  [app_target, share_target].each do |t|
    project.root_object.attributes['TargetAttributes'][t.uuid] ||= {}
    project.root_object.attributes['TargetAttributes'][t.uuid]['ProvisioningStyle'] = 'Manual'
    project.root_object.attributes['TargetAttributes'][t.uuid]['DevelopmentTeam'] = APPLE_TEAM_ID
  end

  # Embed the extension into the main app (Xcode's "Embed App Extensions"
  # copy-files build phase) and wire up the target dependency.
  app_target.add_dependency(share_target)

  embed_phase = app_target.copy_files_build_phases.find { |p| p.name == 'Embed App Extensions' }
  embed_phase ||= app_target.new_copy_files_build_phase('Embed App Extensions')
  embed_phase.symbol_dst_subfolder_spec = :plug_ins
  embed_phase.add_file_reference(share_target.product_reference, true)
  build_file = embed_phase.files_references.include?(share_target.product_reference) &&
               embed_phase.files.find { |f| f.file_ref == share_target.product_reference }
  build_file.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] } if build_file

  puts "Share extension target '#{SHARE_TARGET_NAME}' created and embedded."
end

project.save
puts "\nDone."
puts 'If any step above warned or looks off once you inspect the build log, that is the part worth double-checking first.'
