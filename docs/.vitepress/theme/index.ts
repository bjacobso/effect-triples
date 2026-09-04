import "@fontsource-variable/ibm-plex-sans";
import "@fontsource/ibm-plex-mono/400.css";
import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme-without-fonts";

import "./custom.css";

export default {
  extends: DefaultTheme,
} satisfies Theme;
