import { resolve } from "node:path";

import { defineConfig } from "vitepress";

export default defineConfig({
  lang: "en-US",
  title: "Triplex",
  titleTemplate: ":title · Triplex",
  description:
    "An Effect-native fact database with Datalog and typed, content-addressed configuration.",
  cleanUrls: true,
  lastUpdated: true,
  outDir: resolve(import.meta.dirname, "../../dist"),
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/mark.svg" }],
    ["meta", { name: "theme-color", content: "#0b1020" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "Triplex" }],
  ],
  markdown: {
    theme: { light: "github-light", dark: "tokyo-night" },
    languages: ["js", "json", "sh", "sql", "ts"],
  },
  themeConfig: {
    logo: { src: "/mark.svg", alt: "Triplex" },
    siteTitle: "Triplex",
    nav: [
      { text: "Configuration", link: "/configuration" },
      { text: "Datalog", link: "/datalog" },
      { text: "Derivations", link: "/derivations" },
      { text: "Current state", link: "/current-state" },
    ],
    sidebar: [
      {
        text: "Start",
        items: [
          { text: "Current state", link: "/current-state" },
          {
            text: "Architecture",
            link: "https://github.com/bjacobso/triplex/blob/main/ARCHITECTURE.md",
          },
        ],
      },
      {
        text: "Core",
        items: [
          { text: "Datalog", link: "/datalog" },
          { text: "Configuration", link: "/configuration" },
          { text: "Derivations", link: "/derivations" },
          { text: "Provenance", link: "/provenance" },
        ],
      },
      {
        text: "Operate",
        items: [
          { text: "Operational primitives", link: "/operational-primitives" },
          { text: "Host integration", link: "/onboarded-foundation" },
          { text: "Releasing", link: "/releasing" },
          { text: "Roadmap", link: "/roadmap" },
        ],
      },
    ],
    search: {
      provider: "local",
      options: { detailedView: true },
    },
    outline: { level: [2, 3], label: "On this page" },
    socialLinks: [{ icon: "github", link: "https://github.com/bjacobso/triplex" }],
    editLink: {
      pattern: "https://github.com/bjacobso/triplex/edit/main/docs/:path",
      text: "Edit this page",
    },
    lastUpdated: { text: "Last updated" },
    docFooter: { prev: "Previous", next: "Continue" },
    externalLinkIcon: true,
    footer: {
      message: "Released under the MIT License.",
      copyright: "© 2026 Ben Jacobson",
    },
  },
});
