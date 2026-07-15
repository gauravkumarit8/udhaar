import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.udhaar.app',
  appName: 'Udhaar',
  webDir: 'public',
  server: {
    url: 'https://udhaar-y94f.onrender.com',
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
