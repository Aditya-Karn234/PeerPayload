module.exports = {
  ...require("./identity"),
  ...require("./envelope"),
  ...require("./pairing"),
  ...require("./contacts"),
  ...require("./mailboxClient"),
  ...require("./transfers"),
  ...require("./node"),
  parseMessage: require("peerpayload-protocol").parseMessage,
  makeMessage: require("peerpayload-protocol").makeMessage,
};
