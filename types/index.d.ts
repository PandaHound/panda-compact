/** The context fill the last response reported, 0-100; null before one. */
export type Fill = number | null;

declare module 'claude-code' {
  interface PluginState {
    'panda-compact': {
      /** The context fill the last response reported, 0-100; null before one. */
      percent: Fill;
      /** True while a compaction started from the pane runs. */
      isBusy: boolean;
    };
  }
}
