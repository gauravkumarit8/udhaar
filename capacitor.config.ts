import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.udhaar.app',
  appName: 'Udhaar',
  webDir: 'public',
  // The app deliberately loads the hosted web app rather than a bundled copy
  // (see README → Mobile: a remote shell). Two consequences are handled here:
  // https for the WebView, and a local page to show when the hosted app cannot
  // be reached at all - without `errorPath` that is a blank screen, and the
  // free Render instance can be asleep for half a minute on a cold start.
  server: {
    url: 'https://udhaar-y94f.onrender.com',
    androidScheme: 'https',
    errorPath: 'offline.html',
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
