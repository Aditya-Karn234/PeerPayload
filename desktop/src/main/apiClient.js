import { createApiClient } from "client-core/apiClient";
import { createElectronTokenStore } from "./tokenStore";
import config from "./config";

// Created lazily (createElectronTokenStore touches Electron's app/
// safeStorage modules, which aren't ready until after app.whenReady()).
let instance = null;
let tokenStoreInstance = null;

export function getApiClient() {
  if (!instance) {
    tokenStoreInstance = createElectronTokenStore();
    instance = createApiClient({ baseUrl: config.serverUrl, tokenStore: tokenStoreInstance });
  }

  return instance;
}

export function getTokenStore() {
  getApiClient(); // ensures tokenStoreInstance is initialized
  return tokenStoreInstance;
}
