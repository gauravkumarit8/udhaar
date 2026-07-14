#!/bin/bash
# ============================================================
# Udhaar — Build & Deploy to Mobile (Capacitor)
# ============================================================
#
# Architecture: Capacitor loads the Next.js app from a HOSTED URL,
# not bundled static files. This is required because our app has
# server-side API routes (auth, loans, payments, etc.).
#
# Prerequisites:
#   1. Android Studio (for Android builds)
#   2. Xcode (for iOS, macOS only)
#   3. Node.js 18+
#   4. Your Next.js app deployed to a URL (e.g. Vercel)
#
# Quick Start:
#   chmod +x mobile-build.sh
#   ./mobile-build.sh setup          # First time: add platforms
#   ./mobile-build.sh android        # Open Android Studio
#   ./mobile-build.sh ios            # Open Xcode
#   ./mobile-build.sh dev            # Live reload on device
# ============================================================

set -e

PLATFORM=${1:-android}
APP_URL=${2:-""}

echo "📱 Udhaar Mobile Build — $PLATFORM"
echo "===================================="

case $PLATFORM in
  setup)
    echo "📦 Setting up Capacitor platforms..."
    
    if [ ! -d "android" ]; then
      echo "Adding Android platform..."
      npx cap add android
    fi
    
    if [ ! -d "ios" ]; then
      echo "Adding iOS platform..."
      npx cap add ios
    fi
    
    echo ""
    echo "✅ Platforms set up!"
    echo ""
    echo "⚠️  IMPORTANT: Edit capacitor.config.ts and set server.url"
    echo "   to your deployed Next.js app URL before building."
    echo ""
    echo "   For dev:  url: 'http://YOUR_LOCAL_IP:3000'"
    echo "   For prod: url: 'https://your-app.vercel.app'"
    ;;

  android)
    echo "📋 Copying web assets..."
    npx cap copy android 2>/dev/null || npx cap add android && npx cap copy android
    
    echo "🔧 Syncing native project..."
    npx cap sync android
    
    echo "🚀 Opening Android Studio..."
    npx cap open android
    
    echo ""
    echo "✅ Android project ready!"
    echo "   Build → Build Bundle(s) / APK(s) → Build APK(s)"
    echo "   APK: android/app/build/outputs/apk/debug/app-debug.apk"
    ;;

  ios)
    echo "📋 Copying web assets..."
    npx cap copy ios 2>/dev/null || npx cap add ios && npx cap copy ios
    
    echo "🔧 Syncing native project..."
    npx cap sync ios
    
    echo "🚀 Opening Xcode..."
    npx cap open ios
    
    echo ""
    echo "✅ iOS project ready!"
    echo "   Product → Archive → Distribute App"
    ;;

  dev)
    # Dev mode: runs Next.js locally and connects Capacitor to it
    echo "🌐 Starting dev server..."
    echo ""
    echo "⚠️  Make sure capacitor.config.ts has:"
    echo "   server: { url: 'http://YOUR_LOCAL_IP:3000' }"
    echo ""
    echo "Starting Next.js dev server..."
    npx cap run android --livereload --external 2>/dev/null || {
      echo "Falling back to manual mode..."
      echo "1. Run: npm run dev"
      echo "2. Find your local IP (e.g. 192.168.1.x)"
      echo "3. Set server.url in capacitor.config.ts"
      echo "4. Run: npx cap sync && npx cap run android"
    }
    ;;

  build-web)
    echo "📦 Building Next.js for deployment..."
    npm run build
    echo ""
    echo "✅ Built! Deploy the app to Vercel, then update"
    echo "   the server.url in capacitor.config.ts"
    ;;

  *)
    echo "Usage: ./mobile-build.sh [setup|android|ios|dev|build-web]"
    echo ""
    echo "Commands:"
    echo "  setup      — Add Android/iOS platforms (first time)"
    echo "  android    — Open Android Studio to build APK/AAB"
    echo "  ios        — Open Xcode to build IPA"
    echo "  dev        — Live reload on connected device"
    echo "  build-web  — Build Next.js for deployment"
    ;;
esac
