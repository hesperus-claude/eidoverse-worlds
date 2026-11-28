// test/stubs/net-leaf-stub.mjs — net.js as breadcrumbs.js sees it (it reads net.ws only), so a suite can load the REAL
// frameloop.js without the whole client (net.js pulls in ui modules that touch `document` at load). governor-refresh-test.
export const net = {};
