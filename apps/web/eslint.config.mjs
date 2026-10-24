import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // uPlot throws at module load for a POSIX locale tag (en-US@posix); our
  // wrapper normalises navigator.language first. Everything goes through it.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/uplot/**"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{ name: "uplot", message: "Import uPlot from '@/lib/uplot' (locale guard)." }],
      }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
