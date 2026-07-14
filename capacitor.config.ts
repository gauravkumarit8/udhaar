import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.udhaar.app',
  appName: 'Udhaar',
  webDir: 'out',
  server: {
    // ── For Capacitor mobile builds ──
    // In DEV: point to your local Next.js server
    // url: 'http://YOUR_LOCAL_IP:3000',
    //
    // In PRODUCTION: point to your deployed Next.js app
    // url: 'https://your-app.vercel.app',
    //
    // When `url` is set, Capacitor loads the web app from that URL
    // instead of bundled static files. This is required because our
    // Next.js app has server-side API routes that can't be static-exported.
    androidScheme: 'https',
  },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_icon',
      iconColor: '#059669',
      sound: 'default',
    },
    SplashScreen: {
      launchShowDuration: 2000,
      launchAutoHide: true,
      backgroundColor: '#064e3b',
      showSpinner: false,
      androidScaleType: 'CENTER_CROP',
      androidSplashResourceName: 'splash',
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#064e3b',
    },
    Camera: {
      presentationStyle: 'fullscreen',
    },
  },
  android: {
    backgroundColor: '#064e3b',
    allowMixedContent: false,
  },
  ios: {
    contentInset: 'automatic',
  },
};

export default config;
