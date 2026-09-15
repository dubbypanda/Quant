// Ambient declarations for the static assets esbuild inlines as data URLs
// (see the `loader` map in scripts/build.mjs). Without these, `tsc --noEmit`
// fails on every asset import even though the bundle resolves them fine.

declare module '*.png' {
  const url: string;
  export default url;
}

declare module '*.svg' {
  const url: string;
  export default url;
}
