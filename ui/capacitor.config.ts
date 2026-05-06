import { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.centeridentity.cacareerpassport",
  appName: "CA Career Passport",
  webDir: "../dist",
  // Point to your YadaCoin node for live dev (change to production URL for release)
  server: {
    // Uncomment for live reload during development:
    // url: "http://192.168.1.120:8005/wallet",
    // cleartext: true,
    hostname: "wallet.yadacoin.io",
    androidScheme: "https",
  },
  ios: {
    contentInset: "automatic",
    backgroundColor: "#ffffff",
  },
  android: {
    backgroundColor: "#ffffff",
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      backgroundColor: "#1a1a2e",
      androidSplashResourceName: "splash",
      showSpinner: false,
    },
    StatusBar: {
      style: "dark",
      backgroundColor: "#1a1a2e",
    },
  },
};

export default config;
