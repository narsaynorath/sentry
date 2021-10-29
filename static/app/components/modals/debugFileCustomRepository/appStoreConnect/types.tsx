export type AppStoreApp = {
  name: string;
  appId: string;
  bundleId: string;
};
export type StepOneData = {
  issuer?: string;
  keyId?: string;
  privateKey?: string;
};

export type StepTwoData = {
  app?: AppStoreApp;
};
