# 📱 Udhaar — Mobile App (Capacitor + Next.js)

Udhaar is a loan tracking app for India — **Splitwise + EMI Tracker + Auto Reminders**.
Built with Next.js and wrapped in Capacitor for native iOS/Android deployment.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────┐
│          Native Shell               │
│  (Capacitor — iOS/Android)          │
│                                     │
│  ┌───────────────────────────────┐  │
│  │     Next.js Web App           │  │
│  │  (React + Tailwind + PWA)    │  │
│  │                               │  │
│  │  ┌─────────┐  ┌───────────┐  │  │
│  │  │ Pages   │  │ API Routes│  │  │
│  │  │ (SSR)   │  │ (Server)  │  │  │
│  │  └─────────┘  └───────────┘  │  │
│  └───────────────────────────────┘  │
│                                     │
│  Native Plugins:                    │
│  • Local Notifications              │
│  • Camera (proof upload)            │
│  • Haptics                          │
│  • Share (WhatsApp/SMS)             │
│  • Network status                   │
│  • Status Bar                       │
│  • Splash Screen                    │
└─────────────────────────────────────┘
         │
         ▼
   ┌───────────┐
   │ PostgreSQL │
   │   (Drizzle)│
   └───────────┘
```

---

## 📲 Building the Mobile App

### Prerequisites
- **Node.js** 18+
- **Android Studio** (for Android)
- **Xcode 14+** (for iOS, macOS only)
- **Java JDK 17+**

### Option A: One-Command Build
```bash
chmod +x mobile-build.sh

# Android
./mobile-build.sh android

# iOS
./mobile-build.sh ios

# Dev with live reload
./mobile-build.sh dev
```

### Option B: Manual Steps

#### 1. Build the web app
```bash
npm run build
```

#### 2. Add native platforms (first time only)
```bash
npx cap add android
npx cap add ios
```

#### 3. Copy web assets to native project
```bash
npx cap copy
```

#### 4. Open native IDE
```bash
# Android → opens Android Studio
npx cap open android

# iOS → opens Xcode
npx cap open ios
```

#### 5. Build in native IDE
- **Android Studio**: Build → Build Bundle(s) / APK(s) → Build APK(s)
  - Output: `android/app/build/outputs/apk/debug/app-debug.apk`
- **Xcode**: Product → Archive → Distribute App

---

## 🔔 Native Features

| Feature | Implementation | Fallback |
|---------|---------------|----------|
| **Smart Reminders** | Capacitor LocalNotifications | Browser Notification API |
| **Camera** | Capacitor Camera API | File input picker |
| **Haptics** | Capacitor Haptics | No-op |
| **Share** | Capacitor Share | Web Share API / Clipboard |
| **Offline Detection** | Capacitor Network | Navigator.onLine |
| **Status Bar** | Capacitor StatusBar | CSS safe-area-inset |
| **Splash Screen** | Capacitor SplashScreen | CSS loading screen |
| **App Resume** | Capacitor App lifecycle | VisibilityChange API |

---

## 📁 Project Structure

```
src/
├── app/                    # Next.js App Router pages
│   ├── login/              # Mobile OTP login
│   ├── dashboard/          # Home with summary cards
│   ├── loans/
│   │   ├── new/            # 3-step add loan wizard
│   │   └── [id]/           # Loan detail with EMI timeline
│   ├── activity/           # Reminders & overdue alerts
│   ├── profile/            # Settings & notification prefs
│   └── api/                # Server-side API routes
│       ├── auth/           # OTP login flow
│       ├── loans/          # CRUD + auto-close
│       ├── installments/   # Pay + remind
│       ├── payments/       # Confirm/reject
│       └── dashboard/      # Aggregated summary
├── components/
│   ├── BottomNav.tsx       # Native-style tab bar
│   ├── BottomSheet.tsx     # Swipe-to-dismiss sheets
│   ├── MobileShell.tsx     # App wrapper + offline banner
│   ├── ProofUpload.tsx     # Camera/gallery for payment proof
│   ├── ShareButton.tsx     # WhatsApp/SMS invite
│   └── OfflineBanner.tsx   # Network status banner
├── hooks/
│   └── useNative.ts        # React hooks for Capacitor plugins
├── lib/
│   ├── auth.ts             # Cookie-based session auth
│   ├── calculations.ts     # EMI + interest calculations
│   └── native.ts           # Capacitor bridge with web fallbacks
└── db/
    ├── schema.ts           # Drizzle ORM tables
    └── index.ts            # PostgreSQL connection

capacitor.config.ts         # Capacitor native config
mobile-build.sh             # One-command build script
```

---

## 🚀 Deployment

### Google Play Store
1. Build signed AAB: `./gradlew bundleRelease`
2. Create developer account at https://play.google.com/console
3. Upload AAB → fill store listing → publish

### Apple App Store
1. Archive in Xcode → Distribute App
2. Upload to App Store Connect
3. Submit for review

### Web (PWA)
1. Deploy to Vercel/Netlify
2. PWA is auto-installable from browser
3. Works offline with service worker
