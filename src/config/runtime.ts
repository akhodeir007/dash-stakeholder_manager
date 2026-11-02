export const runtimeDefaults = Object.freeze({
  status: "scaffold" as const,
  workflowReady: false as const,
  integrations: Object.freeze({
    mepsWriteback: false as const,
    hostedDocumentProcessing: false as const,
    drexMode: "OFF" as const,
  }),
});

export type RuntimeDefaults = typeof runtimeDefaults;
