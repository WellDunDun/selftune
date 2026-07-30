import {
  createDesktopBuilderConfig,
  readDesktopBuilderEnvironment,
} from "./desktop-builder-config";

const config = createDesktopBuilderConfig(
  readDesktopBuilderEnvironment(process.env),
  process.platform,
);
export default config;
