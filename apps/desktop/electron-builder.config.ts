import type { Configuration } from "electron-builder";

const requireCodeSigning = process.env.DESKTOP_REQUIRE_CODE_SIGNING === "true";

const config: Configuration = {
  appId: "dev.selftune.desktop",
  productName: "SelfTune",
  executableName: "selftune",
  artifactName: "selftune-desktop-${os}-${arch}.${ext}",
  forceCodeSigning: requireCodeSigning,
  directories: { output: "dist", buildResources: "build" },
  files: ["out/**/*", "package.json"],
  extraResources: [{ from: "resources/selftune", to: "selftune", filter: ["**/*"] }],
  mac: {
    category: "public.app-category.developer-tools",
    icon: "build/icon.icns",
    target: ["dmg", "zip"],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    notarize: true,
  },
  win: { icon: "build/icon.ico", target: ["nsis"] },
  nsis: { oneClick: true, perMachine: false },
  linux: { category: "Development", icon: "build/icon.png", target: ["AppImage", "deb"] },
};

export default config;
