import type { Config } from "tailwindcss";

/**
 * Level One Design System — carried over verbatim from the Level One
 * Proposal Engine so both apps read as one product: a warm off-white canvas,
 * near-black typography, and muted neutral borders. No accent color.
 *
 * Every color resolves through a CSS custom property declared in
 * app/globals.css, so re-theming the whole system is a single-file edit.
 */
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "rgb(var(--color-canvas) / <alpha-value>)",
        surface: "rgb(var(--color-surface) / <alpha-value>)",
        cream: "rgb(var(--color-canvas) / <alpha-value>)",
        // NOTE: never name a color "base" here — it would shadow Tailwind's
        // `text-base` font-size utility and compile it to `color: white`.
        canvas: {
          DEFAULT: "rgb(var(--color-canvas) / <alpha-value>)",
          deep: "rgb(var(--color-canvas-deep) / <alpha-value>)",
        },
        ink: {
          DEFAULT: "rgb(var(--color-ink) / <alpha-value>)",
          soft: "rgb(var(--color-ink) / <alpha-value>)",
        },
        foreground: "rgb(var(--color-ink) / <alpha-value>)",
        muted: "rgb(var(--color-muted) / <alpha-value>)",
        line: "rgb(var(--color-line) / <alpha-value>)",
        // Status accents. Deliberately desaturated so a board full of badges
        // still reads as the same neutral system.
        positive: "rgb(var(--color-positive) / <alpha-value>)",
        negative: "rgb(var(--color-negative) / <alpha-value>)",
        pending: "rgb(var(--color-pending) / <alpha-value>)",
      },
      fontFamily: {
        display: ["var(--font-display)", "Georgia", "serif"],
      },
      fontSize: {
        // Fluid typography — scales cleanly from Galaxy Fold cover
        // screens (~280px) up to wide desktop without breakpoint jumps.
        "fluid-xs": "clamp(0.7rem, 0.65rem + 0.25vw, 0.8rem)",
        "fluid-sm": "clamp(0.8rem, 0.74rem + 0.3vw, 0.925rem)",
        "fluid-base": "clamp(0.925rem, 0.85rem + 0.4vw, 1.0625rem)",
        "fluid-lg": "clamp(1.05rem, 0.95rem + 0.55vw, 1.3rem)",
        "fluid-xl": "clamp(1.3rem, 1.1rem + 1vw, 1.75rem)",
        "fluid-2xl": "clamp(1.6rem, 1.3rem + 1.6vw, 2.4rem)",
        "fluid-3xl": "clamp(1.9rem, 1.5rem + 2.2vw, 3.1rem)",
      },
      screens: {
        // Galaxy Fold cover screen and other ultra-narrow devices
        fold: "280px",
        xs: "400px",
      },
      boxShadow: {
        card: "0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 6px -1px rgb(15 23 42 / 0.06)",
        lift: "0 4px 6px -1px rgb(15 23 42 / 0.07), 0 10px 24px -6px rgb(15 23 42 / 0.10)",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.35s cubic-bezier(0.22, 1, 0.36, 1) both",
      },
    },
  },
  plugins: [],
};

export default config;
