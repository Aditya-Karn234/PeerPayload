const { createApiClient } = require("client-core/apiClient");
const { createFileTokenStore } = require("client-core/tokenStore");
const config = require("./config");

const tokenStore = createFileTokenStore();
const api = createApiClient({ baseUrl: config.serverUrl, tokenStore });

module.exports = { api, tokenStore };
