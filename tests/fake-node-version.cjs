// Preloaded with NODE_OPTIONS=--require <this file>: makes process.versions.node say FAKE_NODE_VERSION,
// so a test of install.sh's Node check does not depend on the Node the host happens to have. Set to
// the empty string, it says ''; unset, the real version stays. `node --version` is not affected.
const v = process.env.FAKE_NODE_VERSION;
if (v !== undefined) Object.defineProperty(process.versions, 'node', { value: v, enumerable: true, configurable: true });
